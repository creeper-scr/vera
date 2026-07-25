import type {
  GameActionEvent,
  GameActionEventListener,
  GameAdapter,
  GameCapability,
  GameCommand,
  GameEnvironmentSnapshot,
  GameExecutionPort,
  GameObservation,
  GameObservationListener,
  Unsubscribe,
} from './contracts'

import { GAME_ACTION_TERMINAL_STATES, GameEnvironmentUnavailableError } from './contracts'

interface RegisteredAdapter {
  adapterId: string
  adapter: GameAdapter
}

interface ActionOwner {
  adapterId: string
  command: GameCommand
  cancellable: boolean
  state?: GameActionEvent['state']
}

/**
 * Builds the game-neutral execution port and its adapter registration surface.
 *
 * Catalog ownership is resolved per session because adapters may discover
 * capabilities at runtime. Active observers automatically subscribe to newly
 * registered adapters. Unregistering an adapter detaches its observers and
 * removes its cached capability routes; Core does not change.
 *
 * World observations (`observeWorld`) and environment reads (`getEnvironment`)
 * are optional per adapter and fan in through the same registry.
 */
export function createGameAdapterRegistry(): GameExecutionPort & {
  register: (registration: RegisteredAdapter) => Unsubscribe
} {
  const adapters = new Map<string, GameAdapter>()
  const capabilitiesBySession = new Map<string, Map<string, {
    adapterId: string
    capability: GameCapability
  }>>()
  const listenersBySession = new Map<string, Set<GameActionEventListener>>()
  const worldListenersBySession = new Map<string, Set<GameObservationListener>>()
  const subscriptionsBySession = new Map<string, Map<string, Unsubscribe>>()
  const worldSubscriptionsBySession = new Map<string, Map<string, Unsubscribe>>()
  const actionOwners = new Map<string, ActionOwner>()

  function forward(adapterId: string, event: GameActionEvent): void {
    const owner = actionOwners.get(event.actionId)
    if (owner == null || owner.adapterId !== adapterId)
      return

    const command = owner.command
    if (
      event.sessionId !== command.sessionId
      || event.turnId !== command.turnId
      || event.capabilityId !== command.capabilityId
    ) {
      throw new Error(`Adapter "${adapterId}" emitted mismatched correlation IDs for action "${event.actionId}"`)
    }

    if (owner.state != null && GAME_ACTION_TERMINAL_STATES.has(owner.state))
      return

    if (event.state !== 'snapshot') {
      const valid
        = owner.state == null
          ? event.state === 'queued'
          : owner.state === 'queued'
            ? event.state === 'running' || event.state === 'failed' || event.state === 'cancelled'
            : owner.state === 'running' || owner.state === 'progress'
              ? event.state === 'progress' || GAME_ACTION_TERMINAL_STATES.has(event.state)
              : false

      if (!valid) {
        throw new Error(
          `Invalid action transition for "${event.actionId}": ${owner.state ?? 'none'} -> ${event.state}`,
        )
      }
      owner.state = event.state
    }

    for (const listener of listenersBySession.get(event.sessionId) ?? [])
      listener(event)

    if (GAME_ACTION_TERMINAL_STATES.has(event.state))
      actionOwners.delete(event.actionId)
  }

  function forwardObservation(adapterId: string, observation: GameObservation): void {
    if (observation.adapterId !== adapterId) {
      throw new Error(
        `Adapter "${adapterId}" emitted observation with mismatched adapterId "${observation.adapterId}"`,
      )
    }
    for (const listener of worldListenersBySession.get(observation.sessionId) ?? [])
      listener(observation)
  }

  function subscribe(sessionId: string, adapterId: string, adapter: GameAdapter): void {
    const subscriptions = subscriptionsBySession.get(sessionId) ?? new Map<string, Unsubscribe>()
    if (subscriptions.has(adapterId))
      return

    subscriptions.set(adapterId, adapter.observe(sessionId, event => forward(adapterId, event)))
    subscriptionsBySession.set(sessionId, subscriptions)
  }

  function subscribeWorld(sessionId: string, adapterId: string, adapter: GameAdapter): void {
    if (adapter.observeWorld == null)
      return

    const subscriptions = worldSubscriptionsBySession.get(sessionId) ?? new Map<string, Unsubscribe>()
    if (subscriptions.has(adapterId))
      return

    subscriptions.set(
      adapterId,
      adapter.observeWorld(sessionId, observation => forwardObservation(adapterId, observation)),
    )
    worldSubscriptionsBySession.set(sessionId, subscriptions)
  }

  function register({ adapterId, adapter }: RegisteredAdapter): Unsubscribe {
    if (adapters.has(adapterId))
      throw new Error(`Game adapter "${adapterId}" is already registered`)

    adapters.set(adapterId, adapter)
    for (const sessionId of listenersBySession.keys())
      subscribe(sessionId, adapterId, adapter)
    for (const sessionId of worldListenersBySession.keys())
      subscribeWorld(sessionId, adapterId, adapter)

    let registered = true
    return () => {
      if (!registered)
        return
      registered = false
      adapters.delete(adapterId)

      for (const subscriptions of subscriptionsBySession.values()) {
        subscriptions.get(adapterId)?.()
        subscriptions.delete(adapterId)
      }
      for (const subscriptions of worldSubscriptionsBySession.values()) {
        subscriptions.get(adapterId)?.()
        subscriptions.delete(adapterId)
      }

      for (const capabilities of capabilitiesBySession.values()) {
        for (const [capabilityId, owner] of capabilities) {
          if (owner.adapterId === adapterId)
            capabilities.delete(capabilityId)
        }
      }
    }
  }

  async function getCapabilities(sessionId: string): Promise<GameCapability[]> {
    const catalog = new Map<string, { adapterId: string, capability: GameCapability }>()

    for (const [adapterId, adapter] of adapters) {
      subscribe(sessionId, adapterId, adapter)
      for (const capability of await adapter.getCapabilities(sessionId)) {
        const existing = catalog.get(capability.capabilityId)
        if (existing != null) {
          throw new Error(
            `Capability "${capability.capabilityId}" is declared by both "${existing.adapterId}" and "${adapterId}"`,
          )
        }
        catalog.set(capability.capabilityId, { adapterId, capability })
      }
    }

    capabilitiesBySession.set(sessionId, catalog)
    return [...catalog.values()].map(({ capability }) => capability)
  }

  function observe(sessionId: string, listener: GameActionEventListener): Unsubscribe {
    const listeners = listenersBySession.get(sessionId) ?? new Set<GameActionEventListener>()
    listeners.add(listener)
    listenersBySession.set(sessionId, listeners)

    for (const [adapterId, adapter] of adapters)
      subscribe(sessionId, adapterId, adapter)

    return () => {
      listeners.delete(listener)
      if (listeners.size > 0)
        return

      listenersBySession.delete(sessionId)
      const subscriptions = subscriptionsBySession.get(sessionId)
      for (const unsubscribe of subscriptions?.values() ?? [])
        unsubscribe()
      subscriptionsBySession.delete(sessionId)
    }
  }

  function observeWorld(sessionId: string, listener: GameObservationListener): Unsubscribe {
    const listeners = worldListenersBySession.get(sessionId) ?? new Set<GameObservationListener>()
    listeners.add(listener)
    worldListenersBySession.set(sessionId, listeners)

    for (const [adapterId, adapter] of adapters)
      subscribeWorld(sessionId, adapterId, adapter)

    return () => {
      listeners.delete(listener)
      if (listeners.size > 0)
        return

      worldListenersBySession.delete(sessionId)
      const subscriptions = worldSubscriptionsBySession.get(sessionId)
      for (const unsubscribe of subscriptions?.values() ?? [])
        unsubscribe()
      worldSubscriptionsBySession.delete(sessionId)
    }
  }

  async function getEnvironment(sessionId: string): Promise<GameEnvironmentSnapshot> {
    const snapshots: GameEnvironmentSnapshot[] = []
    for (const [adapterId, adapter] of adapters) {
      if (adapter.getEnvironment == null)
        continue
      const snapshot = await adapter.getEnvironment(sessionId)
      if (snapshot.sessionId !== sessionId) {
        throw new Error(
          `Adapter "${adapterId}" returned environment for session "${snapshot.sessionId}"`,
        )
      }
      if (snapshot.adapterId !== adapterId) {
        throw new Error(
          `Adapter "${adapterId}" returned environment with mismatched adapterId "${snapshot.adapterId}"`,
        )
      }
      snapshots.push(snapshot)
    }

    if (snapshots.length === 0)
      throw new GameEnvironmentUnavailableError(sessionId)

    if (snapshots.length === 1)
      return snapshots[0]!

    // Multi-adapter: merge under adapterId keys; revision is a joined token so
    // any child revision bump invalidates the composite cache.
    const observedAt = Math.min(...snapshots.map(item => item.observedAt))
    const freshnessMs = Math.min(...snapshots.map(item => item.freshnessMs))
    return {
      sessionId,
      adapterId: 'registry',
      observedAt,
      freshnessMs,
      revision: snapshots.map(item => `${item.adapterId}:${item.revision}`).join('|'),
      content: Object.fromEntries(
        snapshots.map(item => [item.adapterId, item.content]),
      ),
    }
  }

  async function execute(command: GameCommand): Promise<void> {
    if (actionOwners.has(command.actionId))
      throw new Error(`Action "${command.actionId}" already exists`)

    let owner = capabilitiesBySession.get(command.sessionId)?.get(command.capabilityId)
    if (owner == null) {
      await getCapabilities(command.sessionId)
      owner = capabilitiesBySession.get(command.sessionId)?.get(command.capabilityId)
    }
    if (owner == null)
      throw new Error(`Capability "${command.capabilityId}" is unavailable for session "${command.sessionId}"`)

    actionOwners.set(command.actionId, {
      adapterId: owner.adapterId,
      command,
      cancellable: owner.capability.cancellable,
    })

    const adapter = adapters.get(owner.adapterId)
    if (adapter == null) {
      actionOwners.delete(command.actionId)
      throw new Error(`Game adapter "${owner.adapterId}" is no longer registered`)
    }

    try {
      await adapter.execute(command)
    }
    catch (error) {
      actionOwners.delete(command.actionId)
      throw error
    }
  }

  async function cancel(actionId: string, reason?: string): Promise<void> {
    const owner = actionOwners.get(actionId)
    if (owner == null)
      throw new Error(`Action "${actionId}" does not exist`)
    if (owner.state != null && GAME_ACTION_TERMINAL_STATES.has(owner.state))
      return
    if (!owner.cancellable)
      throw new Error(`Action "${actionId}" is not cancellable`)

    const adapter = adapters.get(owner.adapterId)
    if (adapter == null)
      throw new Error(`Game adapter "${owner.adapterId}" is no longer registered`)
    await adapter.cancel(actionId, reason)
  }

  return {
    register,
    getCapabilities,
    observe,
    observeWorld,
    getEnvironment,
    execute,
    cancel,
  }
}
