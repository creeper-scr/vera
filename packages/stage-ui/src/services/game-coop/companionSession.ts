import type {
  CompanionAgentModelPort,
  CompanionAgentPhase,
  CompanionAgentRuntime,
  CompanionAgentTurnResult,
  CompanionObservationInput,
  GameEnvironmentSnapshot,
  GameMcpToolDescriptor,
  VoiceTurn,
} from '@proj-vera/core-agent'
import type {
  GameExecutionPort,
  GameObservation,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import { createCompanionAgentRuntime } from '@proj-vera/core-agent'

import { createGameMcpClient } from './gameMcpClient'

export interface CompanionSessionOptions {
  executionPort: GameExecutionPort
  model: CompanionAgentModelPort
  /** Logical agent/game session id used for VoiceTurn correlation + MCP routing. */
  sessionId: string
  /** Returns current character prompt for each agent turn. */
  getSystemPrompt?: () => string
  maxSteps?: number
  now?: () => number
  createActionId?: () => string
  allowedRisks?: ReadonlyArray<'low' | 'medium' | 'high'>
  shouldReactToObservation?: (observation: CompanionObservationInput) => boolean
  onTurnResult?: (result: CompanionAgentTurnResult, turn: VoiceTurn) => void
  onObservationResult?: (result: CompanionAgentTurnResult | null, observation: CompanionObservationInput) => void
  onPhaseChange?: (phase: CompanionAgentPhase) => void
}

export interface CompanionSession {
  getSessionId: () => string
  getPhase: () => CompanionAgentPhase
  ingestVoiceTurn: (turn: VoiceTurn) => Promise<CompanionAgentTurnResult>
  ingestObservation: (observation: CompanionObservationInput) => Promise<CompanionAgentTurnResult | null>
  rememberExternalAssistant: (text: string) => void
  cancel: CompanionAgentRuntime['cancel']
  /** Subscribe observeWorld on executionPort if present; auto-ingest into agent. */
  startWorldObservations: () => void
  stopWorldObservations: () => void
  listTools: (abortSignal?: AbortSignal) => Promise<GameMcpToolDescriptor[]>
  readEnvironment: (abortSignal?: AbortSignal) => Promise<GameEnvironmentSnapshot>
  dispose: () => Promise<void>
}

/**
 * Wave 2 glue: one companion session wiring VoiceTurn ingest ->
 * CompanionAgentRuntime -> GameMcpClient -> GameExecutionPort, plus optional
 * observeWorld auto-ingest.
 *
 * Owns the MCP client lifecycle. Callers inject a platform-specific
 * GameExecutionPort (fake in tests, ServerGameAdapter in product).
 */
export function createCompanionSession(options: CompanionSessionOptions): CompanionSession {
  const mcp = createGameMcpClient({
    executionPort: options.executionPort,
    createActionId: options.createActionId,
    now: options.now,
    allowedRisks: options.allowedRisks,
  })

  const agent = createCompanionAgentRuntime({
    mcp,
    model: options.model,
    getSystemPrompt: options.getSystemPrompt,
    maxSteps: options.maxSteps,
    now: options.now,
    shouldReactToObservation: options.shouldReactToObservation,
  })

  let worldUnsubscribe: Unsubscribe | undefined
  let disposed = false

  function reportPhase() {
    options.onPhaseChange?.(agent.getPhase())
  }

  async function ingestVoiceTurn(turn: VoiceTurn) {
    if (disposed)
      return { status: 'ignored' as const, reason: 'disposed', steps: 0, toolNames: [], toolSteps: [] }
    reportPhase()
    const result = await agent.ingestVoiceTurn(turn)
    reportPhase()
    options.onTurnResult?.(result, turn)
    return result
  }

  async function ingestObservation(observation: CompanionObservationInput) {
    if (disposed)
      return { status: 'ignored' as const, reason: 'disposed', steps: 0, toolNames: [], toolSteps: [] }
    reportPhase()
    const result = await agent.ingestObservation(observation)
    reportPhase()
    options.onObservationResult?.(result, observation)
    return result
  }

  function toCompanionObservation(observation: GameObservation): CompanionObservationInput {
    return {
      sessionId: observation.sessionId,
      eventId: observation.eventId,
      kind: observation.kind,
      urgency: observation.urgency,
      text: observation.text,
      observedAt: observation.observedAt,
      data: observation.data,
      dedupeKey: observation.dedupeKey,
    }
  }

  function startWorldObservations() {
    if (disposed || worldUnsubscribe != null)
      return
    const observeWorld = options.executionPort.observeWorld
    if (observeWorld == null)
      return
    worldUnsubscribe = observeWorld.call(options.executionPort, options.sessionId, (observation) => {
      // Fire-and-forget; enqueue inside agent serializes per session.
      void ingestObservation(toCompanionObservation(observation))
    })
  }

  function stopWorldObservations() {
    worldUnsubscribe?.()
    worldUnsubscribe = undefined
  }

  async function dispose() {
    if (disposed)
      return
    disposed = true
    stopWorldObservations()
    agent.dispose()
    await mcp.dispose()
  }

  return {
    getSessionId: () => options.sessionId,
    getPhase: () => agent.getPhase(),
    ingestVoiceTurn,
    ingestObservation,
    rememberExternalAssistant: (text: string) => {
      if (disposed)
        return
      agent.rememberExternalAssistant(options.sessionId, text)
    },
    cancel: agent.cancel,
    startWorldObservations,
    stopWorldObservations,
    listTools: abortSignal => mcp.listTools(options.sessionId, abortSignal ?? new AbortController().signal),
    readEnvironment: abortSignal => mcp.readEnvironment(options.sessionId, abortSignal ?? new AbortController().signal),
    dispose,
  }
}
