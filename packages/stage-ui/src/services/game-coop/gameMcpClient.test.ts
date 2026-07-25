import type {
  GameActionEvent,
  GameActionEventListener,
  GameCapability,
  GameCommand,
  GameExecutionPort,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import { GameEnvironmentUnavailableError } from '@proj-vera/game-coop-core'
import { describe, expect, it, vi } from 'vitest'

import { createGameMcpClient } from './gameMcpClient'

const lookCapability = capability('minecraft.look', 'low', {
  playerName: { type: 'string', minLength: 1 },
}, ['playerName'], false, false)
const terraCapability = capability('terraria.build', 'low', {
  structure: { type: 'string' },
}, ['structure'])
const inspectCapability = capability('other.inspect', 'low')
const collectCapability = capability('minecraft.collect', 'medium', {
  target: { type: 'string' },
}, ['target'])
const attackCapability = capability('terraria.attack', 'high', {
  target: { type: 'string' },
}, ['target'], true)

describe('gameMcpClient', () => {
  it('exposes non-minecraft capabilities across adapters without a prefix filter', async () => {
    const port = new FakeExecutionPort([
      lookCapability,
      terraCapability,
      inspectCapability,
    ])
    const client = createGameMcpClient({ executionPort: port })

    const tools = await client.listTools('session-1', new AbortController().signal)

    expect(tools).toEqual([
      {
        name: 'minecraft_look',
        description: 'minecraft.look',
        inputSchema: lookCapability.inputSchema,
        risk: 'low',
        cancellable: false,
        waitForTerminal: false,
        capabilityId: 'minecraft.look',
      },
      {
        name: 'terraria_build',
        description: 'terraria.build',
        inputSchema: terraCapability.inputSchema,
        risk: 'low',
        cancellable: false,
        capabilityId: 'terraria.build',
      },
      {
        name: 'other_inspect',
        description: 'other.inspect',
        inputSchema: inspectCapability.inputSchema,
        risk: 'low',
        cancellable: false,
        capabilityId: 'other.inspect',
      },
    ])
    await client.dispose()
  })

  it('filters tools by allowedRisks', async () => {
    const port = new FakeExecutionPort([lookCapability, collectCapability, attackCapability])
    const client = createGameMcpClient({
      executionPort: port,
      allowedRisks: ['low', 'medium'],
    })

    const tools = await client.listTools('session-1', new AbortController().signal)

    expect(tools.map(tool => tool.name)).toEqual(['minecraft_look', 'minecraft_collect'])
    expect(tools[1]?.risk).toBe('medium')

    await expect(client.callTool({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-call-1',
      name: 'terraria_attack',
      arguments: { target: 'slime' },
      abortSignal: new AbortController().signal,
      waitForTerminal: false,
    })).rejects.toThrow('outside allowed risks')
    expect(port.commands).toEqual([])
    await client.dispose()
  })

  it('defaults to low-risk tools only', async () => {
    const port = new FakeExecutionPort([lookCapability, collectCapability])
    const client = createGameMcpClient({ executionPort: port })

    const tools = await client.listTools('session-1', new AbortController().signal)

    expect(tools.map(tool => tool.name)).toEqual(['minecraft_look'])
    await client.dispose()
  })

  it('hides *.status capabilities from model tools', async () => {
    const statusCapability = capability('minecraft.status', 'low')
    const port = new FakeExecutionPort([statusCapability, lookCapability])
    const client = createGameMcpClient({ executionPort: port })

    const tools = await client.listTools('session-1', new AbortController().signal)

    expect(tools.map(tool => tool.name)).toEqual(['minecraft_look'])
    expect(tools.some(tool => tool.capabilityId === 'minecraft.status')).toBe(false)
    await client.dispose()
  })

  it('waits for terminal success when waitForTerminal is true', async () => {
    const port = new FakeExecutionPort([lookCapability])
    port.executeHandler = async (command) => {
      queueMicrotask(() => {
        port.emit({
          ...eventBase(command),
          state: 'queued',
        })
        port.emit({
          ...eventBase(command),
          timestamp: 101,
          state: 'succeeded',
          result: { reached: true },
        })
      })
    }
    const client = createGameMcpClient({
      executionPort: port,
      createActionId: () => 'tool-action',
    })

    const result = await client.callTool({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-call-1',
      name: 'minecraft_look',
      arguments: { playerName: 'Vera' },
      abortSignal: new AbortController().signal,
    })

    expect(result).toEqual({
      status: 'terminal',
      actionId: 'tool-action',
      state: 'succeeded',
      capabilityId: 'minecraft.look',
      result: { reached: true },
    })
    expect(port.commands).toEqual([{
      sessionId: 'session-1',
      turnId: 'turn-1',
      actionId: 'tool-action',
      capabilityId: 'minecraft.look',
      input: { playerName: 'Vera' },
    }])
    expect(port.listenerCount('session-1')).toBe(0)
    await client.dispose()
  })

  it('returns an accepted handle when waitForTerminal is false', async () => {
    const port = new FakeExecutionPort([lookCapability])
    port.executeHandler = async () => {}
    const client = createGameMcpClient({
      executionPort: port,
      createActionId: () => 'tool-action',
    })

    const result = await client.callTool({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-call-1',
      name: 'minecraft_look',
      arguments: { playerName: 'Vera' },
      abortSignal: new AbortController().signal,
      waitForTerminal: false,
    })

    expect(result).toEqual({
      status: 'accepted',
      actionId: 'tool-action',
      state: 'queued',
      capabilityId: 'minecraft.look',
    })
    await client.dispose()
  })

  it('cancels a tracked cancellable action by actionId', async () => {
    const port = new FakeExecutionPort([attackCapability])
    port.executeHandler = async () => {}
    const client = createGameMcpClient({
      executionPort: port,
      createActionId: () => 'tool-action',
      allowedRisks: ['low', 'high'],
    })

    const accepted = await client.callTool({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-call-1',
      name: 'terraria_attack',
      arguments: { target: 'slime' },
      abortSignal: new AbortController().signal,
      waitForTerminal: false,
    })
    expect(accepted).toMatchObject({ status: 'accepted', actionId: 'tool-action' })

    await client.cancelAction?.({
      sessionId: 'session-1',
      actionId: 'tool-action',
      reason: 'player override',
      abortSignal: new AbortController().signal,
    })

    expect(port.cancel).toHaveBeenCalledWith('tool-action', 'player override')
    await client.dispose()
  })

  it('ignores cancelAction for untracked or non-cancellable actions', async () => {
    const port = new FakeExecutionPort([lookCapability])
    port.executeHandler = async () => {}
    const client = createGameMcpClient({
      executionPort: port,
      createActionId: () => 'tool-action',
    })

    await client.cancelAction?.({
      sessionId: 'session-1',
      actionId: 'missing-action',
      abortSignal: new AbortController().signal,
    })
    expect(port.cancel).not.toHaveBeenCalled()

    await client.callTool({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-call-1',
      name: 'minecraft_look',
      arguments: { playerName: 'Vera' },
      abortSignal: new AbortController().signal,
      waitForTerminal: false,
    })
    await client.cancelAction?.({
      sessionId: 'session-1',
      actionId: 'tool-action',
      abortSignal: new AbortController().signal,
    })
    expect(port.cancel).not.toHaveBeenCalled()
    await client.dispose()
  })

  it('reads the environment from getEnvironment without a status tool', async () => {
    const port = new FakeExecutionPort([])
    port.getEnvironment = async () => ({
      sessionId: 'session-1',
      adapterId: 'terraria',
      observedAt: 42,
      freshnessMs: 1_000,
      revision: 'rev-7',
      content: { biome: 'forest', health: 20 },
    })
    const client = createGameMcpClient({ executionPort: port })

    const environment = await client.readEnvironment('session-1', new AbortController().signal)

    expect(environment).toEqual({
      sessionId: 'session-1',
      observedAt: 42,
      freshnessMs: 1_000,
      adapterId: 'terraria',
      revision: 'rev-7',
      content: { biome: 'forest', health: 20 },
    })
    expect(port.commands).toEqual([])
    await client.dispose()
  })

  it('returns a never-fresh placeholder when no adapter provides environment', async () => {
    const port = new FakeExecutionPort([])
    const client = createGameMcpClient({
      executionPort: port,
      now: () => 500,
    })

    await expect(client.readEnvironment('session-1', new AbortController().signal)).resolves.toEqual({
      sessionId: 'session-1',
      observedAt: 500,
      freshnessMs: 0,
      content: { available: false },
    })
    expect(port.commands).toEqual([])
    await client.dispose()
  })

  it('returns the same placeholder when a remote transport reports environment unavailable', async () => {
    const port = new FakeExecutionPort([])
    port.getEnvironment = async sessionId => Promise.reject(new GameEnvironmentUnavailableError(sessionId))
    const client = createGameMcpClient({
      executionPort: port,
      now: () => 501,
    })

    await expect(client.readEnvironment('session-1', new AbortController().signal)).resolves.toEqual({
      sessionId: 'session-1',
      observedAt: 501,
      freshnessMs: 0,
      content: { available: false },
    })
    await client.dispose()
  })
})

class FakeExecutionPort implements GameExecutionPort {
  public readonly commands: GameCommand[] = []
  public executeHandler?: (command: GameCommand) => Promise<void>
  public readonly cancel = vi.fn(async () => {})
  /** Only set by tests that exercise the getEnvironment path. */
  public getEnvironment?: GameExecutionPort['getEnvironment']
  private readonly listeners = new Map<string, Set<GameActionEventListener>>()

  constructor(private readonly capabilities: GameCapability[]) {}

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

  public async execute(command: GameCommand): Promise<void> {
    this.commands.push(command)
    await this.executeHandler?.(command)
  }

  public emit(event: GameActionEvent): void {
    for (const listener of this.listeners.get(event.sessionId) ?? [])
      listener(event)
  }

  public listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0
  }
}

function capability(
  capabilityId: string,
  risk: GameCapability['risk'],
  properties: GameCapability['inputSchema']['properties'] = {},
  required: string[] = [],
  cancellable = false,
  waitForTerminal?: boolean,
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
    ...(waitForTerminal == null ? {} : { waitForTerminal }),
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
