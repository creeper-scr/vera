import type {
  GameActionEvent,
  GameAdapter,
  GameObservation,
  Unsubscribe,
} from '@proj-vera/game-coop-core'
import type { WebSocketEventOptionalSource } from '@proj-vera/server-shared/types'

import type {
  Client,
} from './client'

import { errorMessageFrom } from '@moeru/std'
import { GameEnvironmentUnavailableError } from '@proj-vera/game-coop-core'

/**
 * Connects one game adapter to Vera's typed server-channel protocol.
 */
export interface GameCoopChannelOptions {
  client: Pick<Client, 'onEvent' | 'send'>
  adapter: GameAdapter
  /** Stable adapter id used by remote Stage proxies. */
  adapterId: string
}

/**
 * Routes capability, command, cancellation, and lifecycle messages for one adapter.
 *
 * Action destinations stay pinned to the requesting Stage route. Correlation is
 * keyed by `actionId`; cancellation additionally checks `sessionId`.
 */
export class GameCoopChannel {
  private readonly actionDestinations = new Map<string, string>()
  private readonly actionSessions = new Map<string, string>()
  private readonly eventUnsubscribers: Unsubscribe[] = []
  private readonly sessionUnsubscribers = new Map<string, Unsubscribe>()
  private readonly observationDestinations = new Map<string, Set<string>>()
  private readonly observationUnsubscribers = new Map<string, Unsubscribe>()
  private initialized = false

  constructor(private readonly options: GameCoopChannelOptions) {}

  public init(): void {
    if (this.initialized)
      return
    this.initialized = true

    this.eventUnsubscribers.push(
      this.options.client.onEvent('game:coop:capabilities:request', async ({ data }) => {
        if (data.adapterId !== this.options.adapterId)
          return

        try {
          const capabilities = await this.options.adapter.getCapabilities(data.sessionId)
          this.send({
            type: 'game:coop:capabilities',
            data: {
              requestId: data.requestId,
              sessionId: data.sessionId,
              adapterId: this.options.adapterId,
              capabilities,
              destinations: [data.replyTo],
            },
          })
        }
        catch (error) {
          this.send({
            type: 'game:coop:capabilities',
            data: {
              requestId: data.requestId,
              sessionId: data.sessionId,
              adapterId: this.options.adapterId,
              capabilities: [],
              error: errorMessageFrom(error) ?? `Failed to read "${this.options.adapterId}" capabilities`,
              destinations: [data.replyTo],
            },
          })
        }
      }),
      this.options.client.onEvent('game:coop:command', async ({ data }) => {
        if (data.adapterId !== this.options.adapterId)
          return

        this.ensureSessionObservation(data.command.sessionId)
        this.actionDestinations.set(data.command.actionId, data.replyTo)
        this.actionSessions.set(data.command.actionId, data.command.sessionId)
        await this.options.adapter.execute(data.command)
      }),
      this.options.client.onEvent('game:coop:cancel', async ({ data }) => {
        if (data.adapterId !== this.options.adapterId)
          return
        if (this.actionSessions.get(data.actionId) !== data.sessionId)
          return
        await this.options.adapter.cancel(data.actionId, data.reason)
      }),
      this.options.client.onEvent('game:coop:observation:subscribe', ({ data }) => {
        if (data.adapterId !== this.options.adapterId || this.options.adapter.observeWorld == null)
          return

        const destinations = this.observationDestinations.get(data.sessionId) ?? new Set<string>()
        destinations.add(data.replyTo)
        this.observationDestinations.set(data.sessionId, destinations)
        this.ensureWorldObservation(data.sessionId)
      }),
      this.options.client.onEvent('game:coop:observation:unsubscribe', ({ data }) => {
        if (data.adapterId !== this.options.adapterId)
          return

        const destinations = this.observationDestinations.get(data.sessionId)
        destinations?.delete(data.replyTo)
        if (destinations != null && destinations.size > 0)
          return

        this.observationDestinations.delete(data.sessionId)
        this.observationUnsubscribers.get(data.sessionId)?.()
        this.observationUnsubscribers.delete(data.sessionId)
      }),
      this.options.client.onEvent('game:coop:environment:request', async ({ data }) => {
        if (data.adapterId !== this.options.adapterId)
          return

        if (this.options.adapter.getEnvironment == null) {
          this.send({
            type: 'game:coop:environment',
            data: {
              requestId: data.requestId,
              sessionId: data.sessionId,
              adapterId: this.options.adapterId,
              unavailable: true,
              destinations: [data.replyTo],
            },
          })
          return
        }

        try {
          const environment = await this.options.adapter.getEnvironment(data.sessionId)
          this.send({
            type: 'game:coop:environment',
            data: {
              requestId: data.requestId,
              sessionId: data.sessionId,
              adapterId: this.options.adapterId,
              environment,
              destinations: [data.replyTo],
            },
          })
        }
        catch (error) {
          if (error instanceof GameEnvironmentUnavailableError) {
            this.send({
              type: 'game:coop:environment',
              data: {
                requestId: data.requestId,
                sessionId: data.sessionId,
                adapterId: this.options.adapterId,
                unavailable: true,
                destinations: [data.replyTo],
              },
            })
            return
          }
          this.sendEnvironmentError(
            data,
            errorMessageFrom(error) ?? `Failed to read "${this.options.adapterId}" environment`,
          )
        }
      }),
    )
  }

