import type {
  PlaybackEndEvent,
  PlaybackItem,
} from '@proj-vera/pipelines-audio'

import { createSpeechPipeline } from '@proj-vera/pipelines-audio'
import { describe, expect, it, vi } from 'vitest'

import { createHeadlessSpeechHost } from './headless-speech-host'

function createPlaybackHarness() {
  const scheduled: Array<PlaybackItem<AudioBuffer>> = []
  const endListeners: Array<(event: PlaybackEndEvent<AudioBuffer>) => void> = []
  const interruptListeners: Array<(event: { item: PlaybackItem<AudioBuffer>, reason: string }) => void> = []

  return {
    scheduled,
    end(item: PlaybackItem<AudioBuffer>) {
      for (const listener of endListeners)
        listener({ item, endedAt: Date.now() })
    },
    interrupt(item: PlaybackItem<AudioBuffer>, reason: string) {
      for (const listener of interruptListeners)
        listener({ item, reason })
    },
    playback: {
      schedule(item: PlaybackItem<AudioBuffer>) {
        scheduled.push(item)
      },
      stopAll: vi.fn(),
      stopByIntent: vi.fn((intentId: string, reason: string) => {
        const item = scheduled.find(entry => entry.intentId === intentId)
        if (item) {
          for (const listener of interruptListeners)
            listener({ item, reason })
        }
      }),
      stopByOwner: vi.fn(),
      onStart: vi.fn(),
      onEnd(listener: (event: PlaybackEndEvent<AudioBuffer>) => void) {
        endListeners.push(listener)
      },
      onInterrupt(listener: (event: { item: PlaybackItem<AudioBuffer>, reason: string, interruptedAt: number }) => void) {
        interruptListeners.push(event => listener({ ...event, interruptedAt: Date.now() }))
      },
      onReject: vi.fn(),
    },
  }
}

describe('createHeadlessSpeechHost', () => {
  it('maps speakText completion to SpeechPlaybackResult without Stage', async () => {
    const playback = createPlaybackHarness()
    const pipeline = createSpeechPipeline<AudioBuffer>({
      playback: playback.playback,
      async tts() {
        return Object.create(null) as AudioBuffer
      },
    })
    const host = createHeadlessSpeechHost()
    await host.registerHost(pipeline)

    const pending = host.speakText({
      sessionId: 's1',
      turnId: 't1',
      text: '你好',
      intentId: 'intent-1',
    })

    await vi.waitFor(() => {
      expect(playback.scheduled).toHaveLength(1)
    })
    playback.end(playback.scheduled[0]!)

    await expect(pending).resolves.toEqual({
      sessionId: 's1',
      turnId: 't1',
      intentId: 'intent-1',
      terminal: 'completed',
    })

    await host.dispose()
  })

  it('cancels speech by turnId for barge-in settlement', async () => {
    const playback = createPlaybackHarness()
    const pipeline = createSpeechPipeline<AudioBuffer>({
      playback: playback.playback,
      async tts() {
        return Object.create(null) as AudioBuffer
      },
    })
    const host = createHeadlessSpeechHost()
    await host.registerHost(pipeline)

    const pending = host.speakText({
      sessionId: 's1',
      turnId: 't-barge',
      text: '很长的一句话',
      intentId: 'intent-barge',
    })

    await vi.waitFor(() => {
      expect(host.listActiveIntents().some(item => item.turnId === 't-barge')).toBe(true)
    })

    const outcomes = await host.cancel({
      sessionId: 's1',
      turnId: 't-barge',
      scope: 'speech',
      reason: 'barge-in',
    })

    expect(outcomes).toEqual([{ status: 'cancelled', scope: 'speech' }])
    await expect(pending).resolves.toMatchObject({
      sessionId: 's1',
      turnId: 't-barge',
      intentId: 'intent-barge',
      terminal: 'interrupted',
    })

    await host.dispose()
  })
})
