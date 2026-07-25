import { errorMessageFrom } from '@moeru/std'
import { ref } from 'vue'

/** One row in the on-page conversation feed. */
export interface WebConsoleFeedItem {
  role: 'user' | 'assistant' | 'system'
  text: string
  at: number
}

/** One row in the on-page log panel. */
export interface WebConsoleLogItem {
  level: 'info' | 'error'
  message: string
  at: number
}

/** Settled Doubao ASR turn shape used by the console feed. */
export interface WebConsoleUserTurn {
  turnId: string
  text: string
}

/**
 * Audio + realtime-voice ports the console page owns externally.
 *
 * Injected so unit/integration tests can drive mic and Doubao events without
 * Pinia, Electron, or network.
 */
export interface WebConsoleControllerDeps {
  /** Process-local microphone consent flag (mirrored into `micEnabled`). */
  getMicDeviceEnabled: () => boolean
  setMicDeviceEnabled: (enabled: boolean) => void
  askPermission: () => Promise<void>
  startStream: () => Promise<void>
  stopRealtimeVoice: () => Promise<void>
  /** @default Date.now */
  now?: () => number
  /** @default 200 */
  logLimit?: number
}

const DEFAULT_LOG_LIMIT = 200

/**
 * Appends a log entry and trims the ring buffer to `logLimit`.
 *
 * Before:
 * - logs length 200, push one more
 *
 * After:
 * - logs length stays 200 (oldest dropped)
 */
export function appendLogEntry(
  logs: WebConsoleLogItem[],
  entry: WebConsoleLogItem,
  logLimit: number = DEFAULT_LOG_LIMIT,
): WebConsoleLogItem[] {
  const next = [...logs, entry]
  if (next.length > logLimit)
    return next.slice(-logLimit)
  return next
}

/**
 * Creates the minimal web console controller (mic / feed / logs).
 *
 * Call stack:
 *
 * page setup
 * -> {@link createWebConsoleController}
 * -> toggleMic / Doubao voice callbacks
 * -> feed + logs state for the view
 */
export function createWebConsoleController(deps: WebConsoleControllerDeps) {
  const now = deps.now ?? Date.now
  const logLimit = deps.logLimit ?? DEFAULT_LOG_LIMIT

  const feed = ref<WebConsoleFeedItem[]>([])
  const logs = ref<WebConsoleLogItem[]>([])
  const textInput = ref('')
  const partialTranscript = ref('')
  const micEnabled = ref(false)
  const voicePhase = ref('idle')
  const errorText = ref<string | null>(null)

  /**
   * Appends a log line and keeps a bounded ring buffer.
   */
  function appendLog(level: WebConsoleLogItem['level'], message: string) {
    logs.value = appendLogEntry(logs.value, { level, message, at: now() }, logLimit)
  }

  /**
   * Records an error for both the highlight line and the log panel.
   */
  function reportError(message: string) {
    errorText.value = message
    appendLog('error', message)
  }

  /**
   * Updates voice phase and records the transition in the log panel.
   */
  function setVoicePhase(phase: string) {
    const previous = voicePhase.value
    if (previous === phase)
      return
    voicePhase.value = phase
    appendLog('info', `voice phase: ${previous} → ${phase}`)
  }

  /**
   * Doubao callbacks the page wires into `useDoubaoRealtimeVoice`.
   */
  const voiceCallbacks = {
    onUserTranscript(text: string) {
      partialTranscript.value = text
    },
    onUserTurn(doubaoTurn: WebConsoleUserTurn) {
      partialTranscript.value = ''
      feed.value.push({ role: 'user', text: doubaoTurn.text, at: now() })
      appendLog('info', `user turn: ${doubaoTurn.text}`)
      setVoicePhase(micEnabled.value ? 'listening' : 'idle')
    },
    onAssistantText(text: string) {
      feed.value.push({ role: 'assistant', text, at: now() })
      appendLog('info', `assistant: ${text}`)
      setVoicePhase('speaking')
    },
    onError(message: string) {
      reportError(message)
      deps.setMicDeviceEnabled(false)
      micEnabled.value = false
      setVoicePhase('error')
    },
  }

  /**
   * Toggles browser microphone capture; Doubao session follows device enabled.
   */
  async function toggleMic() {
    errorText.value = null
    try {
      const next = !deps.getMicDeviceEnabled()
      if (next) {
        setVoicePhase('connecting')
        appendLog('info', 'microphone: requesting permission')
        await deps.askPermission()
        await deps.startStream()
        deps.setMicDeviceEnabled(true)
        micEnabled.value = true
        setVoicePhase('listening')
        appendLog('info', 'microphone: on')
      }
      else {
        deps.setMicDeviceEnabled(false)
        micEnabled.value = false
        await deps.stopRealtimeVoice()
        setVoicePhase('idle')
        appendLog('info', 'microphone: off')
      }
    }
    catch (error) {
      reportError(errorMessageFrom(error) ?? 'Microphone update failed')
      deps.setMicDeviceEnabled(false)
      micEnabled.value = false
      setVoicePhase('error')
    }
  }

  /**
   * Clears in-flight speaking state after a user interrupt.
   */
  function onInterrupt() {
    appendLog('info', 'interrupt')
    setVoicePhase(micEnabled.value ? 'listening' : 'idle')
  }

  /**
   * Debug text input that only appends to the local conversation feed.
   */
  function sendText() {
    const text = textInput.value.trim()
    if (!text)
      return
    textInput.value = ''
    feed.value.push({ role: 'user', text, at: now() })
    appendLog('info', `text: ${text}`)
  }

  /**
   * Syncs mic UI state after audio-device store initialization.
   */
  function onMountedReady() {
    micEnabled.value = deps.getMicDeviceEnabled()
    setVoicePhase(micEnabled.value ? 'listening' : 'idle')
    appendLog('info', 'console ready')
  }

  /**
   * Stops capture and realtime voice when the page unmounts.
   */
  async function onUnmountedCleanup() {
    deps.setMicDeviceEnabled(false)
    micEnabled.value = false
    await deps.stopRealtimeVoice()
  }

  return {
    feed,
    logs,
    textInput,
    partialTranscript,
    micEnabled,
    voicePhase,
    errorText,
    voiceCallbacks,
    appendLog,
    reportError,
    setVoicePhase,
    toggleMic,
    onInterrupt,
    sendText,
    onMountedReady,
    onUnmountedCleanup,
  }
}

export type WebConsoleController = ReturnType<typeof createWebConsoleController>
