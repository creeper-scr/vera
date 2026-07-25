/**
 * Cancel ownership for one companion turn.
 *
 * Barge-in must settle TTS, in-flight inference, MCP tool calls, and cancellable
 * game actions through one owner. Non-cancellable actions still report terminal
 * state; they are not silently dropped.
 */
export type CompanionCancelScope
  = | 'speech'
    | 'inference'
    | 'tool'
    | 'game-action'
    | 'turn'

export interface CompanionCancelRequest {
  sessionId: string
  turnId: string
  scope: CompanionCancelScope
  reason?: string
  /**
   * When true, cancel only scopes that declare cancellable=true and report the
   * rest as still-running/non-cancellable rather than throwing.
   * @default true
   */
  soft?: boolean
}

export type CompanionCancelOutcome
  = | { status: 'cancelled', scope: CompanionCancelScope }
    | { status: 'not-cancellable', scope: CompanionCancelScope, detail?: string }
    | { status: 'already-terminal', scope: CompanionCancelScope }
    | { status: 'missing', scope: CompanionCancelScope }

export interface CompanionInterruptPort {
  cancel: (request: CompanionCancelRequest) => Promise<CompanionCancelOutcome[]>
}
