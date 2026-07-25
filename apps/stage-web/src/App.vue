<script setup lang="ts">
/**
 * Web companion shell: no hosted auth / account onboarding.
 * Home page owns Doubao voice + game:coop attach.
 */
import { ToasterRoot } from '@proj-vera/stage-ui/components'
import { useInferencePreload } from '@proj-vera/stage-ui/composables'
import { isPosthogAvailableInBuild, useSharedAnalyticsStore } from '@proj-vera/stage-ui/stores/analytics'
import { useCharacterOrchestratorStore } from '@proj-vera/stage-ui/stores/character'
import { useChatSessionStore } from '@proj-vera/stage-ui/stores/chat/session-store'
import { useModsServerChannelStore } from '@proj-vera/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-vera/stage-ui/stores/mods/api/context-bridge'
import { useConsciousnessStore } from '@proj-vera/stage-ui/stores/modules/consciousness'
import { useVeraCardStore } from '@proj-vera/stage-ui/stores/modules/vera-card'
import { useSettings, useSettingsAudioDevice } from '@proj-vera/stage-ui/stores/settings'
import { ErrorBoundary, useTheme } from '@proj-vera/ui'
import { StageTransitionGroup } from '@proj-vera/ui-transitions'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import PerformanceOverlay from './components/Devtools/PerformanceOverlay.vue'

import { seedPlayProviders } from './composables/seedPlayProviders'
import { usePWAStore } from './stores/pwa'

usePWAStore()

const contextBridgeStore = useContextBridgeStore()
const i18n = useI18n()
const settings = storeToRefs(useSettings())
const chatSessionStore = useChatSessionStore()
const serverChannelStore = useModsServerChannelStore()
const characterOrchestratorStore = useCharacterOrchestratorStore()
const settingsAudioDeviceStore = useSettingsAudioDevice()
const { isDark } = useTheme()
const cardStore = useVeraCardStore()
const analyticsStore = useSharedAnalyticsStore()
const inferencePreload = useInferencePreload()
const consciousness = useConsciousnessStore()

/**
 * Vera-card watchDebounced can clobber consciousness ~300ms after init.
 * Keep play-env provider/model pinned whenever env is present.
 */
function pinPlayConsciousness() {
  const { llm } = seedPlayProviders()
  return llm
}

// Play env wins over stale browser provider settings (no settings UI on home).
const pinnedPlayLlm = pinPlayConsciousness()
if (pinnedPlayLlm) {
  watch(
    () => [consciousness.activeProvider, consciousness.activeModel] as const,
    ([provider, model]) => {
      if (provider !== 'openai' || model !== pinnedPlayLlm.model)
        seedPlayProviders()
    },
  )
}

const primaryColor = computed(() => {
  return isDark.value
    ? `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${0})) 70%, oklch(50% 0 360))`
    : `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${0})) 90%, oklch(90% 0 360))`
})

const secondaryColor = computed(() => {
  return isDark.value
    ? `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${180})) 70%, oklch(50% 0 360))`
    : `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${180})) 90%, oklch(90% 0 360))`
})

const tertiaryColor = computed(() => {
  return isDark.value
    ? `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${60})) 70%, oklch(50% 0 360))`
    : `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${60})) 90%, oklch(90% 0 360))`
})

const colors = computed(() => {
  return [primaryColor.value, secondaryColor.value, tertiaryColor.value, isDark.value ? '#121212' : '#FFFFFF']
})

watch(settings.language, () => {
  i18n.locale.value = settings.language.value
})

watch(settings.themeColorsHue, () => {
  document.documentElement.style.setProperty('--chromatic-hue', settings.themeColorsHue.value.toString())
}, { immediate: true })

watch(settings.themeColorsHueDynamic, () => {
  document.documentElement.classList.toggle('dynamic-hue', settings.themeColorsHueDynamic.value)
}, { immediate: true })

onMounted(async () => {
  // Analytics stays optional; never gate boot on hosted login.
  if (isPosthogAvailableInBuild())
    analyticsStore.initialize()
  cardStore.initialize()
  // Card apply is debounced; re-pin immediately and again after the debounce window.
  pinPlayConsciousness()
  window.setTimeout(pinPlayConsciousness, 400)

  await chatSessionStore.initialize()
  await serverChannelStore.initialize({ possibleEvents: ['ui:configure'] }).catch(err => console.error('Failed to initialize Mods Server Channel in App.vue:', err))
  contextBridgeStore.initialize()
  characterOrchestratorStore.initialize()

  await settingsAudioDeviceStore.initialize()

  inferencePreload.triggerPreload()
})

onUnmounted(() => {
  contextBridgeStore.dispose()
})
</script>

<template>
  <StageTransitionGroup
    :primary-color="primaryColor"
    :secondary-color="secondaryColor"
    :tertiary-color="tertiaryColor"
    :colors="colors"
    :z-index="100"
    :disable-transitions="settings.disableTransitions.value"
    :use-page-specific-transitions="settings.usePageSpecificTransitions.value"
  >
    <RouterView v-slot="{ Component }">
      <ErrorBoundary
        title="Something went wrong while rendering this page."
        @error="(err, _, info) => console.error('[ErrorBoundary]', info, err)"
      >
        <component :is="Component" />
      </ErrorBoundary>
    </RouterView>
  </StageTransitionGroup>

  <ToasterRoot @close="id => toast.dismiss(id)">
    <Toaster />
  </ToasterRoot>

  <PerformanceOverlay />
</template>

<style>
/* We need this to properly animate the CSS variable */
@property --chromatic-hue {
  syntax: '<number>';
  initial-value: 0;
  inherits: true;
}

@keyframes hue-anim {
  from {
    --chromatic-hue: 0;
  }
  to {
    --chromatic-hue: 360;
  }
}

.dynamic-hue {
  animation: hue-anim 10s linear infinite;
}
</style>
