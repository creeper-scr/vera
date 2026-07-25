import type {
  GameActionEvent,
  GameActionEventListener,
  GameAdapter,
  GameCapability,
  GameCommand,
  GameEnvironmentSnapshot,
  GameObservationListener,
  Unsubscribe,
} from '@proj-vera/game-coop-core'
import type {
  WebSocketBaseEvent,
  WebSocketEventOptionalSource,
  WebSocketEvents,
} from '@proj-vera/server-sdk'

import { GameEnvironmentUnavailableError } from '@proj-vera/game-coop-core'
import { nanoid } from 'nanoid'

type GameCoopEventType
  = | 'extension:module:de-announced'
    | 'game:coop:capabilities'
    | 'game:coop:action'
    | 'game:coop:environment'
    | 'game:coop:observation'

/**
 * Server-channel surface needed by the remote game adapter proxy.
 *
 * The Stage channel store satisfies this interface without exposing Pinia or
 * Vue to Core or game adapters.
 */
export interface GameCoopServerChannel {
  isConnected: () => boolean
  send: (event: WebSocketEventOptionalSource) => void
  onEvent: <E extends GameCoopEventType>(
    type: E,
    listener: (event: WebSocketBaseEvent<E, WebSocketEvents[E]>) => void | Promise<void>,
  ) => Unsubscribe
  onDisconnected: (listener: (reason?: string) => void) => Unsubscribe
}

export interface ServerGameAdapterOptions {
  channel: GameCoopServerChannel
  adapterId: string
  /** Server route selector for the remote game service module. */
  destination: string
  /** Server route selector for lifecycle events returning to this Stage host. */
  replyTo: string
  /**
   * Maximum time to wait for one capability response.
   * @default 5_000
   */
  requestTimeoutMs?: number
  /**
   * Maximum time from command send until its correlated `queued` event.
   * @default requestTimeoutMs
   */
  actionAckTimeoutMs?: number
  /**
   * Optional maximum time from `queued` until a terminal lifecycle event.
   *
   * Leave unset for adapters with legitimately unbounded actions.
   * @default undefined
   */
  actionTerminalTimeoutMs?: number
  /**
   * Treats an absent remote module as an empty dynamic catalog.
   * @default false
   */
  unavailableAsEmpty?: boolean
}

interface RemoteAction {
  command: GameCommand
  acknowledged: boolean
  remoteModuleIdentityId: string
  acknowledge: () => void
  rejectAcknowledgement: (error: Error) => void
  acknowledgementTimeout: ReturnType<typeof setTimeout>
  terminalTimeout?: ReturnType<typeof setTimeout>
}

/**
 * Presents one remote server-channel game service as a local GameAdapter.
 *
 * Capability requests correlate by `requestId + sessionId + adapterId`.
 * Lifecycle events correlate by the IDs already carried by GameActionEvent.
 *
 * State model:
 * - a capability response pins its concrete remote module instance to the session.
 * - `execute()` owns an unacknowledged command until its correlated `queued`.
 * - acknowledged actions remain tracked through terminal event, transport
 *   disconnect, or de-announcement of their exact remote module instance.
 * - removing the last voice observer never cancels an acknowledged action;
 *   its channel subscription stays alive until that action terminates.
 */
export class ServerGameAdapter implements GameAdapter {
  private readonly actions = new Map<string, RemoteAction>()
  private readonly listenersBySession = new Map<string, Set<GameActionEventListener>>()
  private readonly observationListenersBySession = new Map<string, Set<GameObservationListener>>()
  private readonly remoteModuleIdentityIdsBySession = new Map<string, string>()
  private readonly subscriptionsBySession = new Map<string, Unsubscribe>()
  private readonly observationSubscriptionsBySession = new Map<string, Unsubscribe>()
  private readonly observationRemoteIdentityBySession = new Map<string, string>()
  private readonly requestTimeoutMs: number
  private readonly actionAckTimeoutMs: number
  private readonly actionTerminalTimeoutMs: number | undefined
  private unsubscribeDisconnect: Unsubscribe | undefined
  private unsubscribeRemoteUnavailable: Unsubscribe | undefined

