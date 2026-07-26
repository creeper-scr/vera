<script setup lang="ts">
/**
 * Web companion console: Doubao voice (L1) + CompanionAgentRuntime (L2)
 * over server-runtime game:coop (L3).
 *
 * No Live2D/Stage, Electron Eventa, or desktop shell. Game attach is a
 * local adapterId + WS session against server-runtime.
 */
import type { VoiceTurn } from '@proj-vera/core-agent'

import { errorMessageFrom } from '@moeru/std'
import { useDoubaoRealtimeVoice } from '@proj-vera/stage-ui/composables/use-doubao-realtime-voice'
import { useCompanionSession } from '@proj-vera/stage-ui/composables/useCompanionSession'
import { GAME_VOICE_SYSTEM_PROMPT_REFRESH_MS } from '@proj-vera/stage-ui/services/game-coop/gameVoiceSystemPrompt'
import { useModsServerChannelStore } from '@proj-vera/stage-ui/stores/mods/api/channel-server'
import { useVeraCardStore } from '@proj-vera/stage-ui/stores/modules'
import { useConsciousnessStore } from '@proj-vera/stage-ui/stores/modules/consciousness'
import { useSettingsAudioDevice } from '@proj-vera/stage-ui/stores/settings'
import { nanoid } from 'nanoid'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref } from 'vue'

import LanSharePanel from '../components/LanSharePanel.vue'

import { readPlayLlmCredentials } from '../composables/seedPlayProviders'
import { stripCompanionDisplayMarkers } from '../composables/stripCompanionDisplayMarkers'

/** Static catalog for web attach (no Electron game manager). */
const GAME_CATALOG = [
  { adapterId: 'minecraft', displayName: 'Minecraft' },
  { adapterId: 'stardew', displayName: 'Stardew Valley' },
  { adapterId: 'dst', displayName: 'Don\'t Starve Together' },
] as const

type GameHealth = 'unknown' | 'connected' | 'disconnected' | 'error'

const selectedAdapterId = ref<string>('minecraft')
const sessionId = ref(`companion-local-${nanoid(8)}`)
const connectedAdapterId = ref<string | null>(null)
const health = ref<GameHealth>('unknown')
const busy = ref(false)
const errorText = ref<string | null>(null)

const feed = ref<Array<{ role: 'user' | 'assistant' | 'system', text: string, at: number }>>([])
const textInput = ref('')
const partialTranscript = ref('')
const micEnabled = ref(false)
const voicePhase = ref('idle')
const activeTurnId = ref<string | null>(null)

const audioDevice = useSettingsAudioDevice()
const veraCard = useVeraCardStore()
veraCard.initialize()
const { enabled: micDeviceEnabled } = storeToRefs(audioDevice)
const serverChannelStore = useModsServerChannelStore()
const consciousness = useConsciousnessStore()
const { activeProvider, activeModel } = storeToRefs(consciousness)
const playLlm = readPlayLlmCredentials()
const llmLabel = computed(() => {
  if (!activeProvider.value || !activeModel.value)
    return 'llm unset'
  const source = playLlm ? 'play env' : 'browser'
  return `${activeProvider.value}/${activeModel.value} (${source})`
})

const adapterId = computed(() => connectedAdapterId.value ?? selectedAdapterId.value)

const companion = useCompanionSession({
  sessionId,
  adapterId,
  onTurnResult(result, turn) {
    // Doubao owns audible/user-visible realtime dialogue. Decision model
    // answers stay out of the feed for doubao-sourced turns.
    if (result.assistantText && turn.metadata.source !== 'doubao-realtime') {
      const text = stripCompanionDisplayMarkers(result.assistantText)
      if (text) {
        feed.value.push({
          role: 'assistant',
          text,
          at: Date.now(),
        })
      }
    }
    else if (result.status === 'failed' || result.status === 'ignored') {
      feed.value.push({
        role: 'system',
        text: `${result.status}${result.reason ? `: ${result.reason}` : ''}`,
        at: Date.now(),
      })
    }
  },
  onObservationResult(result) {
    if (result?.assistantText) {
      const text = stripCompanionDisplayMarkers(result.assistantText)
      if (text) {
        feed.value.push({
          role: 'assistant',
          text,
          at: Date.now(),
        })
      }
    }
  },
})

