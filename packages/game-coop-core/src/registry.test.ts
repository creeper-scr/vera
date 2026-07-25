import type {
  GameActionEvent,
  GameActionEventListener,
  GameAdapter,
  GameCapability,
  GameCommand,
} from './contracts'

import { describe, expect, it, vi } from 'vitest'

import { createGameAdapterRegistry } from './registry'

function capability(capabilityId: string, cancellable = true): GameCapability {
  return {
    capabilityId,
    description: capabilityId,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    risk: 'low',
    cancellable,
  }
}

function command(capabilityId: string, actionId = 'action-1'): GameCommand {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    actionId,
    capabilityId,
    input: {},
  }
}

function createAdapter(capabilities: GameCapability[]) {
  const listeners = new Map<string, Set<GameActionEventListener>>()
  const adapter: GameAdapter = {
    getCapabilities: vi.fn(async () => capabilities),
    observe: vi.fn((sessionId, listener) => {
      const sessionListeners = listeners.get(sessionId) ?? new Set<GameActionEventListener>()
      sessionListeners.add(listener)
      listeners.set(sessionId, sessionListeners)
      return () => sessionListeners.delete(listener)
    }),
    execute: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  }

  return {
    adapter,
    emit(event: GameActionEvent) {
      for (const listener of listeners.get(event.sessionId) ?? [])
        listener(event)
    },
  }
}

function event(
  state: GameActionEvent['state'],
  overrides: Partial<GameActionEvent> = {},
): GameActionEvent {
  const base = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    actionId: 'action-1',
    capabilityId: 'minecraft.follow',
    timestamp: 1,
  }

  if (state === 'progress')
    return { ...base, state, progress: {}, ...overrides } as GameActionEvent
  if (state === 'succeeded')
    return { ...base, state, ...overrides } as GameActionEvent
  if (state === 'failed')
    return { ...base, state, error: 'failed', ...overrides } as GameActionEvent
  if (state === 'cancelled')
    return { ...base, state, ...overrides } as GameActionEvent
  if (state === 'snapshot')
    return { ...base, state, snapshot: {}, ...overrides } as GameActionEvent
  return { ...base, state, ...overrides } as GameActionEvent
}

describe('createGameAdapterRegistry', () => {
  it('aggregates dynamic capabilities and routes commands and cancellation', async () => {
    const registry = createGameAdapterRegistry()
    const minecraft = createAdapter([capability('minecraft.follow')])
    const dst = createAdapter([capability('dst.status')])
    registry.register({ adapterId: 'minecraft', adapter: minecraft.adapter })
    registry.register({ adapterId: 'dst', adapter: dst.adapter })

    await expect(registry.getCapabilities('session-1')).resolves.toEqual([
      capability('minecraft.follow'),
      capability('dst.status'),
    ])

    const follow = command('minecraft.follow')
    await registry.execute(follow)
    await registry.cancel(follow.actionId, 'user interrupted')

    expect(minecraft.adapter.execute).toHaveBeenCalledWith(follow)
    expect(minecraft.adapter.cancel).toHaveBeenCalledWith(follow.actionId, 'user interrupted')
    expect(dst.adapter.execute).not.toHaveBeenCalled()
    expect(dst.adapter.cancel).not.toHaveBeenCalled()
  })

  it('rejects per-session capability collisions', async () => {
    const registry = createGameAdapterRegistry()
    registry.register({
      adapterId: 'minecraft-a',
      adapter: createAdapter([capability('minecraft.status')]).adapter,
    })
    registry.register({
      adapterId: 'minecraft-b',
      adapter: createAdapter([capability('minecraft.status')]).adapter,
    })

    await expect(registry.getCapabilities('session-1')).rejects.toThrow(
      'Capability "minecraft.status" is declared by both "minecraft-a" and "minecraft-b"',
    )
  })

  it('releases action ownership when adapter execution rejects before acknowledgement', async () => {
    const registry = createGameAdapterRegistry()
    const minecraft = createAdapter([capability('minecraft.follow')])
    vi.mocked(minecraft.adapter.execute)
      .mockRejectedValueOnce(new Error('ack timeout'))
      .mockResolvedValueOnce()
    registry.register({ adapterId: 'minecraft', adapter: minecraft.adapter })
    await registry.getCapabilities('session-1')
    const follow = command('minecraft.follow')

    await expect(registry.execute(follow)).rejects.toThrow('ack timeout')
    await expect(registry.execute(follow)).resolves.toBeUndefined()
  })

  it('releases action ownership after its terminal event', async () => {
    const registry = createGameAdapterRegistry()
    const minecraft = createAdapter([capability('minecraft.follow')])
    registry.register({ adapterId: 'minecraft', adapter: minecraft.adapter })
    registry.observe('session-1', vi.fn())
    const follow = command('minecraft.follow')

    await registry.execute(follow)
    minecraft.emit(event('queued'))
    minecraft.emit(event('running'))
    minecraft.emit(event('succeeded'))

    await expect(registry.execute(follow)).resolves.toBeUndefined()
    expect(minecraft.adapter.execute).toHaveBeenCalledTimes(2)
  })

  it('forwards only correlated monotonic lifecycle events', async () => {
    const registry = createGameAdapterRegistry()
    const minecraft = createAdapter([capability('minecraft.follow')])
    registry.register({ adapterId: 'minecraft', adapter: minecraft.adapter })
    const listener = vi.fn()
    registry.observe('session-1', listener)
    await registry.execute(command('minecraft.follow'))

    minecraft.emit(event('queued'))
    minecraft.emit(event('snapshot'))
    minecraft.emit(event('running'))
    minecraft.emit(event('progress'))
    minecraft.emit(event('succeeded'))
    minecraft.emit(event('failed'))

    expect(listener.mock.calls.map(([value]) => value.state)).toEqual([
      'queued',
      'snapshot',
      'running',
      'progress',
      'succeeded',
    ])
  })

  it('rejects invalid transitions and mismatched correlation IDs', async () => {
    const registry = createGameAdapterRegistry()
    const minecraft = createAdapter([capability('minecraft.follow')])
    registry.register({ adapterId: 'minecraft', adapter: minecraft.adapter })
    registry.observe('session-1', vi.fn())
    await registry.execute(command('minecraft.follow'))

    expect(() => minecraft.emit(event('running'))).toThrow(
      'Invalid action transition for "action-1": none -> running',
    )
    expect(() => minecraft.emit(event('queued', { turnId: 'wrong-turn' }))).toThrow(
      'Adapter "minecraft" emitted mismatched correlation IDs for action "action-1"',
    )
  })

  it('subscribes active sessions to adapters registered later', async () => {
    const registry = createGameAdapterRegistry()
    const listener = vi.fn()
    registry.observe('session-1', listener)

    const stardew = createAdapter([capability('stardew.status')])
    registry.register({ adapterId: 'stardew', adapter: stardew.adapter })
    await registry.execute(command('stardew.status'))
    stardew.emit(event('queued', {
      capabilityId: 'stardew.status',
    }))

    expect(stardew.adapter.observe).toHaveBeenCalledWith('session-1', expect.any(Function))
    expect(listener).toHaveBeenCalledOnce()
  })
})
