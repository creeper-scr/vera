/** Audio attached to one finalized upper-layer turn. */
export interface UserTurnAudio {
  data: Uint8Array
  mimeType: string
}

/**
 * Correlated user input shared by voice and decision modules.
 *
 * Producers may provide text, audio, or both. Decision policies must not assume
 * that every runtime performs speech transcription.
 */
export type UserTurn = {
  sessionId: string
  turnId: string
  timestamp: number
} & (
  | { text: string, audio?: UserTurnAudio }
  | { text?: undefined, audio: UserTurnAudio }
)

/** Correlated text prepared by decision policy for an upper-layer consumer. */
export interface AgentUtterance {
  sessionId: string
  turnId: string
  timestamp: number
  text: string
}
