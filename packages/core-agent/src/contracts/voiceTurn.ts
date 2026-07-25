/**
 * Finalized voice turn handed from Layer 1 (media I/O) to Layer 2 (Companion Agent).
 *
 * Incremental ASR stays UI-only unless a later design adds preemptive intent
 * detection. Layer 2 is the only dialogue and action decision owner.
 */
export interface VoiceTurn {
  sessionId: string
  turnId: string
  text: string
  /** Unix epoch milliseconds when the turn was finalized. */
  createdAt: number
  metadata: VoiceTurnMetadata
}

/** Correlation retained across concurrent speech, proactive events, and actions. */
export interface VoiceTurnMetadata {
  source: string
  eventId: string
  parentEventId?: string
}

/**
 * Speech playback terminal reported by Layer 1 back to Layer 2.
 *
 * Required so barge-in and failed TTS settle the same turn ownership graph.
 */
export type SpeechPlaybackTerminal = 'completed' | 'interrupted' | 'failed'

export interface SpeechPlaybackResult {
  sessionId: string
  turnId: string
  intentId: string
  terminal: SpeechPlaybackTerminal
  reason?: string
}