  constructor(private readonly options: ServerGameAdapterOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
    this.actionAckTimeoutMs = options.actionAckTimeoutMs ?? this.requestTimeoutMs
    this.actionTerminalTimeoutMs = options.actionTerminalTimeoutMs
  }

  public getCapabilities(sessionId: string): Promise<GameCapability[]> {
    if (!this.options.channel.isConnected()) {
      if (this.options.unavailableAsEmpty)
        return Promise.resolve([])
      return Promise.reject(new Error('Server channel is disconnected'))
    }

    const selectedRemoteModuleIdentityId = this.remoteModuleIdentityIdsBySession.get(sessionId)
    const requestId = nanoid()

    return new Promise<GameCapability[]>((resolve, reject) => {
      let settled = false
      let unsubscribe: Unsubscribe = () => {}
      const timeout = setTimeout(() => {
        if (settled)
          return
        settled = true
        unsubscribe()
        if (this.options.unavailableAsEmpty) {
          resolve([])
          return
        }
        reject(new Error(`Timed out waiting for game adapter "${this.options.adapterId}" capabilities`))
      }, this.requestTimeoutMs)

      unsubscribe = this.options.channel.onEvent('game:coop:capabilities', ({ data, metadata }) => {
        if (
          data.requestId !== requestId
          || data.sessionId !== sessionId
          || data.adapterId !== this.options.adapterId
        ) {
          return
        }

        const currentRemoteModuleIdentityId = this.remoteModuleIdentityIdsBySession.get(sessionId)
        // A refresh cannot replace live session affinity or resurrect a de-announced instance.
        if (selectedRemoteModuleIdentityId != null) {
          if (
            currentRemoteModuleIdentityId !== selectedRemoteModuleIdentityId
            || metadata.source.id !== selectedRemoteModuleIdentityId
          ) {
            return
          }
        }
        else if (
          currentRemoteModuleIdentityId != null
          && currentRemoteModuleIdentityId !== metadata.source.id
        ) {
          return
        }

        settled = true
        clearTimeout(timeout)
        unsubscribe()
        if (data.error != null) {
          reject(new Error(data.error))
          return
        }
        this.remoteModuleIdentityIdsBySession.set(sessionId, metadata.source.id)
        this.ensureAvailabilitySubscriptions()
        if (this.observationListenersBySession.has(sessionId))
          void this.startRemoteObservation(sessionId).catch(() => {})
        resolve(data.capabilities)
      })

      this.options.channel.send({
        type: 'game:coop:capabilities:request',
        data: {
          requestId,
          sessionId,
          adapterId: this.options.adapterId,
          replyTo: this.options.replyTo,
          destinations: [
            selectedRemoteModuleIdentityId == null
              ? this.options.destination
              : `instance:${selectedRemoteModuleIdentityId}`,
          ],
        },
      })
    })
  }

