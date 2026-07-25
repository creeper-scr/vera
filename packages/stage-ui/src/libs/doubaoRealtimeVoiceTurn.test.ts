import { describe, expect, it, vi } from 'vitest'

import { createDoubaoRealtimeVoiceTurnAssembler } from './doubaoRealtimeVoiceTurn'

describe('createDoubaoRealtimeVoiceTurnAssembler', () => {
  it('settles one user turn only after ASR ended', () => {
    const onTranscript = vi.fn()
    const onTurn = vi.fn()
    const assembler = createDoubaoRealtimeVoiceTurnAssembler({
      sessionId: 'session-1',
      onTranscript,
      onTurn,
    })

    assembler.started('question-1')
    assembler.result([{ text: '玩', is_interim: true }])
    assembler.result([{ text: '捡起木头', is_interim: false }])

    expect(onTranscript).toHaveBeenCalledWith('捡起木头')
    expect(onTurn).not.toHaveBeenCalled()

    assembler.ended()
    assembler.ended()

    expect(onTurn).toHaveBeenCalledTimes(1)
    expect(onTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'question-1',
      text: '捡起木头',
    })
  })

  it('supersedes unfinished turns and ignores empty final transcripts', () => {
    const onTurn = vi.fn()
    const assembler = createDoubaoRealtimeVoiceTurnAssembler({
      sessionId: 'session-1',
      onTurn,
    })

    assembler.started('stale')
    assembler.result([{ text: '旧指令', is_interim: false }])
    assembler.started('current')
    assembler.result([{ text: '  ', is_interim: false }])
    assembler.ended()

    expect(onTurn).not.toHaveBeenCalled()
  })

  it('uses a local correlation id when question_id is absent', () => {
    const onTurn = vi.fn()
    const assembler = createDoubaoRealtimeVoiceTurnAssembler({
      sessionId: 'session-1',
      createTurnId: () => 'local-turn',
      onTurn,
    })

    assembler.started()
    assembler.result([{ text: '向前走', is_interim: false }])
    assembler.ended()

    expect(onTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'local-turn',
      text: '向前走',
    })
  })

  it('drops pending input on reset', () => {
    const onTurn = vi.fn()
    const assembler = createDoubaoRealtimeVoiceTurnAssembler({
      sessionId: 'session-1',
      onTurn,
    })

    assembler.started('question-1')
    assembler.result([{ text: '不会提交', is_interim: false }])
    assembler.reset()
    assembler.ended()

    expect(onTurn).not.toHaveBeenCalled()
  })

  it('ignores late ASR events from a superseded question', () => {
    const onTurn = vi.fn()
    const assembler = createDoubaoRealtimeVoiceTurnAssembler({
      sessionId: 'session-1',
      onTurn,
    })

    assembler.started('old-question')
    assembler.started('current-question')
    assembler.result([{ text: '旧指令', is_interim: false }], 'old-question')
    assembler.ended('old-question')
    assembler.result([{ text: '当前指令', is_interim: false }], 'current-question')
    assembler.ended('current-question')

    expect(onTurn).toHaveBeenCalledOnce()
    expect(onTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'current-question',
      text: '当前指令',
    })
  })
})