const realtimeVoice = useDoubaoRealtimeVoice({
  getSystemPrompt: companion.getSystemPrompt,
  systemPromptRefreshMs: GAME_VOICE_SYSTEM_PROMPT_REFRESH_MS,
  getBotName: () => veraCard.activeCard?.name ?? 'Vera',
  getDialogId: () => `vera-web-companion:${veraCard.activeCardId || 'default'}`,
  onUserTranscript(text) {
    partialTranscript.value = text
  },
  async onUserTurn(doubaoTurn) {
    const turn: VoiceTurn = {
      sessionId: sessionId.value,
      turnId: doubaoTurn.turnId,
      text: doubaoTurn.text,
      createdAt: Date.now(),
      metadata: {
        source: 'doubao-realtime',
        eventId: doubaoTurn.turnId,
      },
    }
    partialTranscript.value = ''
    activeTurnId.value = turn.turnId
    feed.value.push({ role: 'user', text: turn.text, at: turn.createdAt })
    voicePhase.value = 'thinking'
    try {
      await companion.ingestVoiceTurn(turn)
    }
    catch (error) {
      errorText.value = errorMessageFrom(error) ?? 'Voice turn failed'
    }
    finally {
      // Push settled action facts into Doubao before the next spoken turn.
      void realtimeVoice.refreshSystemPrompt()
      voicePhase.value = micEnabled.value ? 'listening' : 'idle'
    }
  },
  onAssistantText(text) {
    const cleaned = stripCompanionDisplayMarkers(text)
    if (cleaned) {
      feed.value.push({ role: 'assistant', text: cleaned, at: Date.now() })
      companion.rememberSpokenUtterance(cleaned)
    }
    voicePhase.value = 'speaking'
  },
  onError(message) {
    errorText.value = message
    micDeviceEnabled.value = false
    micEnabled.value = false
    voicePhase.value = 'error'
  },
})

const agentPhase = computed(() => companion.phase.value)
const toolNamesLabel = computed(() => (companion.toolNames.value ?? []).join(', ') || '—')
const channelConnected = computed(() => serverChannelStore.connected)

/**
 * Attaches the web stage to a remote game adapter over server-runtime WS.
 */
async function onConnect() {
  busy.value = true
  errorText.value = null
  try {
    await serverChannelStore.initialize()
    if (!serverChannelStore.connected) {
      health.value = 'error'
      errorText.value = 'Server channel is not connected. Run `pnpm dev:server` and set VITE_VERA_WS_URL if needed.'
      return
    }

    sessionId.value = `web-${selectedAdapterId.value}-${nanoid(8)}`
    connectedAdapterId.value = selectedAdapterId.value
    health.value = 'connected'
    companion.startWorldObservations()
  }
  catch (error) {
    health.value = 'error'
    errorText.value = errorMessageFrom(error) ?? 'Game connection failed'
  }
  finally {
    busy.value = false
  }
}

/**
 * Stops world observations and clears the local attach state.
 */
async function onDisconnect() {
  busy.value = true
  try {
    companion.stopWorldObservations()
    connectedAdapterId.value = null
    health.value = 'disconnected'
  }
  catch (error) {
    errorText.value = errorMessageFrom(error) ?? 'Game disconnect failed'
  }
  finally {
    busy.value = false
  }
}

/**
 * Re-attaches with a fresh session id on the selected adapter.
 */
async function onReconnect() {
  companion.stopWorldObservations()
  await onConnect()
}

/**
 * Toggles browser microphone capture; Doubao session follows device enabled.
 */
async function toggleMic() {
  errorText.value = null
  try {
    const next = !micDeviceEnabled.value
    if (next) {
      voicePhase.value = 'connecting'
      await audioDevice.askPermission()
      await audioDevice.startStream()
      micDeviceEnabled.value = true
      micEnabled.value = true
      voicePhase.value = 'listening'
    }
    else {
      micDeviceEnabled.value = false
      micEnabled.value = false
      await realtimeVoice.stop()
      voicePhase.value = 'idle'
    }
  }
  catch (error) {
    errorText.value = errorMessageFrom(error) ?? 'Microphone update failed'
    micDeviceEnabled.value = false
    micEnabled.value = false
    voicePhase.value = 'error'
  }
}

/**
 * Cancels the active companion turn after a user interrupt.
 */
async function onInterrupt() {
  if (activeTurnId.value != null)
    await companion.cancelTurn(activeTurnId.value, 'user-interrupt')
  voicePhase.value = micEnabled.value ? 'listening' : 'idle'
}

/**
 * Sends a typed turn into Layer 2 (and the conversation feed).
 */
async function sendText() {
  const text = textInput.value.trim()
  if (!text)
    return
  textInput.value = ''
  const turn: VoiceTurn = {
    sessionId: sessionId.value,
    turnId: `text-${Date.now().toString(36)}`,
    text,
    createdAt: Date.now(),
    metadata: {
      source: 'companion-text',
      eventId: `text-event-${Date.now().toString(36)}`,
    },
  }
  activeTurnId.value = turn.turnId
  feed.value.push({ role: 'user', text, at: turn.createdAt })
  try {
    await companion.ingestVoiceTurn(turn)
  }
  catch (error) {
    errorText.value = errorMessageFrom(error) ?? 'Companion turn failed'
  }
  finally {
    void realtimeVoice.refreshSystemPrompt()
  }
}

