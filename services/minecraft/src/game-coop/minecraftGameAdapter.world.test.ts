import type { GameObservation } from '@proj-vera/game-coop-core'

import type {
  MinecraftEnvironment,
  MinecraftEnvironmentListener,
  MinecraftGameDriver,
  MinecraftSnapshot,
  MinecraftWorldEvent,
} from './minecraftGameAdapter'

import { describe, expect, it, vi } from 'vitest'

import {
  MinecraftGameAdapter,
  minecraftObservationKinds,
} from './minecraftGameAdapter'

/**
 * Test-local view that asserts the optional world surface exists. Drivers
 * built by `createWorldDriver` always support sampling, so a missing method
 * is a real failure — surfaced by this helper instead of twenty non-null
 * assertions at call sites.
 */
type MinecraftWorldAdapter = MinecraftGameAdapter & {
  observeWorld: NonNullable<MinecraftGameAdapter['observeWorld']>
  getEnvironment: NonNullable<MinecraftGameAdapter['getEnvironment']>
}

function createWorldAdapter(options: ConstructorParameters<typeof MinecraftGameAdapter>[0]): MinecraftWorldAdapter {
  const adapter = new MinecraftGameAdapter(options)
  if (adapter.observeWorld == null || adapter.getEnvironment == null)
    throw new Error('world-capable driver must produce the world surface')
  return adapter as MinecraftWorldAdapter
}

const snapshot: MinecraftSnapshot = {
  connected: true,
  username: 'vera',
  position: { x: 1, y: 64, z: 2 },
  health: 20,
  food: 18,
  weather: 'clear',
  time: '10:00 AM',
  follow: {
    playerName: null,
    distance: 2,
    active: false,
    error: null,
  },
}

const environment: MinecraftEnvironment = {
  connected: true,
  username: 'vera',
  masterUsername: 'Steve',
  playersOnline: ['Steve'],
  position: { x: 1, y: 64, z: 2 },
  health: 20,
  food: 18,
  weather: 'clear',
  time: '10:00 AM',
  lightLevel: 15,
  nearbyHostiles: null,
  nearbyBlocks: [],
  nearestLog: null,
}

