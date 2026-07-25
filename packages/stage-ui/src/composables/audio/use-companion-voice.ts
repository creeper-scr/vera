import type {
  CompanionMicMode,
  CompanionVoiceController,
  CompanionVoiceControllerDeps,
} from '@proj-vera/core-agent'
import type { MaybeRefOrGetter } from 'vue'

import { createCompanionVoiceController } from '@proj-vera/core-agent'
import { toValue } from 'vue'

import { useVoiceInputSession } from './voice-input-session'

export interface UseCompanionVoiceOptions extends Omit<CompanionVoiceControllerDeps, 'sessionId'> {
  sessionId: MaybeRefOrGetter<string>
  /**
   * When true, start VAD/volume auto-segmentation as soon as media is available
   * and mic is enabled. PTT mode uses manual segments only.
   * @default true
   */
  autoStartVad?: boolean
}

/**
 * Thin media wiring for {@link createCompanionVoiceController}.
 *
 * Reuses {@link useVoiceInputSession} for recorder/VAD/STT. Product policy
 * (VoiceTurn emission, barge-in, phase) stays in core-agent.
 */
export function useCompanionVoice(
  media: MaybeRefOrGetter<MediaStream | undefined>,
  options: UseCompanionVoiceOptions,
) {
  const controller: CompanionVoiceController = createCompanionVoiceController({
    ...options,
    sessionId: toValue(options.sessionId),
    getSessionId: () => toValue(options.sessionId),
  })

  const session = useVoiceInputSession(media, {
    volumeFallback: { enabled: true },
    async onTranscriptionResult(event) {
      if (!event.text)
        return
      await controller.finalizeTranscript({
        text: event.text,
        source: `hearing:${event.trigger ?? 'manual'}`,
      })
    },
  })

  async function setMicEnabled(enabled: boolean) {
    controller.setMicEnabled(enabled)
    if (!enabled) {
      await session.stop({ flushActiveRecording: false })
      return
    }
    if (controller.getMicMode() === 'vad' && (options.autoStartVad ?? true))
      await session.startAutoSegmentation()
  }

  async function setMicMode(mode: CompanionMicMode) {
    const previous = controller.getMicMode()
    controller.setMicMode(mode)
    if (!controller.getMicEnabled())
      return

    if (mode === 'vad' && previous !== 'vad' && (options.autoStartVad ?? true)) {
      await session.stop({ flushActiveRecording: false })
      await session.startAutoSegmentation()
      return
    }

    if (mode === 'ptt' && previous !== 'ptt') {
      // PTT owns segments via beginPtt/endPtt; stop auto detectors.
      await session.stop({ flushActiveRecording: false })
      controller.setMicEnabled(true)
    }
  }

  async function beginPtt() {
    controller.beginPtt()
    await session.startSegment('manual')
  }

  async function endPtt() {
    await session.stopSegment('manual')
    controller.endPtt()
  }

  async function dispose() {
    await session.stop({ flushActiveRecording: false })
    controller.dispose()
  }

  return {
    controller,
    session,
    setMicEnabled,
    setMicMode,
    beginPtt,
    endPtt,
    dispose,
  }
}
