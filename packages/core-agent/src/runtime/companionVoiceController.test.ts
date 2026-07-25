import { describe, expect, it, vi } from 'vitest'

import { createCompanionVoiceController } from './companionVoiceController'

describe('createCompanionVoiceController', () => {
  it('emits a finalized VoiceTurn and enters thinking', async () => {
    const turns: Array<{ text: string, turnId: string, sessionId: string }> = []
    const controller = createCompanionVoiceController({
      sessionId: 's1',
      now: () => 1_700_000_000_000,
      createId: prefix => `${prefix}-fixed`,
      onVoiceTurn: (turn) => {
        turns.push(turn)
      },
    })

    controller.setMicEnabled(true)
    expect(controller.getPhase()).toBe('listening')

    const turn = await controller.finalizeTranscript({
      text: '  跟着我  ',
      source: 'hearing',
    })

    expect(turn).toMatchObject({
      sessionId: 's1',
      turnId: 'turn-fixed',
      text: '跟着我',
      createdAt: 1_700_000_000_000,
      metadata: {
        source: 'hearing',
        eventId: 'event-fixed',
      },
    })
    expect(turns).toHaveLength(1)
    expect(controller.getPhase()).toBe('thinking')
  })

  it('ignores empty transcripts and partial whitespace', async () => {
    const onVoiceTurn = vi.fn()
    const controller = createCompanionVoiceController({
      sessionId: 's1',
      onVoiceTurn,
    })

    await expect(controller.finalizeTranscript({ text: '   ' })).resolves.toBeNull()
    await expect(controller.finalizeTranscript({ text: '' })).resolves.toBeNull()
    expect(onVoiceTurn).not.toHaveBeenCalled()
  })

  it('barge-in cancels speech via CompanionInterruptPort shape and settles phase', async () => {
    const cancel = vi.fn(async () => [{ status: 'cancelled' as const, scope: 'speech' as const }])
    const controller = createCompanionVoiceController({
      sessionId: 's1',
      speech: { cancel },
      createId: prefix => `${prefix}-1`,
    })

    controller.setMicEnabled(true)
    controller.noteSpeaking('turn-speaking')
    expect(controller.getPhase()).toBe('speaking')

    const outcomes = await controller.bargeIn('user-interrupt')
    expect(cancel).toHaveBeenCalledWith({
      sessionId: 's1',
      turnId: 'turn-speaking',
      scope: 'speech',
      reason: 'user-interrupt',
    })
    expect(outcomes).toEqual([{ status: 'cancelled', scope: 'speech' }])
    expect(controller.getPhase()).toBe('listening')
  })

  it('finalizing while speaking performs barge-in then emits VoiceTurn', async () => {
    const cancel = vi.fn(async () => [{ status: 'cancelled' as const, scope: 'speech' as const }])
    const turns: string[] = []
    const controller = createCompanionVoiceController({
      sessionId: 's1',
      speech: { cancel },
      createId: prefix => `${prefix}-x`,
      onVoiceTurn: (turn) => {
        turns.push(turn.text)
      },
    })

    controller.setMicEnabled(true)
    controller.noteSpeaking('turn-old')

    const turn = await controller.finalizeTranscript({ text: '停下' })
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'turn-old',
      scope: 'speech',
      reason: 'barge-in',
    }))
    expect(turn?.text).toBe('停下')
    expect(turns).toEqual(['停下'])
    expect(controller.getPhase()).toBe('thinking')
  })

  it('cancel(speech) is CompanionInterruptPort-compatible', async () => {
    const cancel = vi.fn(async () => [{ status: 'cancelled' as const, scope: 'speech' as const }])
    const controller = createCompanionVoiceController({
      sessionId: 's1',
      speech: { cancel },
    })

    controller.noteSpeaking('t9')
    const outcomes = await controller.cancel({
      sessionId: 's1',
      turnId: 't9',
      scope: 'speech',
      reason: 'stop',
    })

    expect(outcomes).toEqual([{ status: 'cancelled', scope: 'speech' }])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('uses the current session after connection replacement', async () => {
    let sessionId = 'local'
    const cancel = vi.fn(async () => [{ status: 'cancelled' as const, scope: 'speech' as const }])
    const controller = createCompanionVoiceController({
      sessionId,
      getSessionId: () => sessionId,
      speech: { cancel },
    })

    sessionId = 'minecraft-1'
    controller.noteSpeaking('t1')
    const turn = await controller.finalizeTranscript({ text: '继续' })

    expect(controller.getSessionId()).toBe('minecraft-1')
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'minecraft-1',
      turnId: 't1',
    }))
    expect(turn?.sessionId).toBe('minecraft-1')
  })

  it('reportSpeechPlayback leaves speaking on terminal results', async () => {
    const onSpeechPlaybackResult = vi.fn()
    const controller = createCompanionVoiceController({
      sessionId: 's1',
      onSpeechPlaybackResult,
    })

    controller.setMicEnabled(true)
    controller.noteSpeaking('t1')
    await controller.reportSpeechPlayback({
      sessionId: 's1',
      turnId: 't1',
      intentId: 'i1',
      terminal: 'interrupted',
      reason: 'barge-in',
    })

    expect(controller.getPhase()).toBe('listening')
    expect(onSpeechPlaybackResult).toHaveBeenCalledWith(expect.objectContaining({
      terminal: 'interrupted',
      intentId: 'i1',
    }))
  })

  it('pTT begin/end toggles listening without inventing turns', async () => {
    const controller = createCompanionVoiceController({ sessionId: 's1' })
    controller.beginPtt()
    expect(controller.getMicEnabled()).toBe(true)
    expect(controller.getMicMode()).toBe('ptt')
    expect(controller.getPhase()).toBe('listening')

    controller.endPtt()
    expect(controller.getPhase()).toBe('idle')
  })
})
