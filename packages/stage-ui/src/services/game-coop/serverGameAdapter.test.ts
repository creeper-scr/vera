import type {
  GameActionEvent,
  GameActionEventListener,
  GameCapability,
  GameCommand,
  GameEnvironmentSnapshot,
  GameObservation,
} from '@proj-vera/game-coop-core'
import type {
  WebSocketBaseEvent,
  WebSocketEventOptionalSource,
  WebSocketEvents,
} from '@proj-vera/server-sdk'

import type { GameCoopServerChannel } from './serverGameAdapter'

import { GameEnvironmentUnavailableError } from '@proj-vera/game-coop-core'
import { describe, expect, it, vi } from 'vitest'

import { ServerGameAdapter } from './serverGameAdapter'

type SupportedEventType
  = | 'extension:module:de-announced'
    | 'game:coop:capabilities'
    | 'game:coop:action'
    | 'game:coop:environment'
    | 'game:coop:observation'

const minecraftModuleIdentity = {
  id: 'minecraft-instance',
  extension: { id: 'minecraft' },
}

function createChannel() {
  const listeners = new Map<SupportedEventType, Set<(event: never) => void>>()
  const disconnectListeners = new Set<(reason?: string) => void>()
  const sent: WebSocketEventOptionalSource[] = []
  let connected = true

  const channel: GameCoopServerChannel = {
    isConnected: () => connected,
    send(event) {
      sent.push(event)
    },
    onEvent(type, listener) {
      const eventListeners = listeners.get(type) ?? new Set<(event: never) => void>()
      eventListeners.add(listener as (event: never) => void)
      listeners.set(type, eventListeners)
      return () => eventListeners.delete(listener as (event: never) => void)
    },
    onDisconnected(listener) {
      disconnectListeners.add(listener)
      return () => disconnectListeners.delete(listener)
    },
  }

  return {
    channel,
    sent,
    emit<E extends SupportedEventType>(
      type: E,
      data: WebSocketEvents[E],
      source = minecraftModuleIdentity,
    ) {
      const event: WebSocketBaseEvent<E, WebSocketEvents[E]> = {
        type,
        data,
        metadata: {
          source,
          event: { id: 'transport-event' },
        },
      }
      for (const listener of listeners.get(type) ?? [])
        listener(event as never)
    },
    disconnect(reason?: string) {
      connected = false
      for (const listener of disconnectListeners)
        listener(reason)
    },
  }
}

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

async function selectRemoteModule(
  adapter: ServerGameAdapter,
  transport: ReturnType<typeof createChannel>,
  options: {
    capability?: GameCapability
    sessionId?: string
    source?: typeof minecraftModuleIdentity
  } = {},
): Promise<void> {
  const sessionId = options.sessionId ?? 'session-1'
  const pending = adapter.getCapabilities(sessionId)
  const request = transport.sent.at(-1)
  if (request?.type !== 'game:coop:capabilities:request')
    throw new Error('Expected capability request')

  transport.emit('game:coop:capabilities', {
    requestId: request.data.requestId,
    sessionId,
    adapterId: request.data.adapterId,
    capabilities: [options.capability ?? capability],
    destinations: [request.data.replyTo],
  }, options.source)
  await pending
}

const command: GameCommand = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  actionId: 'action-1',
  capabilityId: 'minecraft.status',
  input: {},
}