  public destroy(): void {
    if (!this.initialized)
      return
    this.initialized = false

    for (const unsubscribe of this.eventUnsubscribers)
      unsubscribe()
    this.eventUnsubscribers.length = 0

    for (const unsubscribe of this.sessionUnsubscribers.values())
      unsubscribe()
    this.sessionUnsubscribers.clear()
    for (const unsubscribe of this.observationUnsubscribers.values())
      unsubscribe()
    this.observationUnsubscribers.clear()
    this.observationDestinations.clear()
    this.actionDestinations.clear()
    this.actionSessions.clear()
  }

  private ensureSessionObservation(sessionId: string): void {
    if (this.sessionUnsubscribers.has(sessionId))
      return

    this.sessionUnsubscribers.set(
      sessionId,
      this.options.adapter.observe(sessionId, event => this.sendAction(event)),
    )
  }

  private sendAction(event: GameActionEvent): void {
    const destination = this.actionDestinations.get(event.actionId)
    if (destination == null)
      return

    this.send({
      type: 'game:coop:action',
      data: {
        adapterId: this.options.adapterId,
        event,
        destinations: [destination],
      },
    })

    if (event.state === 'succeeded' || event.state === 'failed' || event.state === 'cancelled') {
      this.actionDestinations.delete(event.actionId)
      this.actionSessions.delete(event.actionId)
    }
  }

  private ensureWorldObservation(sessionId: string): void {
    if (this.observationUnsubscribers.has(sessionId) || this.options.adapter.observeWorld == null)
      return

    this.observationUnsubscribers.set(
      sessionId,
      this.options.adapter.observeWorld(sessionId, observation => this.sendObservation(observation)),
    )
  }

  private sendObservation(observation: GameObservation): void {
    const destinations = this.observationDestinations.get(observation.sessionId)
    if (destinations == null || destinations.size === 0)
      return

    this.send({
      type: 'game:coop:observation',
      data: {
        adapterId: this.options.adapterId,
        observation,
        destinations: [...destinations],
      },
    })
  }

  private sendEnvironmentError(
    request: {
      requestId: string
      sessionId: string
      replyTo: string
    },
    error: string,
  ): void {
    this.send({
      type: 'game:coop:environment',
      data: {
        requestId: request.requestId,
        sessionId: request.sessionId,
        adapterId: this.options.adapterId,
        error,
        destinations: [request.replyTo],
      },
    })
  }

  private send(event: WebSocketEventOptionalSource): void {
    if (!this.options.client.send(event))
      throw new Error(`Failed to send "${event.type}" because Vera server channel is unavailable`)
  }
}