interface WorldDriver {
  driver: MinecraftGameDriver
  emit: (event: MinecraftWorldEvent) => void
  emitTick: () => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function createWorldDriver(): WorldDriver {
  let listener: MinecraftEnvironmentListener | null = null
  const unsubscribe = vi.fn(() => {
    listener = null
  })
  return {
    driver: {
      getSnapshot: vi.fn(() => snapshot),
      follow: vi.fn(),
      stopFollow: vi.fn(),
      getEnvironment: vi.fn(() => environment),
      observeEnvironment: vi.fn((next: MinecraftEnvironmentListener) => {
        listener = next
        return unsubscribe
      }),
    },
    emit: event => listener?.({ kind: 'event', event }),
    emitTick: () => listener?.({ kind: 'tick' }),
    unsubscribe,
  }
}

describe('minecraft game adapter world observations', () => {
  it('emits a hurt observation with adapter id, urgency, and dedupe key', () => {
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver, now: () => 1_000 })
    const observations: GameObservation[] = []
    adapter.observeWorld('session-1', observation => observations.push(observation))

    world.emit({ kind: 'hurt', health: 14, damage: 6 })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      sessionId: 'session-1',
      adapterId: 'minecraft',
      kind: minecraftObservationKinds.botHurt,
      urgency: 'high',
      observedAt: 1_000,
      text: 'Bot took 6 damage (health 14).',
      data: { health: 14, damage: 6 },
    })
    expect(observations[0].dedupeKey).toMatch(/^hurt:\d+$/)
    expect(observations[0].eventId).toMatch(/^minecraft:\d+$/)
    expect(observations[0].stateRevision).toBe('1')
  })

  it('reclassifies hurt as a player attack when the damage packet names a player', () => {
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver, now: () => 1_000 })
    const observations: GameObservation[] = []
    adapter.observeWorld('session-1', observation => observations.push(observation))

    world.emit({
      kind: 'hurt',
      health: 16,
      damage: 4,
      attacker: { type: 'player', username: 'Steve' },
    })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      kind: minecraftObservationKinds.playerAttack,
      urgency: 'high',
      text: 'Player Steve attacked the bot (4 damage, health 16).',
      data: { attacker: 'Steve', health: 16, damage: 4 },
    })
    expect(observations[0].dedupeKey).toMatch(/^player-attack:Steve:\d+$/)
  })

  it('classifies non-player attackers as mob attacks at normal urgency', () => {
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver, now: () => 1_000 })
    const observations: GameObservation[] = []
    adapter.observeWorld('session-1', observation => observations.push(observation))

    world.emit({
      kind: 'hurt',
      health: 17,
      damage: 3,
      attacker: { type: 'hostile', name: 'zombie' },
    })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      kind: minecraftObservationKinds.mobAttack,
      urgency: 'normal',
      data: { attacker: 'zombie' },
    })
  })

  it('emits a critical death observation', () => {
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver, now: () => 1_000 })
    const observations: GameObservation[] = []
    adapter.observeWorld('session-1', observation => observations.push(observation))

    world.emit({ kind: 'death', health: 0 })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      kind: minecraftObservationKinds.botDeath,
      urgency: 'critical',
      text: 'Bot died.',
    })
    expect(observations[0].dedupeKey).toMatch(/^death:\d+$/)
  })

  it('throttles repeated hurt bursts inside the throttle window', () => {
    let now = 1_000
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver, now: () => now })
    const observations: GameObservation[] = []
    adapter.observeWorld('session-1', observation => observations.push(observation))

    world.emit({ kind: 'hurt', health: 19, damage: 1 })
    world.emit({ kind: 'hurt', health: 18, damage: 1 })
    now = 2_500
    world.emit({ kind: 'hurt', health: 17, damage: 1 })

    expect(observations).toHaveLength(2)
    expect(observations[0].data).toMatchObject({ health: 19 })
    expect(observations[1].data).toMatchObject({ health: 17 })
  })

  it('fans one driver event out to every subscribed session', () => {
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver, now: () => 1_000 })
    const first: GameObservation[] = []
    const second: GameObservation[] = []
    adapter.observeWorld('session-1', observation => first.push(observation))
    adapter.observeWorld('session-2', observation => second.push(observation))

    world.emit({ kind: 'hurt', health: 14, damage: 6 })

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0].sessionId).toBe('session-1')
    expect(second[0].sessionId).toBe('session-2')
    expect(first[0].eventId).toBe(second[0].eventId)
    expect(first[0].dedupeKey).toBe(second[0].dedupeKey)
  })

  it('attaches the driver listener lazily and detaches after the last unsubscribe', () => {
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver })

    expect(world.driver.observeEnvironment).not.toHaveBeenCalled()

    const offA = adapter.observeWorld('session-1', () => {})
    const offB = adapter.observeWorld('session-2', () => {})
    expect(world.driver.observeEnvironment).toHaveBeenCalledTimes(1)

    offA()
    expect(world.unsubscribe).not.toHaveBeenCalled()
    offB()
    expect(world.unsubscribe).toHaveBeenCalledOnce()
  })

  it('re-attaches the driver listener when a new subscriber arrives after full teardown', () => {
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver, now: () => 1_000 })

    adapter.observeWorld('session-1', () => {})()
    const observations: GameObservation[] = []
    adapter.observeWorld('session-2', observation => observations.push(observation))
    world.emit({ kind: 'hurt', health: 10, damage: 10 })

    expect(world.driver.observeEnvironment).toHaveBeenCalledTimes(2)
    expect(observations).toHaveLength(1)
    expect(observations[0].sessionId).toBe('session-2')
  })
})

describe('minecraft game adapter environment', () => {
  it('returns a snapshot with freshness and revision without executing a capability', async () => {
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver, now: () => 5_000 })

    const snapshotResult = await adapter.getEnvironment('session-1')

    expect(snapshotResult).toEqual({
      sessionId: 'session-1',
      adapterId: 'minecraft',
      observedAt: 5_000,
      freshnessMs: 1_000,
      revision: '0',
      content: environment,
    })
    expect(world.driver.getSnapshot).not.toHaveBeenCalled()
  })

  it('advances the revision on world ticks and events', async () => {
    const world = createWorldDriver()
    const adapter = createWorldAdapter({ driver: world.driver, now: () => 1_000 })
    adapter.observeWorld('session-1', () => {})

    world.emitTick()
    world.emit({ kind: 'hurt', health: 19, damage: 1 })

    const snapshotResult = await adapter.getEnvironment('session-1')
    expect(snapshotResult.revision).toBe('2')
  })

  it('omits world surface entirely when the driver cannot sample', () => {
    const adapter = new MinecraftGameAdapter({
      driver: {
        getSnapshot: vi.fn(() => snapshot),
        follow: vi.fn(),
        stopFollow: vi.fn(),
      },
    })

    expect(adapter.getEnvironment).toBeUndefined()
    expect(adapter.observeWorld).toBeUndefined()
  })
})
