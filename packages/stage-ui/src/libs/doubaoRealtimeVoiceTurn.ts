export interface DoubaoRealtimeVoiceUserTurn {
  /** Correlates the ASR turn with the owning realtime voice session. */
  sessionId: string
  /** Volcengine `question_id`, or a local id when the server omits it. */
  turnId: string
  text: string
}

export interface DoubaoRealtimeVoiceAsrResult {
  text?: string
  is_interim?: boolean
}

export interface DoubaoRealtimeVoiceTurnAssemblerOptions {
  sessionId: string
  createTurnId?: () => string
  onTranscript?: (text: string) => void
  onTurn?: (turn: DoubaoRealtimeVoiceUserTurn) => void
}

/**
 * Converts Volcengine 450/451/459 ASR events into one settled user turn.
 *
 * A new 450 supersedes any unfinished turn. Only 459 commits the latest
 * non-interim transcript, so partial ASR updates cannot trigger game actions.
 */
export function createDoubaoRealtimeVoiceTurnAssembler(options: DoubaoRealtimeVoiceTurnAssemblerOptions) {
  let activeTurn: { turnId: string, text?: string } | undefined

  function started(questionId?: string) {
    activeTurn = {
      turnId: questionId?.trim() || options.createTurnId?.() || crypto.randomUUID(),
    }
  }

  function result(results: DoubaoRealtimeVoiceAsrResult[], questionId?: string) {
    if (!activeTurn)
      return
    if (questionId?.trim() && questionId !== activeTurn.turnId)
      return

    for (const item of results) {
      const text = item.text?.trim()
      if (item.is_interim || !text)
        continue

      activeTurn.text = text
      options.onTranscript?.(text)
    }
  }

  function ended(questionId?: string) {
    if (questionId?.trim() && questionId !== activeTurn?.turnId)
      return

    const settled = activeTurn
    activeTurn = undefined
    if (!settled?.text)
      return

    options.onTurn?.({
      sessionId: options.sessionId,
      turnId: settled.turnId,
      text: settled.text,
    })
  }

  function reset() {
    activeTurn = undefined
  }

  return {
    started,
    result,
    ended,
    reset,
  }
}
