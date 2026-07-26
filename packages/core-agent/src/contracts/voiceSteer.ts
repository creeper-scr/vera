/**
 * Hybrid voice steering from Layer 2 → Layer 1.
 * Applied via Doubao UpdateConfig(201) on subsequent dialogue (does not interrupt current TTS).
 */
export interface VoiceSteerDirective {
  turnId: string
  mode: 'hybrid'
  /** Ground-truth game facts in companion-facing language. */
  facts: string[]
  /** Corrections when Layer 1 may have over-claimed before facts settled. */
  corrections?: string[]
  /** Soft intent for the next spoken turn (not forced TTS copy). */
  speakHint?: string
}

/** Minimal Layer 2 turn shape needed to derive hybrid steer. */
export interface VoiceSteerTurnResultInput {
  status: 'completed' | 'cancelled' | 'ignored' | 'failed'
  reason?: string
  toolSteps: ReadonlyArray<{
    name: string
    arguments: Record<string, unknown>
    ok: boolean
    error?: string
  }>
  assistantText?: string
}

/**
 * Derives a hybrid steer directive from one Layer 2 turn result.
 */
export function createVoiceSteerFromTurnResult(
  turnId: string,
  result: VoiceSteerTurnResultInput,
  formatToolStep: (step: VoiceSteerTurnResultInput['toolSteps'][number]) => string = defaultFormatToolStep,
): VoiceSteerDirective {
  const facts: string[] = []
  const corrections: string[] = []
  const toolSteps = result.toolSteps ?? []

  if (result.status === 'completed' && toolSteps.length > 0) {
    for (const step of toolSteps) {
      if (step.ok)
        facts.push(`已去做：${formatToolStep(step)}`)
      else
        facts.push(`没做成：${formatToolStep(step)}`)
    }
    if (toolSteps.some(step => step.ok)) {
      corrections.push(
        '刚才若说做不到、不会、没这个功能或推脱不会游戏操作，请改口：其实可以，而且已经在做了。',
      )
    }
    if (toolSteps.some(step => !step.ok))
      corrections.push('刚才若说已经完成，请改口说明还没做成。')
  }
  else if (result.status === 'completed') {
    facts.push('这一轮没有游戏动作')
  }
  else if (result.status === 'failed') {
    const detail = result.reason?.trim()
    facts.push(detail ? `这一轮失败：${detail}` : '这一轮失败了')
    corrections.push('刚才若承诺已经在做或已经完成，请改口说明还没做成。')
  }
  else if (result.status === 'cancelled') {
    facts.push('这一轮动作已取消')
    corrections.push('刚才若说正在做，请改口说明已经停了。')
  }

  const speakHint = result.assistantText?.trim() || undefined
  return {
    turnId,
    mode: 'hybrid',
    facts,
    corrections: corrections.length > 0 ? corrections : undefined,
    speakHint,
  }
}

function defaultFormatToolStep(step: VoiceSteerTurnResultInput['toolSteps'][number]): string {
  const args = Object.keys(step.arguments).length > 0
    ? `(${Object.entries(step.arguments).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')})`
    : ''
  if (step.ok)
    return `${step.name}${args}`
  return `${step.name}${args}：${step.error ?? '失败'}`
}
