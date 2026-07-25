import type {
  GameActionEvent,
  GameCapability,
  GameCommand,
  GameCommandInput,
  GameExecutionPort,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import type { AgentUtterance, UserTurn } from './interaction'

/** Command decision derived from one user turn and the live capability catalog. */
export interface GameIntentResolution {
  capabilityId: string
  input: GameCommandInput
}

export interface ResolveGameIntentInput {
  turn: UserTurn
  capabilities: GameCapability[]
}

export interface DescribeGameActionInput {
  turn: UserTurn
  command: GameCommand
  capability: GameCapability
  event: GameActionEvent
}

/**
 * Policy boundary between natural-language interpretation and Core execution.
 *
 * Implementations may use rules or an LLM. They receive only the current
 * adapter catalog; Core never imports game capability IDs.
 */
export interface GameIntentPolicy {
  resolve: (input: ResolveGameIntentInput) => Promise<GameIntentResolution | null>
  describeAction: (input: DescribeGameActionInput) => string | null
}

/** Context presented to Integration before Core starts a game action. */
export interface AuthorizeGameCommandInput {
  turn: UserTurn
  capability: GameCapability
  command: GameCommand
}

/**
 * Integration-owned permission boundary for game actions.
 *
 * Implementations may show confirmation UI or apply a trusted local policy.
 * Returning false prevents adapter execution.
 */
export interface GamePermissionPolicy {
  authorize: (input: AuthorizeGameCommandInput) => Promise<boolean>
}

export interface GameCoopAgentOptions {
  executionPort: GameExecutionPort
  intentPolicy: GameIntentPolicy
  /**
   * Authorizes selected capabilities before execution.
   *
   * @default Allows `low` risk only. `medium` and `high` require an injected
   * policy so Core cannot silently execute them.
   */
  permissionPolicy?: GamePermissionPolicy
  createActionId: () => string
}

interface ActiveAction {
  turn: UserTurn
  command: GameCommand
  capability: GameCapability
}

/**
 * Coordinates user turns with a dynamic capability catalog and action lifecycle.
 *
 * One instance owns one active Coop session. `handleUserTurn()` returns false
 * when policy decides the turn is not a game command, allowing Integration to
 * fall back to normal chat without routing chat through Core.
 */
export class GameCoopAgent {
  private readonly activeActions = new Map<string, ActiveAction>()
  private readonly utteranceListeners = new Set<(utterance: AgentUtterance) => void>()
  private sessionId: string | null = null
  private unsubscribeActions: Unsubscribe | null = null

  constructor(private readonly options: GameCoopAgentOptions) {}

  public start(sessionId: string): void {
    if (this.sessionId === sessionId)
      return
    this.stop()
    this.sessionId = sessionId
    this.unsubscribeActions = this.options.executionPort.observe(
      sessionId,
      event => this.handleActionEvent(event),
    )
  }

  /**
   * Detaches Core from voice-session lifecycle events.
   *
   * Already-dispatched game actions remain adapter-owned and continue running.
   * Call {@link cancelTurn} explicitly when cancellation is intended.
   */
  public stop(): void {
    this.unsubscribeActions?.()
    this.unsubscribeActions = null
    this.activeActions.clear()
    this.sessionId = null
  }

  public onAgentUtterance(listener: (utterance: AgentUtterance) => void): Unsubscribe {
    this.utteranceListeners.add(listener)
    return () => this.utteranceListeners.delete(listener)
  }

  public async handleUserTurn(turn: UserTurn): Promise<boolean> {
    if (turn.sessionId !== this.sessionId)
      throw new Error(`User turn session "${turn.sessionId}" is not active`)

    const capabilities = await this.options.executionPort.getCapabilities(turn.sessionId)
    const resolution = await this.options.intentPolicy.resolve({ turn, capabilities })
    if (resolution == null)
      return false

    const capability = capabilities.find(item => item.capabilityId === resolution.capabilityId)
    if (capability == null) {
      throw new Error(
        `Intent policy selected unavailable capability "${resolution.capabilityId}"`,
      )
    }

    const command: GameCommand = {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      actionId: this.options.createActionId(),
      capabilityId: capability.capabilityId,
      input: resolution.input,
    }

    const authorized = this.options.permissionPolicy == null
      ? capability.risk === 'low'
      : await this.options.permissionPolicy.authorize({ turn, capability, command })
    if (!authorized)
      throw new Error(`Permission denied for capability "${capability.capabilityId}"`)

    this.activeActions.set(command.actionId, { turn, command, capability })

    try {
      await this.options.executionPort.execute(command)
    }
    catch (error) {
      this.activeActions.delete(command.actionId)
      throw error
    }
    return true
  }

  public async cancelTurn(turnId: string, reason?: string): Promise<void> {
    const cancellations: Promise<void>[] = []
    for (const active of this.activeActions.values()) {
      if (active.turn.turnId !== turnId || !active.capability.cancellable)
        continue
      cancellations.push(this.options.executionPort.cancel(active.command.actionId, reason))
    }
    await Promise.all(cancellations)
  }

  private handleActionEvent(event: GameActionEvent): void {
    const active = this.activeActions.get(event.actionId)
    if (active == null)
      return

    const text = this.options.intentPolicy.describeAction({
      ...active,
      event,
    })
    if (text != null && text.trim().length > 0) {
      const utterance: AgentUtterance = {
        sessionId: event.sessionId,
        turnId: event.turnId,
        timestamp: event.timestamp,
        text,
      }
      for (const listener of this.utteranceListeners)
        listener(utterance)
    }

    if (event.state === 'succeeded' || event.state === 'failed' || event.state === 'cancelled')
      this.activeActions.delete(event.actionId)
  }
}
