import type {
  CompanionCancelOutcome,
  CompanionCancelRequest,
  CompanionInterruptPort,
} from '../contracts/companionCancel'
import type {
  SpeechPlaybackResult,
  VoiceTurn,
} from '../contracts/voiceTurn'

/**
 * Product-facing voice lifecycle projected to UI and Layer 2.
 *
 * Distinct from CompanionAgentPhase: this controller owns mic/listening
 * coordination, while the agent owns thinking/acting inference.
 */
export type CompanionVoicePhase
  = | 'idle'
    | 'listening'
    | 'thinking'
    | 'speaking'
    | 'acting'

/** How the mic session detects speech segments. */
export type CompanionMicMode = 'ptt' | 'vad'

/**
 * Speech playback cancel surface owned by Layer 1.
 *
 * Implemented by the headless speech host (or Stage host). The voice controller
 * calls this for barge-in; it never talks to Vue/Pinia/Electron.
 */
export interface CompanionSpeechCancelPort {
  cancel: (request: CompanionCancelRequest) => Promise<CompanionCancelOutcome[]>
}

export interface CompanionVoiceControllerDeps {
  /** Initial session identity used when no dynamic resolver is provided. */
  sessionId: string
  /**
   * Resolves current session identity for long-lived UI controllers whose
   * connection may be replaced without remounting.
   */
  getSessionId?: () => string
  /**
   * Optional speech cancel port. Required for barge-in to stop playback.
   */
  speech?: CompanionSpeechCancelPort
  /**
   * Fired only for finalized ASR turns (never partials).
   */
  onVoiceTurn?: (turn: VoiceTurn) => void | Promise<void>
  /**
   * Fired when speech playback settles so Layer 2 can clear speaking ownership.
   */
  onSpeechPlaybackResult?: (result: SpeechPlaybackResult) => void | Promise<void>
  now?: () => number
  createId?: (prefix: string) => string
}

export interface CompanionVoiceController extends CompanionInterruptPort {
  getPhase: () => CompanionVoicePhase
  getMicEnabled: () => boolean
  getMicMode: () => CompanionMicMode
  getSessionId: () => string
  setMicEnabled: (enabled: boolean) => void
  setMicMode: (mode: CompanionMicMode) => void
  /**
   * Enter listening when mic is enabled. No-op if already past listening
   * (thinking/speaking/acting) so agent work is not clobbered.
   */
  startListening: () => void
  /**
   * Leave listening without finalizing a turn. Keeps thinking/speaking/acting.
   */
  stopListening: () => void
  /**
   * Product PTT press. Enables listening for the held segment.
   */
  beginPtt: () => void
  /**
   * Product PTT release. Stops listening; ASR finalization arrives separately.
   */
  endPtt: () => void
  /**
   * Project agent-owned phase (thinking/speaking/acting/idle) into the voice
   * surface. Listening is restored only when mic remains enabled and idle.
   */
  setAgentPhase: (phase: Exclude<CompanionVoicePhase, 'listening'>) => void
  /**
   * Record the turn that currently owns speech playback so barge-in has a target.
   */
  noteSpeaking: (turnId: string) => void
  /**
   * Finalize one ASR result into a {@link VoiceTurn}. Empty/whitespace text is
   * ignored. When currently speaking, barge-in cancels speech first.
   */
  finalizeTranscript: (input: {
    text: string
    eventId?: string
    parentEventId?: string
    source?: string
    turnId?: string
  }) => Promise<VoiceTurn | null>
  /**
   * Explicit barge-in: cancel speech for the active speaking turn (or provided
   * turnId) and drop back to listening/idle.
   */
  bargeIn: (reason?: string, turnId?: string) => Promise<CompanionCancelOutcome[]>
  /**
   * Report a speech playback terminal so phase can leave `speaking`.
   */
  reportSpeechPlayback: (result: SpeechPlaybackResult) => Promise<void>
  dispose: () => void
}

function defaultId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Platform-agnostic product voice controller.
 *
 * Owns mic on/off, PTT/VAD mode flags, listening/speaking coordination, VoiceTurn
 * emission, and speech-scoped barge-in. Media capture and STT stay outside —
 * callers feed finalized transcripts and wire {@link CompanionSpeechCancelPort}.
 *
 * Call stack:
 *
 * media/PTT/VAD finalize
 *   -> {@link CompanionVoiceController.finalizeTranscript}
 *     -> optional barge-in via {@link CompanionSpeechCancelPort}
 *       -> {@link VoiceTurn} to Layer 2
 */
