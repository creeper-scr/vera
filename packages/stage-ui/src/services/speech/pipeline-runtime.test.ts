import type {
  PlaybackEndEvent,
  PlaybackItem,
} from '@proj-vera/pipelines-audio'

import { createSpeechPipeline } from '@proj-vera/pipelines-audio'
import { describe, expect, it, vi } from 'vitest'

import { createSpeechPipelineRuntime } from './pipeline-runtime'

function createPlaybackHarness() {
  const scheduled: Array<PlaybackItem<AudioBuffer>> = []
  const endListeners: Array<(event: PlaybackEndEvent<AudioBuffer>) => void> = []

  return {
    scheduled,
    end(item: PlaybackItem<AudioBuffer>) {
      for (const listener of endListeners)
        listener({ item, endedAt: Date.now() })
    },
    playback: {
      schedule(item: PlaybackItem<AudioBuffer>) {
        scheduled.push(item)
      },
      stopAll: vi.fn(),
      stopByIntent: vi.fn(),
      stopByOwner: vi.fn(),
      onStart: vi.fn(),
      onEnd(listener: (event: PlaybackEndEvent<AudioBuffer>) => void) {
        endListeners.push(listener)
      },
      onInterrupt: vi.fn(),
      onReject: vi.fn(),
    },
  }
}

describe('speech pipeline runtime', () => {
  it('settles an intent only after real playback ends', async () => {
    const playback = createPlaybackHarness()
    const pipeline = createSpeechPipeline<AudioBuffer>({
      playback: playback.playback,
      async tts() {
        // Pipeline treats audio as opaque data; no Web Audio API behavior is
        // needed to verify terminal correlation in this Node test.
        return Object.create(null) as AudioBuffer
      },
    })
    const runtime = createSpeechPipelineRuntime()
    await runtime.registerHost(pipeline)

    const intent = runtime.openIntent({ intentId: 'intent-1' })
    let settled = false
    const finished = runtime.waitForIntent(intent.intentId).then((result) => {
      settled = true
      return result
    })
    intent.writeLiteral('Hello')
    intent.writeFlush()
    intent.end()

    await vi.waitFor(() => {
      expect(playback.scheduled).toHaveLength(1)
    })
    expect(settled).toBe(false)

    playback.end(playback.scheduled[0]!)

    await expect(finished).resolves.toEqual({ status: 'completed' })
    await runtime.dispose()
  })

  it('reports failure when synthesis produces no playable audio', async () => {
    const playback = createPlaybackHarness()
    const pipeline = createSpeechPipeline<AudioBuffer>({
      playback: playback.playback,
      async tts() {
        return null
      },
    })
    const runtime = createSpeechPipelineRuntime()
    await runtime.registerHost(pipeline)

    const intent = runtime.openIntent({ intentId: 'intent-without-audio' })
    const finished = runtime.waitForIntent(intent.intentId)
    intent.writeLiteral('Hello')
    intent.writeFlush()
    intent.end()

    await expect(finished).resolves.toEqual({
      status: 'failed',
      error: 'Speech synthesis produced no playable audio',
    })
    expect(playback.scheduled).toHaveLength(0)
    await runtime.dispose()
  })

  it('correlates playback completion back to a remote speech runtime', async () => {
    const playback = createPlaybackHarness()
    const pipeline = createSpeechPipeline<AudioBuffer>({
      playback: playback.playback,
      async tts() {
        return Object.create(null) as AudioBuffer
      },
    })
    const hostRuntime = createSpeechPipelineRuntime()
    const clientRuntime = createSpeechPipelineRuntime()
    await hostRuntime.registerHost(pipeline)

    const intent = clientRuntime.openIntent({ intentId: 'remote-intent' })
    const finished = clientRuntime.waitForIntent(intent.intentId)
    intent.writeLiteral('Remote hello')
    intent.writeFlush()
    intent.end()

    await vi.waitFor(() => {
      expect(playback.scheduled).toHaveLength(1)
    })
    playback.end(playback.scheduled[0]!)

    await expect(finished).resolves.toEqual({ status: 'completed' })
    await clientRuntime.dispose()
    await hostRuntime.dispose()
  })
})