onMounted(async () => {
  await audioDevice.initialize()
  micEnabled.value = micDeviceEnabled.value
  voicePhase.value = micEnabled.value ? 'listening' : 'idle'
})

onUnmounted(() => {
  companion.stopWorldObservations()
  void realtimeVoice.stop()
})
</script>

<template>
  <div
    data-testid="web-console"
    :class="[
      'min-h-100dvh w-full flex flex-col gap-4 p-4 md:p-6',
      'bg-[#14120f] text-[#f3eee4]',
      'select-none',
    ]"
  >
    <header :class="['flex flex-col gap-3 md:flex-row md:items-end md:justify-between']">
      <div :class="['min-w-0']">
        <h1 :class="['m-0 text-3xl font-semibold tracking-tight text-[#f3eee4] md:text-4xl']" style="font-family: Spectral, 'Noto Serif SC', Georgia, serif;">
          Vera
        </h1>
        <p :class="['mt-1 mb-0 max-w-md text-sm text-[#a89f90]']">
          进入游戏世界，和你一起行动。
        </p>
      </div>
      <div
        data-testid="web-console-voice-phase"
        :class="['flex flex-wrap items-center gap-2 text-xs text-[#a89f90]']"
      >
        <span :class="['rounded-full border border-[rgba(243,238,228,0.1)] bg-[#1c1914] px-2.5 py-1']">{{ health }}</span>
        <span :class="['rounded-full border border-[rgba(243,238,228,0.1)] bg-[#1c1914] px-2.5 py-1']">
          ws {{ channelConnected ? 'up' : 'down' }}
        </span>
        <span :class="['rounded-full border border-[rgba(243,238,228,0.1)] bg-[#1c1914] px-2.5 py-1']">
          agent {{ agentPhase }}
        </span>
        <span :class="['rounded-full border border-[rgba(243,238,228,0.1)] bg-[#1c1914] px-2.5 py-1']">
          voice {{ voicePhase }}
        </span>
        <span
          data-testid="web-console-llm"
          :class="['rounded-full border border-[rgba(243,238,228,0.1)] bg-[#1c1914] px-2.5 py-1']"
        >{{ llmLabel }}</span>
      </div>
    </header>

    <div :class="['min-h-0 flex flex-1 flex-col gap-4 lg:grid lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]']">
      <aside :class="['flex flex-col gap-3']">
        <section :class="['flex flex-col gap-3 rounded-2xl border border-[rgba(243,238,228,0.1)] bg-[#1c1914] p-4']">
          <label :class="['text-xs font-medium tracking-wide text-[#a89f90]']">
            选择游戏
          </label>
          <select
            v-model="selectedAdapterId"
            data-testid="web-console-game-select"
            :class="[
              'rounded-xl border border-[rgba(243,238,228,0.1)] bg-[#14120f]',
              'px-3 py-2.5 text-sm text-[#f3eee4] outline-none',
              'focus:border-[#c9a46c]',
            ]"
          >
            <option
              v-for="entry in GAME_CATALOG"
              :key="entry.adapterId"
              :value="entry.adapterId"
            >
              {{ entry.displayName }}
            </option>
          </select>

          <div :class="['flex flex-wrap gap-2']">
            <button
              type="button"
              data-testid="web-console-connect"
              :disabled="busy"
              :class="[
                'rounded-xl bg-[#c9a46c] px-3 py-2 text-xs font-semibold text-[#1a1610]',
                'disabled:opacity-50 hover:bg-[#d4b17d]',
              ]"
              @click="onConnect"
            >
              连接
            </button>
            <button
              type="button"
              data-testid="web-console-disconnect"
              :disabled="busy"
              :class="[
                'rounded-xl border border-[rgba(243,238,228,0.12)] bg-transparent',
                'px-3 py-2 text-xs text-[#f3eee4] disabled:opacity-50 hover:bg-[#252018]',
              ]"
              @click="onDisconnect"
            >
              断开
            </button>
            <button
              type="button"
              data-testid="web-console-reconnect"
              :disabled="busy"
              :class="[
                'rounded-xl border border-[rgba(243,238,228,0.12)] bg-transparent',
                'px-3 py-2 text-xs text-[#f3eee4] disabled:opacity-50 hover:bg-[#252018]',
              ]"
              @click="onReconnect"
            >
              重连
            </button>
          </div>

          <dl :class="['grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs text-[#d8d0c2]']">
            <dt :class="['text-[#a89f90]']">
              adapter
            </dt>
            <dd>{{ connectedAdapterId ?? '—' }}</dd>
            <dt :class="['text-[#a89f90]']">
              session
            </dt>
            <dd class="truncate">
              {{ sessionId }}
            </dd>
            <dt :class="['text-[#a89f90]']">
              tools
            </dt>
            <dd class="truncate">
              {{ toolNamesLabel }}
            </dd>
          </dl>
        </section>

        <LanSharePanel />

        <section :class="['flex flex-col gap-2 rounded-2xl border border-[rgba(243,238,228,0.1)] bg-[#1c1914] p-4']">
          <div :class="['flex flex-wrap items-center gap-2']">
            <button
              type="button"
              data-testid="web-console-mic"
              :class="[
                'rounded-xl px-3 py-2 text-xs font-semibold',
                micEnabled
                  ? 'bg-[#c45c48] text-[#fff8f5]'
                  : 'border border-[rgba(243,238,228,0.12)] bg-transparent text-[#f3eee4]',
              ]"
              @click="toggleMic"
            >
              {{ micEnabled ? '麦克风开' : '麦克风关' }}
            </button>
            <span :class="['text-xs text-[#a89f90]']">
              Doubao · server VAD
            </span>
            <button
              type="button"
              data-testid="web-console-interrupt"
              :class="[
                'rounded-xl border border-[rgba(243,238,228,0.12)] bg-transparent',
                'px-3 py-2 text-xs text-[#f3eee4] hover:bg-[#252018]',
              ]"
              @click="onInterrupt"
            >
              打断
            </button>
          </div>
          <p
            v-if="partialTranscript"
            data-testid="web-console-partial"
            :class="['m-0 text-xs text-[#a89f90]']"
          >
            识别中：{{ partialTranscript }}
          </p>
        </section>
      </aside>

      <section
        data-testid="web-console-conversation"
        :class="[
          'min-h-72 flex flex-1 flex-col overflow-hidden rounded-2xl',
          'border border-[rgba(243,238,228,0.1)] bg-[#1c1914]',
        ]"
      >
        <div :class="['border-b border-[rgba(243,238,228,0.08)] px-4 py-3 text-xs font-medium text-[#a89f90]']">
          对话
        </div>
        <div :class="['min-h-0 flex flex-1 flex-col gap-2.5 overflow-auto px-4 py-3']">
          <div
            v-for="(item, index) in feed"
            :key="`${item.at}-${index}`"
            data-testid="web-console-feed-item"
            :class="[
              'max-w-[92%] rounded-xl px-3 py-2 text-sm leading-relaxed',
              item.role === 'user' ? 'self-end bg-[#2a3328] text-[#d5e0c8]' : '',
              item.role === 'assistant' ? 'self-start bg-[#2e261c] text-[#f0e2c8]' : '',
              item.role === 'system' ? 'self-center bg-transparent px-1 py-0.5 text-center text-xs text-[#a89f90]' : '',
            ]"
          >
            <span
              v-if="item.role !== 'system'"
              :class="['mb-0.5 block text-[0.65rem] uppercase tracking-wide opacity-55']"
            >{{ item.role }}</span>
            {{ item.text }}
          </div>
          <p
            v-if="feed.length === 0"
            data-testid="web-console-conversation-empty"
            :class="['m-auto max-w-xs text-center text-sm text-[#a89f90]']"
          >
            先连接游戏，再用语音或文字和 Vera 说话。
          </p>
        </div>

        <form
          data-testid="web-console-text-form"
          :class="['flex gap-2 border-t border-[rgba(243,238,228,0.08)] p-3']"
          @submit.prevent="sendText"
        >
          <input
            v-model="textInput"
            type="text"
            data-testid="web-console-text-input"
            placeholder="对 Vera 说点什么…"
            :class="[
              'min-w-0 flex-1 rounded-xl border border-[rgba(243,238,228,0.1)]',
              'bg-[#14120f] px-3 py-2.5 text-sm text-[#f3eee4] outline-none',
              'placeholder:text-[#7d7568] focus:border-[#c9a46c]',
            ]"
          >
          <button
            type="submit"
            data-testid="web-console-send"
            :class="[
              'rounded-xl bg-[#c9a46c] px-4 py-2.5 text-xs font-semibold text-[#1a1610]',
              'hover:bg-[#d4b17d]',
            ]"
          >
            发送
          </button>
        </form>
      </section>
    </div>

    <p
      v-if="errorText || companion.lastError"
      data-testid="web-console-error"
      :class="[
        'm-0 rounded-xl border border-[rgba(196,92,72,0.35)]',
        'bg-[rgba(196,92,72,0.1)] px-3 py-2 text-xs text-[#f0b4a8]',
      ]"
    >
      {{ errorText || companion.lastError }}
    </p>
  </div>
</template>

<route lang="yaml">
meta:
  layout: plain
  title: Vera
</route>
