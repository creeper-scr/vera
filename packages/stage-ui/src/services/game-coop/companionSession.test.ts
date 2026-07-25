import type {
  CompanionAgentModelPort,
  VoiceTurn,
} from '@proj-vera/core-agent'
import type {
  GameActionEvent,
  GameActionEventListener,
  GameCapability,
  GameCommand,
  GameExecutionPort,
  GameObservation,
  GameObservationListener,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import { describe, expect, it, vi } from 'vitest'

import { createCompanionSession } from './companionSession'

const lookCapability = capability('minecraft.look', 'low', {
  playerName: { type: 'string', minLength: 1 },
}, ['playerName'])

describe('companionSession', () => {
  it('runs a voice turn through tool execution to completion', async () => {
    const port = new FakeExecutionPort([lookCapability])
    port.executeHandler = async (command) => {
      queueMicrotask(() => {
        port.emit({ ...eventBase(command), state: 'queued' })
        port.emit({
          ...eventBase(command),
          timestamp: 101,
          state: 'succeeded',
          result: { reached: true },
        })
      })
    }

    let calls = 0
    const model: CompanionAgentModelPort = {
      async stream(request) {
        calls += 1
        const tool = request.tools[0]!
        await tool.execute({ playerName: 'Steve' }, { messages: request.messages, toolCallId: 'call-1' })
        return { assistantText: '看向 Steve 了' }
      },
    }

    const session = createCompanionSession({
      executionPort: port,
      model,
      sessionId: 'session-1',
      now: () => 1000,
    })

    const turn = voiceTurn('session-1', 'turn-1', '看向 Steve')
    const result = await session.ingestVoiceTurn(turn)

    expect(result.status).toBe('completed')
    expect(result.toolNames).toEqual(['minecraft_look'])
    expect(result.assistantText).toBe('看向 Steve 了')
    expect(port.commands).toHaveLength(1)
    expect(port.commands[0]).toMatchObject({
      sessionId: 'session-1',
      turnId: 'turn-1',
      capabilityId: 'minecraft.look',
      input: { playerName: 'Steve' },
    })
    expect(calls).toBe(1)
    await session.dispose()
  })

  it('auto-ingests observeWorld emissions as companion observations', async () => {
    const port = new FakeExecutionPort([lookCapability])
    const stream = vi.fn(async () => ({ assistantText: '嗯' }))
    const model: CompanionAgentModelPort = { stream }

    const session = createCompanionSession({
      executionPort: port,
      model,
      sessionId: 'session-1',
      now: () => 1000,
      shouldReactToObservation: () => true,
    })

    session.startWorldObservations()
    expect(port.worldListenerCount('session-1')).toBe(1)

    port.emitWorld({
      sessionId: 'session-1',
      eventId: 'evt-1',
      adapterId: 'minecraft',
      observedAt: 900,
      kind: 'hurt',
      urgency: 'high',
      text: '玩家受伤',
    })

    await vi.waitFor(() => {
      expect(stream).toHaveBeenCalled()
    })

    session.stopWorldObservations()
    expect(port.worldListenerCount('session-1')).toBe(0)
    await session.dispose()
  })

  it('dispose clears world observers and ignores later ingests', async () => {
    const port = new FakeExecutionPort([lookCapability])
    const model: CompanionAgentModelPort = {
      async stream() {
        return {}
      },
    }

    const session = createCompanionSession({
      executionPort: port,
      model,
      sessionId: 'session-1',
      now: () => 1000,
    })

    session.startWorldObservations()
    expect(port.worldListenerCount('session-1')).toBe(1)

    await session.dispose()
    expect(port.worldListenerCount('session-1')).toBe(0)
    expect(port.listenerCount('session-1')).toBe(0)

    const result = await session.ingestVoiceTurn(voiceTurn('session-1', 'turn-2', '你好'))
    expect(result).toEqual({ status: 'ignored', reason: 'disposed', steps: 0, toolNames: [], toolSteps: [] })

    const obs = await session.ingestObservation({
      sessionId: 'session-1',
      eventId: 'evt-2',
      kind: 'hurt',
      urgency: 'low',
      text: 'x',
      observedAt: 950,
    })
    expect(obs).toEqual({ status: 'ignored', reason: 'disposed', steps: 0, toolNames: [], toolSteps: [] })
  })

  it('invokes onTurnResult and onPhaseChange hooks', async () => {
    const port = new FakeExecutionPort([lookCapability])
    const model: CompanionAgentModelPort = {
      async stream() {
        return { assistantText: 'ok' }
      },
    }

    const onTurnResult = vi.fn()
    const phases: string[] = []
    const session = createCompanionSession({
      executionPort: port,
      model,
      sessionId: 'session-1',
      now: () => 1000,
      onTurnResult,
      onPhaseChange: phase => phases.push(phase),
    })

    const turn = voiceTurn('session-1', 'turn-1', 'hi')
    const result = await session.ingestVoiceTurn(turn)

    expect(onTurnResult).toHaveBeenCalledWith(result, turn)
    expect(phases.length).toBeGreaterThanOrEqual(2)
    expect(phases.at(-1)).toBe('idle')
    await session.dispose()
  })

  it('projects medium companion tools when allowedRisks includes medium', async () => {
    const collect = capability('minecraft.collect', 'medium', {
      target: { type: 'string' },
    }, ['target'], true)
    const craft = capability('minecraft.craft', 'medium', {
      itemName: { type: 'string' },
    }, ['itemName'], true)
    const port = new FakeExecutionPort([lookCapability, collect, craft])
    port.executeHandler = async (command) => {
      queueMicrotask(() => {
        port.emit({ ...eventBase(command), state: 'queued' })
        port.emit({
          ...eventBase(command),
          timestamp: 101,
          state: 'succeeded',
          result: { crafted: true },
        })
      })
    }

    const model: CompanionAgentModelPort = {
      async stream(request) {
        const toolNames = request.tools.map(tool => tool.function.name)
        expect(toolNames).toContain('minecraft_collect')
        expect(toolNames).toContain('minecraft_craft')
        expect(toolNames).toContain('minecraft_look')
        const craftTool = request.tools.find(tool => tool.function.name === 'minecraft_craft')
        await craftTool!.execute(
          { itemName: 'stick' },
          { messages: request.messages, toolCallId: 'craft-call-1' },
        )
        return { assistantText: '合成好了' }
      },
    }

    const session = createCompanionSession({
      executionPort: port,
      model,
      sessionId: 'session-1',
      now: () => 1000,
      allowedRisks: ['low', 'medium'],
    })

    const result = await session.ingestVoiceTurn(voiceTurn('session-1', 'turn-craft', '合成木棍'))

    expect(result.status).toBe('completed')
    expect(result.toolNames).toEqual(['minecraft_craft'])
    expect(port.commands[0]).toMatchObject({
      capabilityId: 'minecraft.craft',
      input: { itemName: 'stick' },
    })
    await session.dispose()
  })

  it('keeps medium tools hidden when allowedRisks stays at default low', async () => {
    const collect = capability('minecraft.collect', 'medium', {
      target: { type: 'string' },
    }, ['target'], true)
    const port = new FakeExecutionPort([lookCapability, collect])
    const seenToolNames: string[] = []
    const model: CompanionAgentModelPort = {
      async stream(request) {
        seenToolNames.push(...request.tools.map(tool => tool.function.name))
        return { assistantText: '先不采' }
      },
    }

    const session = createCompanionSession({
      executionPort: port,
      model,
      sessionId: 'session-1',
      now: () => 1000,
    })

    await session.ingestVoiceTurn(voiceTurn('session-1', 'turn-1', '砍树'))

    expect(seenToolNames).toEqual(['minecraft_look'])
    expect(seenToolNames).not.toContain('minecraft_collect')
    await session.dispose()
  })
})

class FakeExecutionPort implements GameExecutionPort {
  public readonly commands: GameCommand[] = []
  public executeHandler?: (command: GameCommand) => Promise<void>
  public readonly cancel = vi.fn(async () => {})
  public getEnvironment?: GameExecutionPort['getEnvironment']
  private readonly listeners = new Map<string, Set<GameActionEventListener>>()
  private readonly worldListeners = new Map<string, Set<GameObservationListener>>()

  constructor(private readonly capabilities: GameCapability[]) {
    // Default fresh snapshot; tests can override via this.getEnvironment.
    this.getEnvironment = async sessionId => ({
      sessionId,
      adapterId: 'fake',
      observedAt: 1000,
      freshnessMs: 60_000,
      revision: 'r1',
      content: { available: true },
    })
  }

  public async getCapabilities(): Promise<GameCapability[]> {
    return this.capabilities
  }

  public observe(sessionId: string, listener: GameActionEventListener): Unsubscribe {
    const listeners = this.listeners.get(sessionId) ?? new Set<GameActionEventListener>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0)
        this.listeners.delete(sessionId)
    }
  }

  public observeWorld(sessionId: string, listener: GameObservationListener): Unsubscribe {
    const listeners = this.worldListeners.get(sessionId) ?? new Set<GameObservationListener>()
    listeners.add(listener)
    this.worldListeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0)
        this.worldListeners.delete(sessionId)
    }
  }

  public async execute(command: GameCommand): Promise<void> {
    this.commands.push(command)
    await this.executeHandler?.(command)
  }

  public emit(event: GameActionEvent): void {
    for (const listener of this.listeners.get(event.sessionId) ?? [])
      listener(event)
  }

  public emitWorld(observation: GameObservation): void {
    for (const listener of this.worldListeners.get(observation.sessionId) ?? [])
      listener(observation)
  }

  public listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0
  }

  public worldListenerCount(sessionId: string): number {
    return this.worldListeners.get(sessionId)?.size ?? 0
  }
}

function capability(
  capabilityId: string,
  risk: GameCapability['risk'],
  properties: GameCapability['inputSchema']['properties'] = {},
  required: string[] = [],
  cancellable = false,
): GameCapability {
  return {
    capabilityId,
    description: capabilityId,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    risk,
    cancellable,
  }
}

function eventBase(command: GameCommand) {
  return {
    sessionId: command.sessionId,
    turnId: command.turnId,
    actionId: command.actionId,
    capabilityId: command.capabilityId,
    timestamp: 100,
  }
}

function voiceTurn(sessionId: string, turnId: string, text: string): VoiceTurn {
  return {
    sessionId,
    turnId,
    text,
    createdAt: 1000,
    metadata: { source: 'hearing', eventId: `event-${turnId}` },
  }
}
