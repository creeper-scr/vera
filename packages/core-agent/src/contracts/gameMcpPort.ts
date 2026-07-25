export type GameMcpJson
  = | boolean
    | number
    | string
    | null
    | GameMcpJson[]
    | { [key: string]: GameMcpJson }

/** MCP tool metadata exposed by one game adapter session. */
export interface GameMcpToolDescriptor {
  name: string
  description?: string
  /** Provider-compliant JSON Schema. MCP tool inputs must be objects. */
  inputSchema: Record<string, unknown>
  /**
   * Adapter-declared risk. Missing means the facade must not invent a default
   * safer than the underlying capability.
   */
  risk?: 'low' | 'medium' | 'high'
  /** Whether the corresponding game action can be cancelled after accept. */
  cancellable?: boolean
  /** Continuous actions return after acceptance instead of waiting for terminal settlement. */
  waitForTerminal?: boolean
  /** Source capability id when the tool name is namespaced or rewritten. */
  capabilityId?: string
  /** Source adapter id for multi-game isolation. */
  adapterId?: string
}

/**
 * Current game observation used for one decision.
 *
 * Prefer adapter-native getEnvironment. Facades must not mint a pseudo status
 * capability per game when a shared resource path exists.
 */
export interface GameEnvironmentSnapshot {
  sessionId: string
  /** Unix epoch milliseconds at which the adapter observed this state. */
  observedAt: number
  /** Maximum age accepted by upper intelligence. */
  freshnessMs: number
  content: GameMcpJson
  /** Optional adapter that produced the snapshot. */
  adapterId?: string
  /**
   * Opaque revision. Capability catalog or world state changes should bump it
   * so continuous tool loops can refresh stale caches.
   */
  revision?: string
}

/**
 * Terminal or accepted handle returned by {@link GameMcpClientPort.callTool}.
 *
 * Short actions should resolve only after succeeded/failed/cancelled.
 * Long actions may return accepted with waitForTerminal=false.
 */
export type GameMcpToolCallResult
  = | {
    status: 'accepted'
    actionId: string
    state: 'queued' | 'running'
    capabilityId: string
  }
  | {
    status: 'terminal'
    actionId: string
    state: 'succeeded' | 'failed' | 'cancelled'
    capabilityId: string
    result?: GameMcpJson
    error?: string
    reason?: string
  }

export interface GameMcpCall {
  sessionId: string
  turnId: string
  toolCallId: string
  name: string
  arguments: Record<string, unknown>
  abortSignal: AbortSignal
  /**
   * When true, resolve only after a terminal action event.
   * When false, resolve as soon as the action is accepted (queued/running).
   * @default true
   */
  waitForTerminal?: boolean
}

/**
 * Client boundary for game capability discovery, perception, and execution.
 *
 * Transport details stay below this port. Implementations wrap
 * GameExecutionPort generically — no hard-coded minecraft.* assumptions.
 *
 * Correlation must preserve sessionId, turnId, actionId, and toolCallId.
 * AbortSignal must cancel cancellable in-flight actions and fail the call when
 * the action cannot complete.
 */
export interface GameMcpClientPort {
  listTools: (sessionId: string, abortSignal: AbortSignal) => Promise<GameMcpToolDescriptor[]>
  readEnvironment: (sessionId: string, abortSignal: AbortSignal) => Promise<GameEnvironmentSnapshot>
  callTool: (call: GameMcpCall) => Promise<GameMcpToolCallResult | unknown>
  /**
   * Cancel a previously accepted long action by actionId.
   * Optional until the generic facade lands.
   */
  cancelAction?: (input: {
    sessionId: string
    actionId: string
    reason?: string
    abortSignal?: AbortSignal
  }) => Promise<void>
}
