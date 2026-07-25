/** JSON values safe to carry across game execution transports. */
export type JsonValue
  = | boolean
    | number
    | string
    | null
    | JsonValue[]
    | { [key: string]: JsonValue }

/** Object input accepted by a game capability. */
export type GameCommandInput = Record<string, JsonValue>

/**
 * Provider-compatible object schema declared by a game adapter.
 *
 * Adapters own schema details. Core treats this value as catalog metadata and
 * never derives a cross-game action enum from it.
 */
export interface GameCapabilityInputSchema {
  type: 'object'
  properties: Record<string, JsonValue>
  required: string[]
  additionalProperties: boolean
}

/** Runtime capability dynamically declared for one game session. */
export interface GameCapability {
  /** Globally unique capability ID used to route commands to its adapter. */
  capabilityId: string
  description: string
  inputSchema: GameCapabilityInputSchema
  risk: 'low' | 'medium' | 'high'
  cancellable: boolean
  /**
   * Whether callers should wait for a terminal event before returning tool
   * output to the model. Continuous actions set false and return on acceptance.
   * @default true
   */
  waitForTerminal?: boolean
}

/** One correlated command created by Core after capability selection. */
export interface GameCommand {
  sessionId: string
  turnId: string
  actionId: string
  capabilityId: string
  input: GameCommandInput
}

interface GameActionEventBase {
  sessionId: string
  turnId: string
  actionId: string
  capabilityId: string
  /** Unix timestamp in milliseconds, assigned by the adapter at emission. */
  timestamp: number
}

export type GameActionEvent
  = | GameActionEventBase & { state: 'queued' | 'running' }
    | GameActionEventBase & { state: 'progress', progress: JsonValue }
    | GameActionEventBase & { state: 'succeeded', result?: JsonValue }
    | GameActionEventBase & { state: 'failed', error: string }
    | GameActionEventBase & { state: 'cancelled', reason?: string }
    | GameActionEventBase & { state: 'snapshot', snapshot: JsonValue }

/** Action lifecycle states that settle ownership and free correlation slots. */
export type GameActionTerminalState = 'succeeded' | 'failed' | 'cancelled'

export const GAME_ACTION_TERMINAL_STATES = new Set<GameActionEvent['state']>([
  'succeeded',
  'failed',
  'cancelled',
])

export function isGameActionTerminalState(
  state: GameActionEvent['state'],
): state is GameActionTerminalState {
  return GAME_ACTION_TERMINAL_STATES.has(state)
}

export type GameActionEventListener = (event: GameActionEvent) => void
export type Unsubscribe = () => void

/**
 * World event that is not owned by an Agent-initiated action.
 *
 * `GameActionEvent` requires action correlation. Hurt, attack, nearby danger,
 * and spontaneous inventory/world changes use this envelope instead. Adapters
 * normalize SDK events here; Companion Agent converts to ContextUpdate later.
 */
export interface GameObservation {
  sessionId: string
  eventId: string
  adapterId: string
  /** Unix epoch milliseconds when the adapter observed the event. */
  observedAt: number
  /** Adapter-owned kind string. Core never hardcodes cross-game kinds. */
  kind: string
  urgency: 'low' | 'normal' | 'high' | 'critical'
  /** Human-readable observation for prompts and debug UI. */
  text: string
  data?: Record<string, JsonValue>
  /** Stable key for dedupe/throttle before the event reaches the Agent. */
  dedupeKey?: string
  /** Optional environment/catalog revision associated with this observation. */
  stateRevision?: string
}

export type GameObservationListener = (observation: GameObservation) => void

/**
 * Read-only environment snapshot with freshness semantics.
 *
 * Adapters produce this without inventing a pseudo status action. Consumers
 * must treat content as data, never as instructions.
 */
export interface GameEnvironmentSnapshot {
  sessionId: string
  adapterId: string
  /** Unix epoch milliseconds at which the adapter observed this state. */
  observedAt: number
  /** Maximum age accepted by upper intelligence for this snapshot. */
  freshnessMs: number
  /** Opaque revision that changes when catalog or world state meaningfully changes. */
  revision: string
  content: JsonValue
}

/**
 * Signals that a session has no environment source.
 *
 * Transport layers preserve this separately from genuine sampling failures so
 * upper intelligence can continue with an explicitly unavailable snapshot.
 */
export class GameEnvironmentUnavailableError extends Error {
  public constructor(public readonly sessionId: string) {
    super(`No adapter provides environment for session "${sessionId}"`)
    this.name = 'GameEnvironmentUnavailableError'
  }
}

/**
 * Who owns connect/disconnect, pending actions, and dispose for one session.
 *
 * Electron main owns game transport sessions. Renderer may hold Agent runtime
 * and media, but must not own the game connection itself.
 */
export interface GameSessionOwnership {
  sessionId: string
  adapterId: string
  /**
   * Process role that owns connect/reconnect/dispose of the game transport.
   * @default 'electron-main' for the companion product path
   */
  connectionOwner: 'electron-main' | 'renderer' | 'external'
  /**
   * Process role that owns CompanionAgentRuntime decisions for this session.
   * @default 'renderer' for the first companion slice
   */
  agentOwner: 'renderer' | 'electron-main' | 'worker'
}

/**
 * Game-owned execution boundary.
 *
 * Implementations may depend on their native game driver, but never on Core
 * policy, LLM, Vue, voice transport, STT, or TTS modules.
 */
export interface GameAdapter {
  getCapabilities: (sessionId: string) => Promise<GameCapability[]>
  /**
   * Subscribe to Agent-initiated action lifecycle events for one session.
   * Events always carry actionId/turnId/capabilityId.
   */
  observe: (sessionId: string, listener: GameActionEventListener) => Unsubscribe
  /**
   * Subscribe to non-action world observations for one session.
   *
   * Optional until an adapter implements proactive stimuli. Missing method
   * means the adapter emits no world observations.
   */
  observeWorld?: (sessionId: string, listener: GameObservationListener) => Unsubscribe
  /**
   * Read current environment without executing a capability.
   *
   * Optional. When missing, upper layers must not invent a status tool call
   * just to sample state for every game.
   */
  getEnvironment?: (sessionId: string) => Promise<GameEnvironmentSnapshot>
  execute: (command: GameCommand) => Promise<void>
  cancel: (actionId: string, reason?: string) => Promise<void>
}

/**
 * Only game execution surface consumed by Core.
 *
 * Implementations aggregate a dynamic capability catalog and preserve the
 * correlated action lifecycle across adapter or transport boundaries.
 */
export interface GameExecutionPort extends GameAdapter {}