describe('server game adapter', () => {
  it('reads environment and forwards world observations from the selected remote instance', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft-bot',
      replyTo: 'module:stage',
    })
    await selectRemoteModule(adapter, transport)

    const observations: GameObservation[] = []
    const unsubscribe = adapter.observeWorld?.('session-1', observation => observations.push(observation))
    const subscribe = transport.sent.at(-1)
    expect(subscribe).toMatchObject({
      type: 'game:coop:observation:subscribe',
      data: {
        adapterId: 'minecraft',
        sessionId: 'session-1',
        replyTo: 'module:stage',
        destinations: ['instance:minecraft-instance'],
      },
    })

    const observation: GameObservation = {
      sessionId: 'session-1',
      adapterId: 'minecraft',
      eventId: 'hurt-1',
      kind: 'hurt',
      urgency: 'high',
      observedAt: 10,
      text: 'Bot was hurt',
      data: { damage: 2 },
    }
    transport.emit('game:coop:observation', {
      adapterId: 'minecraft',
      observation,
      destinations: ['module:stage'],
    })
    expect(observations).toEqual([observation])

    const pendingEnvironment = adapter.getEnvironment?.('session-1')
    const request = transport.sent.at(-1)
    if (request?.type !== 'game:coop:environment:request')
      throw new Error('Expected environment request')
    const environment: GameEnvironmentSnapshot = {
      sessionId: 'session-1',
      adapterId: 'minecraft',
      revision: 'world-1',
      observedAt: 11,
      freshnessMs: 1_000,
      content: { health: 20 },
    }
    transport.emit('game:coop:environment', {
      requestId: request.data.requestId,
      adapterId: 'minecraft',
      sessionId: 'session-1',
      environment,
      destinations: ['module:stage'],
    })
    await expect(pendingEnvironment).resolves.toEqual(environment)

    unsubscribe?.()
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'game:coop:observation:unsubscribe',
      data: {
        adapterId: 'minecraft',
        sessionId: 'session-1',
        replyTo: 'module:stage',
        destinations: ['instance:minecraft-instance'],
      },
    })
  })

  it('preserves remote environment-unavailable as a distinct outcome', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft-bot',
      replyTo: 'module:stage',
    })
    await selectRemoteModule(adapter, transport)

    const pendingEnvironment = adapter.getEnvironment?.('session-1')
    const request = transport.sent.at(-1)
    if (request?.type !== 'game:coop:environment:request')
      throw new Error('Expected environment request')
    transport.emit('game:coop:environment', {
      requestId: request.data.requestId,
      adapterId: 'minecraft',
      sessionId: 'session-1',
      unavailable: true,
      destinations: ['module:stage'],
    })

    await expect(pendingEnvironment).rejects.toBeInstanceOf(GameEnvironmentUnavailableError)
  })

  it('can expose an absent remote module as an empty dynamic catalog', async () => {
    vi.useFakeTimers()
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
      requestTimeoutMs: 10,
      unavailableAsEmpty: true,
    })

    const pending = adapter.getCapabilities('session-1')
    await vi.advanceTimersByTimeAsync(10)

    await expect(pending).resolves.toEqual([])
    vi.useRealTimers()
  })

  it('correlates capability responses and ignores unrelated adapters', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
    })
    const pending = adapter.getCapabilities('session-1')
    const request = transport.sent[0]
    if (request.type !== 'game:coop:capabilities:request')
      throw new Error('Expected capability request')

    transport.emit('game:coop:capabilities', {
      requestId: request.data.requestId,
      sessionId: 'session-1',
      adapterId: 'dst',
      capabilities: [],
      destinations: ['module:stage'],
    })
    transport.emit('game:coop:capabilities', {
      requestId: request.data.requestId,
      sessionId: 'session-1',
      adapterId: 'minecraft',
      capabilities: [capability],
      destinations: ['module:stage'],
    })

    await expect(pending).resolves.toEqual([capability])
  })

  it('keeps the selected module instance across capability refreshes', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
    })
    await selectRemoteModule(adapter, transport)

    const pendingRefresh = adapter.getCapabilities('session-1')
    const request = transport.sent.at(-1)
    if (request?.type !== 'game:coop:capabilities:request')
      throw new Error('Expected capability request')
    expect(request.data.destinations).toEqual(['instance:minecraft-instance'])

    transport.emit('game:coop:capabilities', {
      requestId: request.data.requestId,
      sessionId: 'session-1',
      adapterId: 'minecraft',
      capabilities: [capability],
      destinations: ['module:stage'],
    }, {
      id: 'other-minecraft-instance',
      extension: { id: 'minecraft' },
    })
    transport.emit('game:coop:capabilities', {
      requestId: request.data.requestId,
      sessionId: 'session-1',
      adapterId: 'minecraft',
      capabilities: [capability],
      destinations: ['module:stage'],
    })
    await pendingRefresh

    const execution = adapter.execute(command)
    const sentCommand = transport.sent.at(-1)
    if (sentCommand?.type !== 'game:coop:command')
      throw new Error('Expected game command')
    expect(sentCommand.data.destinations).toEqual(['instance:minecraft-instance'])
    transport.emit('game:coop:action', {
      adapterId: 'minecraft',
      event: { ...command, state: 'queued', timestamp: 1 },
      destinations: ['module:stage'],
    })
    await execution
  })

  it('rejects command execution when the remote adapter never acknowledges it', async () => {
    vi.useFakeTimers()
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
      requestTimeoutMs: 10,
    })

    await selectRemoteModule(adapter, transport)
    const pending = adapter.execute(command)
    const rejection = expect(pending).rejects.toThrow(
      'Timed out waiting for remote game action "action-1" acknowledgement',
    )
    await vi.advanceTimersByTimeAsync(10)

    await rejection
    vi.useRealTimers()
  })

  it('does not queue a stale command while the server channel is disconnected', async () => {
    const transport = createChannel()
    transport.disconnect()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
    })

    await expect(adapter.execute(command)).rejects.toThrow('Server channel is disconnected')
    expect(transport.sent).toHaveLength(0)
  })

  it('does not broadcast a command before capability discovery selects an instance', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
    })

    await expect(adapter.execute(command)).rejects.toThrow(
      'Remote game adapter "minecraft" has no selected instance for session "session-1"',
    )
    expect(transport.sent).toHaveLength(0)
  })

  it('routes commands, cancellation, and correlated lifecycle events', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
    })
    const listener = vi.fn<GameActionEventListener>()
    adapter.observe('session-1', listener)

    await selectRemoteModule(adapter, transport)
    const execution = adapter.execute(command)
    const action: GameActionEvent = {
      ...command,
      state: 'queued',
      timestamp: 1,
    }
    transport.emit('game:coop:action', {
      adapterId: 'minecraft',
      event: action,
      destinations: ['module:stage'],
    })
    await execution
    await adapter.cancel(command.actionId, 'interrupted')

    expect(transport.sent).toContainEqual({
      type: 'game:coop:command',
      data: {
        adapterId: 'minecraft',
        command,
        replyTo: 'module:stage',
        destinations: ['instance:minecraft-instance'],
      },
    })
    expect(transport.sent).toContainEqual({
      type: 'game:coop:cancel',
      data: {
        adapterId: 'minecraft',
        sessionId: 'session-1',
        actionId: 'action-1',
        reason: 'interrupted',
        destinations: ['instance:minecraft-instance'],
      },
    })
    expect(listener).toHaveBeenCalledWith(action)
  })

  it('fails acknowledged actions when the server channel disconnects', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
    })
    const listener = vi.fn<GameActionEventListener>()
    adapter.observe('session-1', listener)
    await selectRemoteModule(adapter, transport)
    const execution = adapter.execute(command)
    transport.emit('game:coop:action', {
      adapterId: 'minecraft',
      event: { ...command, state: 'queued', timestamp: 1 },
      destinations: ['module:stage'],
    })
    await execution

    transport.disconnect('Server channel disconnected')

    expect(listener).toHaveBeenLastCalledWith({
      ...command,
      state: 'failed',
      timestamp: expect.any(Number),
      error: 'Server channel disconnected',
    })
  })

  it('fails only actions owned by the de-announced remote module instance', async () => {
    const transport = createChannel()
    const minecraftAdapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
    })
    const dstAdapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'dst',
      destination: 'module:dst',
      replyTo: 'module:stage',
    })
    const minecraftListener = vi.fn<GameActionEventListener>()
    const dstListener = vi.fn<GameActionEventListener>()
    minecraftAdapter.observe('session-1', minecraftListener)
    dstAdapter.observe('session-1', dstListener)

    await selectRemoteModule(minecraftAdapter, transport)
    const minecraftExecution = minecraftAdapter.execute(command)
    transport.emit('game:coop:action', {
      adapterId: 'minecraft',
      event: { ...command, state: 'queued', timestamp: 1 },
      destinations: ['module:stage'],
    })
    await minecraftExecution

    const dstCommand: GameCommand = {
      ...command,
      actionId: 'dst-action-1',
      capabilityId: 'dst.status',
    }
    const dstModuleIdentity = {
      id: 'dst-instance',
      extension: { id: 'dst' },
    }
    await selectRemoteModule(dstAdapter, transport, {
      capability: {
        ...capability,
        capabilityId: dstCommand.capabilityId,
      },
      source: dstModuleIdentity,
    })
    const dstExecution = dstAdapter.execute(dstCommand)
    transport.emit('game:coop:action', {
      adapterId: 'dst',
      event: { ...dstCommand, state: 'queued', timestamp: 1 },
      destinations: ['module:stage'],
    }, dstModuleIdentity)
    await dstExecution

    transport.emit('extension:module:de-announced', {
      name: 'minecraft',
      identity: {
        id: 'other-minecraft-instance',
        extension: { id: 'minecraft' },
      },
      possibleEvents: [],
      reason: 'connection closed',
    })

    expect(minecraftListener).toHaveBeenCalledTimes(1)

    transport.emit('extension:module:de-announced', {
      name: 'minecraft',
      identity: minecraftModuleIdentity,
      possibleEvents: [],
      reason: 'connection closed',
    })

    expect(minecraftListener).toHaveBeenLastCalledWith({
      ...command,
      state: 'failed',
      timestamp: expect.any(Number),
      error: 'Remote game adapter "minecraft" became unavailable: connection closed',
    })
    expect(dstListener).toHaveBeenCalledTimes(1)
    await expect(minecraftAdapter.cancel(command.actionId)).rejects.toThrow(
      'Remote game action "action-1" does not exist',
    )
    await expect(dstAdapter.cancel(dstCommand.actionId)).resolves.toBeUndefined()
  })

  it('ignores lifecycle events from a different same-name module instance', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
    })
    const listener = vi.fn<GameActionEventListener>()
    adapter.observe('session-1', listener)
    await selectRemoteModule(adapter, transport)

    const execution = adapter.execute(command)
    const action: GameActionEvent = {
      ...command,
      state: 'queued',
      timestamp: 1,
    }
    transport.emit('game:coop:action', {
      adapterId: 'minecraft',
      event: { ...action, timestamp: 0 },
      destinations: ['module:stage'],
    }, {
      id: 'other-minecraft-instance',
      extension: { id: 'minecraft' },
    })
    transport.emit('game:coop:action', {
      adapterId: 'minecraft',
      event: action,
      destinations: ['module:stage'],
    })
    await execution

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(action)
  })

  it('rejects unacknowledged actions when their selected module de-announces', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
      actionAckTimeoutMs: 1,
    })
    await selectRemoteModule(adapter, transport)

    const execution = adapter.execute(command)
    transport.emit('extension:module:de-announced', {
      name: 'minecraft',
      identity: minecraftModuleIdentity,
      possibleEvents: [],
      reason: 'connection closed',
    })

    await expect(execution).rejects.toThrow(
      'Remote game adapter "minecraft" became unavailable: connection closed',
    )
  })

  it('keeps tracking an action after its voice-session observer detaches', async () => {
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
    })
    const stopObserving = adapter.observe('session-1', vi.fn())
    await selectRemoteModule(adapter, transport)
    const execution = adapter.execute(command)
    transport.emit('game:coop:action', {
      adapterId: 'minecraft',
      event: { ...command, state: 'queued', timestamp: 1 },
      destinations: ['module:stage'],
    })
    await execution

    stopObserving()
    transport.emit('game:coop:action', {
      adapterId: 'minecraft',
      event: { ...command, state: 'succeeded', timestamp: 2 },
      destinations: ['module:stage'],
    })

    await expect(adapter.cancel(command.actionId)).rejects.toThrow(
      'Remote game action "action-1" does not exist',
    )
    expect(transport.sent.some(event => event.type === 'game:coop:cancel')).toBe(false)
  })

  it('fails acknowledged bounded actions that never reach a terminal event', async () => {
    vi.useFakeTimers()
    const transport = createChannel()
    const adapter = new ServerGameAdapter({
      channel: transport.channel,
      adapterId: 'minecraft',
      destination: 'module:minecraft',
      replyTo: 'module:stage',
      actionTerminalTimeoutMs: 10,
    })
    const listener = vi.fn<GameActionEventListener>()
    adapter.observe('session-1', listener)
    await selectRemoteModule(adapter, transport)
    const execution = adapter.execute(command)
    transport.emit('game:coop:action', {
      adapterId: 'minecraft',
      event: { ...command, state: 'queued', timestamp: 1 },
      destinations: ['module:stage'],
    })
    await execution

    await vi.advanceTimersByTimeAsync(10)

    expect(listener).toHaveBeenLastCalledWith({
      ...command,
      state: 'failed',
      timestamp: expect.any(Number),
      error: 'Timed out waiting for remote game action "action-1" terminal event',
    })
    vi.useRealTimers()
  })
})
