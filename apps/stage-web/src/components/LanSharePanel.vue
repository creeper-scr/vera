<script setup lang="ts">
/**
 * Hackathon LAN share: publish chat-sessions export + show QR for mobile.html.
 */
import type { LanShareInfo } from '../composables/lanShare'

import { errorMessageFrom } from '@moeru/std'
import { useChatSessionStore } from '@proj-vera/stage-ui/stores/chat/session-store'
import { computed, ref } from 'vue'

import {
  fetchLanShareInfo,
  lanQrImageUrl,
  publishLanChatExport,
} from '../composables/lanShare'

const chatSession = useChatSessionStore()

const busy = ref(false)
const errorText = ref<string | null>(null)
const info = ref<LanShareInfo | null>(null)
const publishedAt = ref<number | null>(null)

const primaryMobileUrl = computed(() => info.value?.mobilePaths[0] ?? null)
const qrUrl = computed(() => (
  primaryMobileUrl.value ? lanQrImageUrl(primaryMobileUrl.value) : null
))

/**
 * Exports all chat sessions to the Vite LAN middleware and refreshes QR links.
 */
async function shareToPhone() {
  busy.value = true
  errorText.value = null
  try {
    const payload = await chatSession.exportSessions()
    const result = await publishLanChatExport(payload)
    publishedAt.value = result.updatedAt
    info.value = await fetchLanShareInfo()
  }
  catch (error) {
    errorText.value = errorMessageFrom(error) ?? 'LAN share failed'
  }
  finally {
    busy.value = false
  }
}

/**
 * Refreshes LAN IP / URL list without re-exporting.
 */
async function refreshInfo() {
  busy.value = true
  errorText.value = null
  try {
    info.value = await fetchLanShareInfo()
  }
  catch (error) {
    errorText.value = errorMessageFrom(error) ?? 'LAN info failed'
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <section
    data-testid="lan-share-panel"
    :class="[
      'flex flex-col gap-3 rounded-2xl border border-[rgba(243,238,228,0.1)]',
      'bg-[#1c1914] p-4',
    ]"
  >
    <div :class="['flex flex-wrap items-center justify-between gap-2']">
      <div>
        <div :class="['text-sm font-medium text-[#f3eee4]']">
          带到手机
        </div>
        <p :class="['m-0 mt-0.5 text-xs text-[#a89f90]']">
          游戏记忆 → Vera 随身页
        </p>
      </div>
      <div :class="['flex gap-2']">
        <button
          type="button"
          data-testid="lan-share-refresh"
          :disabled="busy"
          :class="[
            'rounded-xl border border-[rgba(243,238,228,0.12)] bg-transparent',
            'px-3 py-2 text-xs text-[#f3eee4] disabled:opacity-50 hover:bg-[#252018]',
          ]"
          @click="refreshInfo"
        >
          刷新地址
        </button>
        <button
          type="button"
          data-testid="lan-share-publish"
          :disabled="busy"
          :class="[
            'rounded-xl bg-[#c9a46c] px-3 py-2 text-xs font-semibold text-[#1a1610]',
            'disabled:opacity-50 hover:bg-[#d4b17d]',
          ]"
          @click="shareToPhone"
        >
          {{ busy ? '处理中…' : '分享到手机' }}
        </button>
      </div>
    </div>

    <p :class="['m-0 text-xs leading-relaxed text-[#a89f90]']">
      导出完整会话到局域网，手机打开随身页（按住说 / 自动听）。豆包经同域代理。
      <template v-if="info?.https">
        麦克风：HTTPS 已开。
      </template>
      <template v-else>
        麦克风（HTTP 局域网常被禁）：手机 Chrome 打开
        <code :class="['text-[#d8d0c2]']">chrome://flags</code> → 搜
        <code :class="['text-[#d8d0c2]']">Insecure origins treated as secure</code> → 填
        <code :class="['text-[#d8d0c2]']">http://&lt;本机IP&gt;:{{ info?.port ?? 5173 }}</code> → Relaunch。
      </template>
    </p>

    <div
      v-if="primaryMobileUrl"
      :class="['flex flex-wrap items-start gap-4']"
    >
      <img
        v-if="qrUrl"
        data-testid="lan-share-qr"
        :src="qrUrl"
        alt="Vera 随身页二维码"
        width="148"
        height="148"
        :class="['rounded-xl bg-[#f3eee4] p-2']"
      >
      <div :class="['min-w-0 flex-1 text-xs text-[#d8d0c2]']">
        <div :class="['mb-1 text-[#a89f90]']">
          手机打开
        </div>
        <a
          data-testid="lan-share-mobile-url"
          :href="primaryMobileUrl"
          target="_blank"
          rel="noreferrer"
          :class="['break-all text-[#c9a46c] underline decoration-[#c9a46c]/40 underline-offset-2']"
        >{{ primaryMobileUrl }}</a>
        <ul
          v-if="info && info.mobilePaths.length > 1"
          :class="['mt-2 list-disc pl-4 text-[#a89f90]']"
        >
          <li
            v-for="url in info.mobilePaths.slice(1)"
            :key="url"
            class="break-all"
          >
            {{ url }}
          </li>
        </ul>
        <div
          v-if="publishedAt"
          data-testid="lan-share-published"
          :class="['mt-2 text-[#a89f90]']"
        >
          已发布 · {{ new Date(publishedAt).toLocaleTimeString() }}
        </div>
      </div>
    </div>

    <p
      v-else
      :class="['m-0 text-xs text-[#a89f90]']"
    >
      点「分享到手机」导出会话并生成二维码。
    </p>

    <p
      v-if="errorText"
      data-testid="lan-share-error"
      :class="[
        'm-0 rounded-xl border border-[rgba(196,92,72,0.35)]',
        'bg-[rgba(196,92,72,0.1)] px-3 py-2 text-xs text-[#f0b4a8]',
      ]"
    >
      {{ errorText }}
    </p>
  </section>
</template>