export function createCompanionVoiceController(
  deps: CompanionVoiceControllerDeps,
): CompanionVoiceController {
  const now = deps.now ?? Date.now
  const createId = deps.createId ?? ((prefix: string) => defaultId(prefix))

  let phase: CompanionVoicePhase = 'idle'
  let micEnabled = false
  let micMode: CompanionMicMode = 'vad'
  let disposed = false
  let activeSpeakingTurnId: string | undefined
  const getSessionId = () => deps.getSessionId?.() ?? deps.sessionId

  function restoreAfterIdle() {
    phase = micEnabled ? 'listening' : 'idle'
  }

  function setMicEnabled(enabled: boolean) {
    if (disposed)
      return
    micEnabled = enabled
    if (!enabled) {
      if (phase === 'listening')
        phase = 'idle'
      return
    }
    if (phase === 'idle')
      phase = 'listening'
  }

  function setMicMode(mode: CompanionMicMode) {
    if (disposed)
      return
    micMode = mode
  }

  function startListening() {
    if (disposed || !micEnabled)
      return
    if (phase === 'idle' || phase === 'listening')
      phase = 'listening'
  }

  function stopListening() {
    if (disposed)
      return
    if (phase === 'listening')
      phase = 'idle'
  }

  function beginPtt() {
    if (disposed)
      return
    micMode = 'ptt'
    setMicEnabled(true)
    startListening()
  }

  function endPtt() {
    if (disposed)
      return
    stopListening()
  }

  function setAgentPhase(next: Exclude<CompanionVoicePhase, 'listening'>) {
    if (disposed)
      return
    if (next === 'idle') {
      activeSpeakingTurnId = undefined
      restoreAfterIdle()
      return
    }
    phase = next
  }

  function noteSpeaking(turnId: string) {
    if (disposed)
      return
    activeSpeakingTurnId = turnId
    phase = 'speaking'
  }

  async function cancelSpeech(
    turnId: string,
    reason?: string,
  ): Promise<CompanionCancelOutcome[]> {
    if (!deps.speech)
      return [{ status: 'missing', scope: 'speech' }]

    return deps.speech.cancel({
      sessionId: getSessionId(),
      turnId,
      scope: 'speech',
      reason,
    })
  }

  async function bargeIn(reason = 'barge-in', turnId?: string): Promise<CompanionCancelOutcome[]> {
    if (disposed)
      return [{ status: 'missing', scope: 'speech' }]

    const targetTurnId = turnId ?? activeSpeakingTurnId
    if (!targetTurnId) {
      if (phase === 'speaking')
        restoreAfterIdle()
      return [{ status: 'missing', scope: 'speech' }]
    }

    const outcomes = await cancelSpeech(targetTurnId, reason)
    if (activeSpeakingTurnId === targetTurnId)
      activeSpeakingTurnId = undefined
    if (phase === 'speaking')
      restoreAfterIdle()
    return outcomes
  }

  async function finalizeTranscript(input: {
    text: string
    eventId?: string
    parentEventId?: string
    source?: string
    turnId?: string
  }): Promise<VoiceTurn | null> {
    if (disposed)
      return null

    const text = input.text.trim()
    if (!text)
      return null

    // Barge-in: user speech while assistant is speaking cancels playback first.
    if (phase === 'speaking')
      await bargeIn('barge-in')

    const turn: VoiceTurn = {
      sessionId: getSessionId(),
      turnId: input.turnId ?? createId('turn'),
      text,
      createdAt: now(),
      metadata: {
        source: input.source ?? 'hearing',
        eventId: input.eventId ?? createId('event'),
        parentEventId: input.parentEventId,
      },
    }

    phase = 'thinking'
    await deps.onVoiceTurn?.(turn)
    return turn
  }

  async function reportSpeechPlayback(result: SpeechPlaybackResult): Promise<void> {
    if (disposed)
      return

    if (result.sessionId !== getSessionId())
      return

    if (activeSpeakingTurnId === result.turnId || phase === 'speaking') {
      if (result.terminal === 'completed' || result.terminal === 'failed' || result.terminal === 'interrupted') {
        if (activeSpeakingTurnId === result.turnId)
          activeSpeakingTurnId = undefined
        if (phase === 'speaking')
          restoreAfterIdle()
      }
    }

    await deps.onSpeechPlaybackResult?.(result)
  }

  async function cancel(request: CompanionCancelRequest): Promise<CompanionCancelOutcome[]> {
    if (disposed)
      return [{ status: 'missing', scope: request.scope }]

    if (request.sessionId !== getSessionId())
      return [{ status: 'missing', scope: request.scope }]

    if (request.scope !== 'speech') {
      // Inference/tool/game-action/turn belong to CompanionAgentRuntime.
      return [{ status: 'missing', scope: request.scope }]
    }

    return bargeIn(request.reason ?? 'cancel', request.turnId)
  }

  function dispose() {
    if (disposed)
      return
    disposed = true
    micEnabled = false
    activeSpeakingTurnId = undefined
    phase = 'idle'
  }

  return {
    getPhase: () => phase,
    getMicEnabled: () => micEnabled,
    getMicMode: () => micMode,
    getSessionId,
    setMicEnabled,
    setMicMode,
    startListening,
    stopListening,
    beginPtt,
    endPtt,
    setAgentPhase,
    noteSpeaking,
    finalizeTranscript,
    bargeIn,
    reportSpeechPlayback,
    cancel,
    dispose,
  }
}