  public observe(sessionId: string, listener: GameActionEventListener): Unsubscribe {
    const listeners = this.listenersBySession.get(sessionId) ?? new Set<GameActionEventListener>()
    listeners.add(listener)
    this.listenersBySession.set(sessionId, listeners)
    this.ensureSessionSubscription(sessionId)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0)
        this.listenersBySession.delete(sessionId)
      this.releaseSessionSubscription(sessionId)
    }
  }

  public observeWorld(sessionId: string, listener: GameObservationListener): Unsubscribe {
    const listeners = this.observationListenersBySession.get(sessionId) ?? new Set<GameObservationListener>()
    listeners.add(listener)
    this.observationListenersBySession.set(sessionId, listeners)
    this.ensureObservationSubscription(sessionId)
    // Subscription contract is synchronous. Capability discovery remains
    // best-effort here; a later successful capability refresh retries it.
    void this.startRemoteObservation(sessionId).catch(() => {})

    return () => {
      listeners.delete(listener)
      if (listeners.size > 0)
        return

      this.observationListenersBySession.delete(sessionId)
      this.stopRemoteObservation(sessionId)
      this.observationSubscriptionsBySession.get(sessionId)?.()
      this.observationSubscriptionsBySession.delete(sessionId)
      this.releaseSessionSubscription(sessionId)
    }
  }

  public async getEnvironment(sessionId: string): Promise<GameEnvironmentSnapshot> {
    if (!this.options.channel.isConnected())
      throw new Error('Server channel is disconnected')

    if (this.remoteModuleIdentityIdsBySession.get(sessionId) == null)
      await this.getCapabilities(sessionId)
    const remoteModuleIdentityId = this.remoteModuleIdentityIdsBySession.get(sessionId)
    if (remoteModuleIdentityId == null) {
      throw new Error(
        `Remote game adapter "${this.options.adapterId}" has no selected instance for session "${sessionId}"`,
      )
    }

    const requestId = nanoid()
    return new Promise<GameEnvironmentSnapshot>((resolve, reject) => {
      let settled = false
      let unsubscribe: Unsubscribe = () => {}
      let unsubscribeDisconnect: Unsubscribe = () => {}
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = (environment?: GameEnvironmentSnapshot, error?: Error) => {
        if (settled)
          return
        settled = true
        if (timeout != null)
          clearTimeout(timeout)
        unsubscribe()
        unsubscribeDisconnect()
        if (error)
          reject(error)
        else
          resolve(environment!)
      }
      timeout = setTimeout(() => {
        finish(undefined, new Error(`Timed out waiting for game adapter "${this.options.adapterId}" environment`))
      }, this.requestTimeoutMs)

      unsubscribe = this.options.channel.onEvent('game:coop:environment', ({ data, metadata }) => {
        if (
          data.requestId !== requestId
          || data.sessionId !== sessionId
          || data.adapterId !== this.options.adapterId
          || metadata.source.id !== remoteModuleIdentityId
        ) {
          return
        }
        if (data.error != null) {
          finish(undefined, new Error(data.error))
          return
        }
        if (data.unavailable === true) {
          finish(undefined, new GameEnvironmentUnavailableError(sessionId))
          return
        }
        if (data.environment == null) {
          finish(undefined, new Error('Remote game adapter returned no environment snapshot'))
          return
        }
        if (
          data.environment.sessionId !== sessionId
          || data.environment.adapterId !== this.options.adapterId
        ) {
          finish(undefined, new Error('Remote game adapter returned mismatched environment correlation IDs'))
          return
        }
        finish(data.environment)
      })
      unsubscribeDisconnect = this.options.channel.onDisconnected((reason) => {
        finish(undefined, new Error(reason ?? 'Server channel disconnected'))
      })
      this.options.channel.send({
        type: 'game:coop:environment:request',
        data: {
          requestId,
          sessionId,
          adapterId: this.options.adapterId,
          replyTo: this.options.replyTo,
          destinations: [`instance:${remoteModuleIdentityId}`],
        },
      })
    })
  }

  public execute(command: GameCommand): Promise<void> {
    if (this.actions.has(command.actionId))
      return Promise.reject(new Error(`Remote game action "${command.actionId}" already exists`))
    if (!this.options.channel.isConnected())
      return Promise.reject(new Error('Server channel is disconnected'))

    const remoteModuleIdentityId = this.remoteModuleIdentityIdsBySession.get(command.sessionId)
    if (remoteModuleIdentityId == null) {
      return Promise.reject(
        new Error(`Remote game adapter "${this.options.adapterId}" has no selected instance for session "${command.sessionId}"`),
      )
    }

    this.ensureSessionSubscription(command.sessionId)
    this.ensureAvailabilitySubscriptions()

    return new Promise<void>((resolve, reject) => {
      const acknowledgementTimeout = setTimeout(() => {
        const action = this.actions.get(command.actionId)
        if (action == null || action.acknowledged)
          return

        const error = new Error(
          `Timed out waiting for remote game action "${command.actionId}" acknowledgement`,
        )
        action.rejectAcknowledgement(error)
        this.deleteAction(command.actionId)
      }, this.actionAckTimeoutMs)

      this.actions.set(command.actionId, {
        command,
        acknowledged: false,
        remoteModuleIdentityId,
        acknowledge: resolve,
        rejectAcknowledgement: reject,
        acknowledgementTimeout,
      })
      this.options.channel.send({
        type: 'game:coop:command',
        data: {
          adapterId: this.options.adapterId,
          command,
          replyTo: this.options.replyTo,
          destinations: [`instance:${remoteModuleIdentityId}`],
        },
      })
    })
  }

  public async cancel(actionId: string, reason?: string): Promise<void> {
    const action = this.actions.get(actionId)
    if (action == null)
      throw new Error(`Remote game action "${actionId}" does not exist`)

    this.options.channel.send({
      type: 'game:coop:cancel',
      data: {
        adapterId: this.options.adapterId,
        sessionId: action.command.sessionId,
        actionId,
        reason,
        destinations: [`instance:${action.remoteModuleIdentityId}`],
      },
    })
  }

  private ensureSessionSubscription(sessionId: string): void {
    if (this.subscriptionsBySession.has(sessionId))
      return

    this.subscriptionsBySession.set(
      sessionId,
      this.options.channel.onEvent('game:coop:action', ({ data, metadata }) => {
        if (data.adapterId !== this.options.adapterId || data.event.sessionId !== sessionId)
          return
        this.handleActionEvent(data.event, metadata.source.id)
      }),
    )
  }

  private ensureObservationSubscription(sessionId: string): void {
    if (this.observationSubscriptionsBySession.has(sessionId))
      return

    this.observationSubscriptionsBySession.set(
      sessionId,
      this.options.channel.onEvent('game:coop:observation', ({ data, metadata }) => {
        if (
          data.adapterId !== this.options.adapterId
          || data.observation.sessionId !== sessionId
          || metadata.source.id !== this.observationRemoteIdentityBySession.get(sessionId)
        ) {
          return
        }
        for (const listener of this.observationListenersBySession.get(sessionId) ?? [])
          listener(data.observation)
      }),
    )
  }

  private async startRemoteObservation(sessionId: string): Promise<void> {
    if (this.observationRemoteIdentityBySession.has(sessionId))
      return
    if (this.remoteModuleIdentityIdsBySession.get(sessionId) == null)
      await this.getCapabilities(sessionId)
    if (this.observationRemoteIdentityBySession.has(sessionId))
      return
    if (!this.observationListenersBySession.has(sessionId))
      return

    const remoteModuleIdentityId = this.remoteModuleIdentityIdsBySession.get(sessionId)
    if (remoteModuleIdentityId == null)
      return
    this.observationRemoteIdentityBySession.set(sessionId, remoteModuleIdentityId)
    this.options.channel.send({
      type: 'game:coop:observation:subscribe',
      data: {
        adapterId: this.options.adapterId,
        sessionId,
        replyTo: this.options.replyTo,
        destinations: [`instance:${remoteModuleIdentityId}`],
      },
    })
  }

  private stopRemoteObservation(sessionId: string): void {
    const remoteModuleIdentityId = this.observationRemoteIdentityBySession.get(sessionId)
    if (remoteModuleIdentityId == null)
      return
    this.observationRemoteIdentityBySession.delete(sessionId)
    if (!this.options.channel.isConnected())
      return
    this.options.channel.send({
      type: 'game:coop:observation:unsubscribe',
      data: {
        adapterId: this.options.adapterId,
        sessionId,
        replyTo: this.options.replyTo,
        destinations: [`instance:${remoteModuleIdentityId}`],
      },
    })
  }

  private releaseSessionSubscription(sessionId: string): void {
    if (this.listenersBySession.has(sessionId) || this.observationListenersBySession.has(sessionId))
      return
    for (const action of this.actions.values()) {
      if (action.command.sessionId === sessionId)
        return
    }

    this.subscriptionsBySession.get(sessionId)?.()
    this.subscriptionsBySession.delete(sessionId)
    this.remoteModuleIdentityIdsBySession.delete(sessionId)
    this.releaseAvailabilitySubscriptions()
  }

  private handleActionEvent(event: GameActionEvent, remoteModuleIdentityId: string): void {
    const action = this.actions.get(event.actionId)
    if (action == null || action.remoteModuleIdentityId !== remoteModuleIdentityId)
      return
    const command = action.command
    if (
      event.sessionId !== command.sessionId
      || event.turnId !== command.turnId
      || event.capabilityId !== command.capabilityId
    ) {
      const error = new Error(`Remote game action "${event.actionId}" returned mismatched correlation IDs`)
      if (!action.acknowledged)
        action.rejectAcknowledgement(error)
      this.deleteAction(event.actionId)
      throw error
    }

    for (const listener of this.listenersBySession.get(event.sessionId) ?? [])
      listener(event)

    if (!action.acknowledged && event.state === 'queued') {
      action.acknowledged = true
      clearTimeout(action.acknowledgementTimeout)
      action.acknowledge()
      if (this.actionTerminalTimeoutMs != null) {
        action.terminalTimeout = setTimeout(() => {
          this.failAcknowledgedAction(
            event.actionId,
            `Timed out waiting for remote game action "${event.actionId}" terminal event`,
          )
        }, this.actionTerminalTimeoutMs)
      }
    }

    if (event.state === 'succeeded' || event.state === 'failed' || event.state === 'cancelled')
      this.deleteAction(event.actionId)
  }

  private ensureAvailabilitySubscriptions(): void {
    if (this.unsubscribeDisconnect || this.unsubscribeRemoteUnavailable)
      return

    this.unsubscribeDisconnect = this.options.channel.onDisconnected((reason) => {
      const message = reason ?? 'Server channel disconnected'
      this.remoteModuleIdentityIdsBySession.clear()
      this.observationRemoteIdentityBySession.clear()
      for (const [actionId, action] of this.actions) {
        if (action.acknowledged) {
          this.failAcknowledgedAction(actionId, message)
        }
        else {
          action.rejectAcknowledgement(new Error(message))
          this.deleteAction(actionId)
        }
      }
      this.releaseAvailabilitySubscriptions()
    })
    this.unsubscribeRemoteUnavailable = this.options.channel.onEvent(
      'extension:module:de-announced',
      ({ data }) => {
        if (this.options.destination !== `module:${data.name}`)
          return

        const message = `Remote game adapter "${this.options.adapterId}" became unavailable: ${data.reason ?? 'module disconnected'}`
        for (const [sessionId, remoteModuleIdentityId] of this.remoteModuleIdentityIdsBySession) {
          if (remoteModuleIdentityId === data.identity.id)
            this.remoteModuleIdentityIdsBySession.delete(sessionId)
        }
        for (const [sessionId, remoteModuleIdentityId] of this.observationRemoteIdentityBySession) {
          if (remoteModuleIdentityId === data.identity.id)
            this.observationRemoteIdentityBySession.delete(sessionId)
        }
        for (const [actionId, action] of this.actions) {
          if (action.remoteModuleIdentityId !== data.identity.id)
            continue
          if (action.acknowledged) {
            this.failAcknowledgedAction(actionId, message)
          }
          else {
            action.rejectAcknowledgement(new Error(message))
            this.deleteAction(actionId)
          }
        }
        this.releaseAvailabilitySubscriptions()
      },
    )
  }

  private failAcknowledgedAction(actionId: string, error: string): void {
    const action = this.actions.get(actionId)
    if (action == null || !action.acknowledged)
      return

    const event: GameActionEvent = {
      ...action.command,
      timestamp: Date.now(),
      state: 'failed',
      error,
    }
    for (const listener of this.listenersBySession.get(action.command.sessionId) ?? [])
      listener(event)
    this.deleteAction(actionId)
  }

  private deleteAction(actionId: string): void {
    const action = this.actions.get(actionId)
    if (action == null)
      return
    clearTimeout(action.acknowledgementTimeout)
    if (action.terminalTimeout)
      clearTimeout(action.terminalTimeout)
    this.actions.delete(actionId)
    this.releaseSessionSubscription(action.command.sessionId)
    this.releaseAvailabilitySubscriptions()
  }

  private releaseAvailabilitySubscriptions(): void {
    if (
      this.actions.size > 0
      || this.remoteModuleIdentityIdsBySession.size > 0
      || this.observationRemoteIdentityBySession.size > 0
    ) {
      return
    }

    this.unsubscribeDisconnect?.()
    this.unsubscribeDisconnect = undefined
    this.unsubscribeRemoteUnavailable?.()
    this.unsubscribeRemoteUnavailable = undefined
  }
}
