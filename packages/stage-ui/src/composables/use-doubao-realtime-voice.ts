import type { DoubaoRealtimeVoiceCredentials } from '../libs/doubao-realtime-voice'
import type { DoubaoRealtimeVoiceUserTurn } from '../libs/doubaoRealtimeVoiceTurn'

import { errorMessageFrom } from '@moeru/std'
import { storeToRefs } from 'pinia'
import { onUnmounted, watch } from 'vue'

import workletUrl from '../workers/vad/process.worklet?worker&url'

import { DoubaoRealtimeVoiceSession } from '../libs/doubao-realtime-voice'
import { useSpeakingStore } from '../stores/audio'
import { useProvidersStore } from '../stores/providers'
import { useSettingsAudioDevice } from '../stores/settings'

export interface DoubaoRealtimeVoiceCallbacks {
  /** Resolves a credential-bound WebSocket URL for runtimes that proxy Doubao locally. */
  resolveConnectionUrl?: (credentials: DoubaoRealtimeVoiceCredentials) => Promise<string>
  /** Returns current character and runtime context prompt. */
  getSystemPrompt?: () => string | Promise<string>
  /** Refresh cadence for runtime context while a voice session remains active. */
  systemPromptRefreshMs?: number
  /** Returns character display name when a voice session starts. */
  getBotName?: () => string
  /** Returns stable conversation id used by Doubao to restore recent dialogue. */
  getDialogId?: () => string
  onUserTranscript?: (text: string) => void
  onUserTurn?: (turn: DoubaoRealtimeVoiceUserTurn) => void
  onAssistantText?: (text: string) => void
  onError?: (message: string) => void
}

/** Binds process-local microphone consent to the sole top-level voice runtime. */
export function useDoubaoRealtimeVoice(callbacks: DoubaoRealtimeVoiceCallbacks = {}) {
  const audioDevice = useSettingsAudioDevice()
  const providers = useProvidersStore()
  const speaking = useSpeakingStore()
  const { enabled, stream } = storeToRefs(audioDevice)
  let session: DoubaoRealtimeVoiceSession | undefined
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let refreshInFlight = false
  let generation = 0

  async function stop() {
    generation += 1
    clearInterval(refreshTimer)
    refreshTimer = undefined
    const current = session
    session = undefined
    await current?.stop()
  }

  async function start(currentStream: MediaStream) {
    const currentGeneration = ++generation
    await session?.stop()
    if (currentGeneration !== generation)
      return

    const credentials = resolveDoubaoRealtimeVoiceCredentials(providers.getProviderConfig('volcengine'))
    if (!credentials) {
      throw new Error(
        'Configure Volcengine App ID and Access Token (settings, or VITE_VOLCENGINE_APP_ID / VITE_VOLCENGINE_ACCESS_KEY in .env.play.local or services/minecraft/.env.local) before enabling microphone',
      )
    }
    const { appId, accessKey } = credentials

    const systemPrompt = (await callbacks.getSystemPrompt?.())?.trim()
    if (currentGeneration !== generation)
      return

    const next = new DoubaoRealtimeVoiceSession({
      workletUrl,
      credentials: { appId, accessKey },
      resolveConnectionUrl: callbacks.resolveConnectionUrl,
      systemPrompt,
      botName: callbacks.getBotName?.().trim(),
      dialogId: callbacks.getDialogId?.().trim(),
      onAssistantSpeaking(value) {
        speaking.nowSpeaking = value
      },
      onUserTranscript: callbacks.onUserTranscript,
      onUserTurn: callbacks.onUserTurn,
      onAssistantText: callbacks.onAssistantText,
      onError(error) {
        callbacks.onError?.(errorMessageFrom(error) || 'Doubao realtime voice failed')
      },
    })
    session = next
    await next.start(currentStream)
    if (currentGeneration !== generation) {
      await next.stop()
      if (session === next)
        session = undefined
      return
    }

    const refreshMs = callbacks.systemPromptRefreshMs
    if (callbacks.getSystemPrompt != null && refreshMs != null && refreshMs > 0) {
      refreshTimer = setInterval(() => {
        if (refreshInFlight || currentGeneration !== generation || session !== next)
          return
        refreshInFlight = true
        void Promise.resolve()
          .then(() => callbacks.getSystemPrompt!())
          .then((prompt) => {
            if (currentGeneration === generation && session === next)
              next.updateSystemPrompt(prompt)
          })
          .catch((error) => {
            if (currentGeneration === generation) {
              callbacks.onError?.(
                errorMessageFrom(error) || 'Failed to refresh Doubao realtime voice context',
              )
            }
          })
          .finally(() => {
            refreshInFlight = false
          })
      }, refreshMs)
    }
  }

  const stopWatch = watch([enabled, stream], async ([isEnabled, currentStream]) => {
    try {
      if (!isEnabled) {
        await stop()
        return
      }
      if (!currentStream) {
        await audioDevice.askPermission()
        await audioDevice.startStream()
        return
      }
      await start(currentStream)
    }
    catch (error) {
      callbacks.onError?.(errorMessageFrom(error) || 'Doubao realtime voice failed')
      enabled.value = false
    }
  }, { immediate: true })

  /**
   * Immediately rebuilds Doubao system_role from the latest Layer 2/3 context.
   * Call after a companion turn settles so action facts reach speech promptly.
   */
  async function refreshSystemPrompt() {
    if (session == null || callbacks.getSystemPrompt == null || refreshInFlight)
      return
    const active = session
    const currentGeneration = generation
    refreshInFlight = true
    try {
      const prompt = await callbacks.getSystemPrompt()
      if (currentGeneration === generation && session === active)
        active.updateSystemPrompt(prompt)
    }
    finally {
      refreshInFlight = false
    }
  }

  onUnmounted(() => {
    stopWatch()
    void stop()
  })

  return { stop, refreshSystemPrompt }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Play-env `VITE_VOLCENGINE_*` wins when present; otherwise provider store.
 * Keeps `pnpm dev:play` credentials ahead of stale browser settings.
 *
 * @param config - `volcengine` provider config from the providers store
 */
export function resolveDoubaoRealtimeVoiceCredentials(
  config: unknown,
): DoubaoRealtimeVoiceCredentials | undefined {
  const fromEnvAppId = String(import.meta.env.VITE_VOLCENGINE_APP_ID ?? '').trim()
  const fromEnvAccessKey = String(import.meta.env.VITE_VOLCENGINE_ACCESS_KEY ?? '').trim()
  if (fromEnvAppId && fromEnvAccessKey)
    return { appId: fromEnvAppId, accessKey: fromEnvAccessKey }

  const record = isRecord(config) ? config : undefined
  const app = isRecord(record?.app) ? record.app : undefined
  const fromStoreAppId = typeof app?.appId === 'string' ? app.appId.trim() : ''
  const fromStoreAccessKey = typeof record?.apiKey === 'string' ? record.apiKey.trim() : ''
  if (!fromStoreAppId || !fromStoreAccessKey)
    return undefined
  return { appId: fromStoreAppId, accessKey: fromStoreAccessKey }
}
