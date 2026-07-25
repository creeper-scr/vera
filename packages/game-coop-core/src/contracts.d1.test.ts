import type {
  GameAdapter,
  GameCapability,
  GameCommand,
  GameEnvironmentSnapshot,
  GameObservation,
} from './contracts'

import { describe, expect, it, vi } from 'vitest'

import {
  GAME_ACTION_TERMINAL_STATES,
  isGameActionTerminalState,
} from './contracts'
import { createGameAdapterRegistry } from './registry'

function capability(capabilityId: string): GameCapability {
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
    cancellable: true,
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

describe('game-coop-core D1 contracts', () => {
  it('classifies terminal action states for ownership settlement', () => {
    expect(isGameActionTerminalState('succeeded')).toBe(true)
    expect(isGameActionTerminalState('failed')).toBe(true)
    expect(isGameActionTerminalState('cancelled')).toBe(true)
    expect(isGameActionTerminalState('queued')).toBe(false)
    expect(isGameActionTerminalState('running')).toBe(false)
    expect(isGameActionTerminalState('progress')).toBe(false)
    expect(isGameActionTerminalState('snapshot')).toBe(false)
    expect(GAME_ACTION_TERMINAL_STATES.has('succeeded')).toBe(true)
  })

  it('fans world observations from adapters without action correlation', () => {
    const registry = createGameAdapterRegistry()
    const listeners = new Set<(observation: GameObservation) => void>()
    const adapter: GameAdapter = {
      getCapabilities: vi.fn(async () => [capability('game.follow')]),
      observe: vi.fn(() => () => {}),
      observeWorld: vi.fn((_sessionId, listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      execute: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    }
    registry.register({ adapterId: 'demo', adapter })

    const received: GameObservation[] = []
    const unsubscribe = registry.observeWorld!('session-1', observation => received.push(observation))

    const observation: GameObservation = {
      sessionId: 'session-1',
      eventId: 'obs-1',
      adapterId: 'demo',
      observedAt: 1_000,
      kind: 'hurt',
      urgency: 'high',
      text: 'Bot took damage',
      data: { health: 8 },
      dedupeKey: 'hurt:demo',
      stateRevision: 'r1',
    }
    for (const listener of listeners)
      listener(observation)

    expect(received).toEqual([observation])
    unsubscribe()
  })

  it('rejects world observations with mismatched adapter ownership', () => {
    const registry = createGameAdapterRegistry()
    let emit: ((observation: GameObservation) => void) | undefined
    const adapter: GameAdapter = {
      getCapabilities: vi.fn(async () => []),
      observe: vi.fn(() => () => {}),
      observeWorld: vi.fn((_sessionId, listener) => {
        emit = listener
        return () => {
          emit = undefined
        }
      }),
      execute: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    }
    registry.register({ adapterId: 'demo', adapter })
    registry.observeWorld!('session-1', () => {})

    expect(() => emit?.({
      sessionId: 'session-1',
      eventId: 'obs-1',
      adapterId: 'other',
      observedAt: 1,
      kind: 'hurt',
      urgency: 'high',
      text: 'wrong owner',
    })).toThrow(/mismatched adapterId/)
  })

  it('reads environment through adapter getEnvironment without status tools', async () => {
    const registry = createGameAdapterRegistry()
    const snapshot: GameEnvironmentSnapshot = {
      sessionId: 'session-1',
      adapterId: 'demo',
      observedAt: 1_000,
      freshnessMs: 5_000,
      revision: 'rev-1',
      content: { health: 10 },
    }
    const adapter: GameAdapter = {
      getCapabilities: vi.fn(async () => [capability('game.follow')]),
      observe: vi.fn(() => () => {}),
      getEnvironment: vi.fn(async () => snapshot),
      execute: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    }
    registry.register({ adapterId: 'demo', adapter })

    await expect(registry.getEnvironment!('session-1')).resolves.toEqual(snapshot)
    expect(adapter.execute).not.toHaveBeenCalled()
  })

  it('merges multi-adapter environment snapshots under adapter ids', async () => {
    const registry = createGameAdapterRegistry()
    const left: GameAdapter = {
      getCapabilities: vi.fn(async () => []),
      observe: vi.fn(() => () => {}),
      getEnvironment: vi.fn(async () => ({
        sessionId: 'session-1',
        adapterId: 'left',
        observedAt: 1_000,
        freshnessMs: 4_000,
        revision: 'l1',
        content: { a: 1 },
      })),
      execute: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    }
    const right: GameAdapter = {
      getCapabilities: vi.fn(async () => []),
      observe: vi.fn(() => () => {}),
      getEnvironment: vi.fn(async () => ({
        sessionId: 'session-1',
        adapterId: 'right',
        observedAt: 1_200,
        freshnessMs: 3_000,
        revision: 'r1',
        content: { b: 2 },
      })),
      execute: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    }
    registry.register({ adapterId: 'left', adapter: left })
    registry.register({ adapterId: 'right', adapter: right })

    await expect(registry.getEnvironment!('session-1')).resolves.toEqual({
      sessionId: 'session-1',
      adapterId: 'registry',
      observedAt: 1_000,
      freshnessMs: 3_000,
      revision: 'left:l1|right:r1',
      content: {
        left: { a: 1 },
        right: { b: 2 },
      },
    })
  })

  it('still routes action lifecycle and cancellation for existing adapters', async () => {
    const registry = createGameAdapterRegistry()
    const actionListeners = new Map<string, Set<(event: import('./contracts').GameActionEvent) => void>>()
    const adapter: GameAdapter = {
      getCapabilities: vi.fn(async () => [capability('game.follow')]),
      observe: vi.fn((sessionId, listener) => {
        const set = actionListeners.get(sessionId) ?? new Set()
        set.add(listener)
        actionListeners.set(sessionId, set)
        return () => set.delete(listener)
      }),
      execute: vi.fn(async (cmd) => {
        for (const listener of actionListeners.get(cmd.sessionId) ?? []) {
          listener({
            sessionId: cmd.sessionId,
            turnId: cmd.turnId,
            actionId: cmd.actionId,
            capabilityId: cmd.capabilityId,
            timestamp: 1,
            state: 'queued',
          })
          listener({
            sessionId: cmd.sessionId,
            turnId: cmd.turnId,
            actionId: cmd.actionId,
            capabilityId: cmd.capabilityId,
            timestamp: 2,
            state: 'running',
          })
          listener({
            sessionId: cmd.sessionId,
            turnId: cmd.turnId,
            actionId: cmd.actionId,
            capabilityId: cmd.capabilityId,
            timestamp: 3,
            state: 'succeeded',
            result: { ok: true },
          })
        }
      }),
      cancel: vi.fn(async () => {}),
    }
    registry.register({ adapterId: 'demo', adapter })

    const events: string[] = []
    registry.observe('session-1', event => events.push(event.state))
    await registry.execute(command('game.follow'))
    expect(events).toEqual(['queued', 'running', 'succeeded'])
  })
})
