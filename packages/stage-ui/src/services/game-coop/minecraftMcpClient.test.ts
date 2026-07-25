import type {
  GameActionEvent,
  GameActionEventListener,
  GameCapability,
  GameCommand,
  GameExecutionPort,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import { describe, expect, it, vi } from 'vitest'

import { createMinecraftMcpClient } from './minecraftMcpClient'

const statusCapability = capability('minecraft.status', 'low')
const followCapability = capability('minecraft.follow', 'low', {
  playerName: { type: 'string', minLength: 1 },
}, ['playerName'])
const sayCapability = capability('minecraft.say', 'low', {
  text: { type: 'string', minLength: 1 },
}, ['text'])
const collectCapability = capability('minecraft.collect', 'medium', {
  target: { type: 'string' },
}, ['target'])

describe('minecraftMcpClient', () => {
  it('exposes only low-risk Minecraft action tools', async () => {
    const port = new FakeExecutionPort([
      statusCapability,
      followCapability,
      collectCapability,
      capability('other.inspect', 'low'),
    ])
    const client = createMinecraftMcpClient({ executionPort: port })

    const tools = await client.listTools('session-1', new AbortController().signal)

    expect(tools.map(tool => tool.name)).toEqual(['minecraft_follow'])
    expect(tools[0]?.inputSchema).toEqual(followCapability.inputSchema)
    await client.dispose()
  })

  it('reads one correlated status snapshot and ignores stale events', async () => {
    const port = new FakeExecutionPort([statusCapability])
    port.executeHandler = async (command) => {
      port.emit({
        ...eventBase(command),
        actionId: 'stale-action',
        state: 'snapshot',
        snapshot: { connected: false },
      })
      port.emit({
        ...eventBase(command),
        timestamp: 120,
        state: 'snapshot',
        snapshot: { connected: true, username: 'Vera' },
      })
      port.emit({
        ...eventBase(command),
        timestamp: 121,
        state: 'succeeded',
      })
    }
    const client = createMinecraftMcpClient({
      executionPort: port,
      createActionId: () => 'environment-action',
      environmentFreshnessMs: 2_000,
    })

    const environment = await client.readEnvironment('session-1', new AbortController().signal)

    expect(environment).toEqual({
      sessionId: 'session-1',
      observedAt: 120,
      freshnessMs: 2_000,
      adapterId: 'minecraft',
      revision: 'status:120',
      content: { connected: true, username: 'Vera' },
    })
    expect(port.commands[0]).toEqual({
      sessionId: 'session-1',
      turnId: 'environment:environment-action',
      actionId: 'environment-action',
      capabilityId: 'minecraft.status',
      input: {},
    })
    expect(port.listenerCount('session-1')).toBe(0)
    await client.dispose()
  })

  it('routes correlated tool calls once and validates arguments', async () => {
    const port = new FakeExecutionPort([statusCapability, sayCapability])
    // D1 default: waitForTerminal=true, so resolve after succeeded.
    port.executeHandler = async (command) => {
      port.emit({
        ...eventBase(command),
        state: 'queued',
      })
      port.emit({
        ...eventBase(command),
        timestamp: 101,
        state: 'running',
      })
      port.emit({
        ...eventBase(command),
        timestamp: 102,
        state: 'succeeded',
        result: { said: 'hello' },
      })
    }
    const client = createMinecraftMcpClient({
      executionPort: port,
      createActionId: () => 'tool-action',
    })
    const abortSignal = new AbortController().signal
    const call = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-call-1',
      name: 'minecraft_say',
      arguments: { text: 'hello' },
      abortSignal,
    }

    const [first, duplicate] = await Promise.all([
      client.callTool(call),
      client.callTool(call),
    ])

    expect(first).toEqual({
      status: 'terminal',
      actionId: 'tool-action',
      capabilityId: 'minecraft.say',
      state: 'succeeded',
      result: { said: 'hello' },
    })
    expect(duplicate).toEqual(first)
    expect(port.commands).toEqual([{
      sessionId: 'session-1',
      turnId: 'turn-1',
      actionId: 'tool-action',
      capabilityId: 'minecraft.say',
      input: { text: 'hello' },
    }])
    await expect(client.callTool({
      ...call,
      toolCallId: 'tool-call-2',
      arguments: { text: 'different' },
    })).resolves.toMatchObject({ status: 'terminal', state: 'succeeded' })

    await expect(client.callTool({
      ...call,
      toolCallId: 'invalid-call',
      arguments: {},
    })).rejects.toThrow('Invalid arguments')
    await client.dispose()
  })

  it('returns unavailable environment when Minecraft is absent', async () => {
    const port = new FakeExecutionPort([])
    const client = createMinecraftMcpClient({
      executionPort: port,
      now: () => 500,
    })
    const abortSignal = new AbortController().signal

    await expect(client.listTools('session-1', abortSignal)).resolves.toEqual([])
    await expect(client.readEnvironment('session-1', abortSignal)).resolves.toEqual({
      sessionId: 'session-1',
      observedAt: 500,
      freshnessMs: 0,
      adapterId: 'minecraft',
      revision: 'unavailable',
      content: { available: false, game: 'minecraft' },
    })
    expect(port.commands).toEqual([])
    await client.dispose()
  })

  it('settles failure, cancellation, and dispose without orphaned observers', async () => {
    const failedPort = new FakeExecutionPort([statusCapability])
    failedPort.executeHandler = async command => failedPort.emit({
      ...eventBase(command),
      state: 'failed',
      error: 'status failed',
    })
    const failedClient = createMinecraftMcpClient({ executionPort: failedPort })

    await expect(failedClient.readEnvironment(
      'failed-session',
      new AbortController().signal,
    )).rejects.toThrow('status failed')
    expect(failedPort.listenerCount('failed-session')).toBe(0)
    await failedClient.dispose()

    const pendingPort = new FakeExecutionPort([statusCapability])
    pendingPort.executeHandler = async () => {}
    // NOTICE: Legacy status-env path only detaches observers on terminal/timeout.
    // Short timeout so abort of the outer MCP resource still cleans listeners.
    const pendingClient = createMinecraftMcpClient({
      executionPort: pendingPort,
      environmentTimeoutMs: 50,
    })
    const controller = new AbortController()
    const environment = pendingClient.readEnvironment('pending-session', controller.signal)
    await vi.waitFor(() => expect(pendingPort.commands).toHaveLength(1))
    controller.abort()

    await expect(environment).rejects.toThrow()
    await vi.waitFor(() => expect(pendingPort.listenerCount('pending-session')).toBe(0))
    await pendingClient.dispose()
    await expect(pendingClient.listTools(
      'pending-session',
      new AbortController().signal,
    )).rejects.toThrow('disposed')

    const disposedPort = new FakeExecutionPort([statusCapability])
    disposedPort.executeHandler = async () => {}
    const disposedClient = createMinecraftMcpClient({
      executionPort: disposedPort,
      environmentTimeoutMs: 50,
    })
    const disposedEnvironment = disposedClient.readEnvironment(
      'disposed-session',
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(disposedPort.commands).toHaveLength(1))
    await disposedClient.dispose()

    await expect(disposedEnvironment).rejects.toThrow()
    await vi.waitFor(() => expect(disposedPort.listenerCount('disposed-session')).toBe(0))
  })
})

class FakeExecutionPort implements GameExecutionPort {
  public readonly commands: GameCommand[] = []
  public executeHandler?: (command: GameCommand) => Promise<void>
  public readonly cancel = vi.fn(async () => {})
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
    cancellable: false,
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
