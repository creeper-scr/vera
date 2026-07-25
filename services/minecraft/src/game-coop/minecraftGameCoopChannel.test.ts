import type {
  GameActionEventListener,
  GameAdapter,
  GameCapability,
  GameCommand,
  GameEnvironmentSnapshot,
  GameObservationListener,
} from '@proj-vera/game-coop-core'
import type { Client, WebSocketBaseEvent, WebSocketEvents } from '@proj-vera/server-sdk'

import { describe, expect, it, vi } from 'vitest'

import { MinecraftGameCoopChannel } from './minecraftGameCoopChannel'

type InboundEventType
  = | 'game:coop:capabilities:request'
    | 'game:coop:command'
    | 'game:coop:cancel'
    | 'game:coop:environment:request'
    | 'game:coop:observation:subscribe'
    | 'game:coop:observation:unsubscribe'

function createClient() {
  const listeners = new Map<InboundEventType, Set<(event: never) => void>>()
  const send = vi.fn(() => true)
  const onEvent: Client['onEvent'] = vi.fn((type, listener) => {
    const inboundType = type as InboundEventType
    const eventListeners = listeners.get(inboundType) ?? new Set<(event: never) => void>()
    eventListeners.add(listener as (event: never) => void)
    listeners.set(inboundType, eventListeners)
    return () => eventListeners.delete(listener as (event: never) => void)
  })

  return {
    client: { onEvent, send },
    send,
    async emit<E extends InboundEventType>(type: E, data: WebSocketEvents[E]) {
      const event = { type, data } as WebSocketBaseEvent<E, WebSocketEvents[E]>
      for (const listener of listeners.get(type) ?? [])
        await listener(event as never)
    },
  }
}

function createAdapter() {
  const listeners = new Map<string, GameActionEventListener>()
  const observationListeners = new Map<string, GameObservationListener>()
  const capability: GameCapability = {
    capabilityId: 'minecraft.status',
    description: 'status',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    risk: 'low',
    cancellable: false,
  }
  const adapter: GameAdapter = {
    getCapabilities: vi.fn(async () => [capability]),
    observe: vi.fn((sessionId, listener) => {
      listeners.set(sessionId, listener)
      return () => listeners.delete(sessionId)
    }),
    observeWorld: vi.fn((sessionId, listener) => {
      observationListeners.set(sessionId, listener)
      return () => observationListeners.delete(sessionId)
    }),
    getEnvironment: vi.fn(async (sessionId): Promise<GameEnvironmentSnapshot> => ({
      sessionId,
      adapterId: 'minecraft',
      revision: 'world-1',
      observedAt: 10,
      freshnessMs: 1_000,
      content: { health: 20 },
    })),
    execute: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  }
  return { adapter, capability, listeners, observationListeners }
}

const command: GameCommand = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  actionId: 'action-1',
  capabilityId: 'minecraft.status',
  input: {},
}

describe('minecraft game Coop channel', () => {
  it('serves correlated capabilities to the requester route', async () => {
    const transport = createClient()
    const game = createAdapter()
    const channel = new MinecraftGameCoopChannel({
      client: transport.client,
      adapter: game.adapter,
    })
    channel.init()

    await transport.emit('game:coop:capabilities:request', {
      requestId: 'request-1',
      sessionId: 'session-1',
      adapterId: 'minecraft',
      replyTo: 'module:stage',
      destinations: ['module:minecraft'],
    })

    expect(transport.send).toHaveBeenCalledWith({
      type: 'game:coop:capabilities',
      data: {
        requestId: 'request-1',
        sessionId: 'session-1',
        adapterId: 'minecraft',
        capabilities: [game.capability],
        destinations: ['module:stage'],
      },
    })
  })

  it('executes commands and returns their lifecycle only to the requester', async () => {
    const transport = createClient()
    const game = createAdapter()
    const channel = new MinecraftGameCoopChannel({
      client: transport.client,
      adapter: game.adapter,
    })
    channel.init()

    await transport.emit('game:coop:command', {
      adapterId: 'minecraft',
      command,
      replyTo: 'module:stage',
      destinations: ['module:minecraft'],
    })
    const event = {
      ...command,
      state: 'queued' as const,
      timestamp: 1,
    }
    game.listeners.get(command.sessionId)?.(event)

    expect(game.adapter.execute).toHaveBeenCalledWith(command)
    expect(transport.send).toHaveBeenCalledWith({
      type: 'game:coop:action',
      data: {
        adapterId: 'minecraft',
        event,
        destinations: ['module:stage'],
      },
    })
  })

  it('forwards action-scoped cancellation and removes listeners on destroy', async () => {
    const transport = createClient()
    const game = createAdapter()
    const channel = new MinecraftGameCoopChannel({
      client: transport.client,
      adapter: game.adapter,
    })
    channel.init()

    await transport.emit('game:coop:command', {
      adapterId: 'minecraft',
      command,
      replyTo: 'module:stage',
      destinations: ['module:minecraft'],
    })
    await transport.emit('game:coop:cancel', {
      adapterId: 'minecraft',
      sessionId: 'session-1',
      actionId: 'action-1',
      reason: 'interrupted',
      destinations: ['module:minecraft'],
    })
    channel.destroy()

    expect(game.adapter.cancel).toHaveBeenCalledWith('action-1', 'interrupted')
    expect(game.listeners.size).toBe(0)
  })

  it('serves environment snapshots and routes world observations to subscribers', async () => {
    const transport = createClient()
    const game = createAdapter()
    const channel = new MinecraftGameCoopChannel({
      client: transport.client,
      adapter: game.adapter,
    })
    channel.init()

    await transport.emit('game:coop:observation:subscribe', {
      adapterId: 'minecraft',
      sessionId: 'session-1',
      replyTo: 'module:stage',
      destinations: ['module:minecraft'],
    })
    await transport.emit('game:coop:environment:request', {
      requestId: 'environment-1',
      adapterId: 'minecraft',
      sessionId: 'session-1',
      replyTo: 'module:stage',
      destinations: ['module:minecraft'],
    })

    const observation = {
      sessionId: 'session-1',
      adapterId: 'minecraft',
      eventId: 'hurt-1',
      kind: 'hurt',
      urgency: 'high' as const,
      observedAt: 11,
      text: 'Bot was hurt',
      data: { damage: 2 },
    }
    game.observationListeners.get('session-1')?.(observation)

    expect(transport.send).toHaveBeenCalledWith({
      type: 'game:coop:environment',
      data: {
        requestId: 'environment-1',
        adapterId: 'minecraft',
        sessionId: 'session-1',
        environment: {
          sessionId: 'session-1',
          adapterId: 'minecraft',
          revision: 'world-1',
          observedAt: 10,
          freshnessMs: 1_000,
          content: { health: 20 },
        },
        destinations: ['module:stage'],
      },
    })
    expect(transport.send).toHaveBeenCalledWith({
      type: 'game:coop:observation',
      data: {
        adapterId: 'minecraft',
        observation,
        destinations: ['module:stage'],
      },
    })

    await transport.emit('game:coop:observation:unsubscribe', {
      adapterId: 'minecraft',
      sessionId: 'session-1',
      replyTo: 'module:stage',
      destinations: ['module:minecraft'],
    })
    expect(game.observationListeners.size).toBe(0)
  })
})
