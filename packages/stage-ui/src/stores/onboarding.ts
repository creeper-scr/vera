import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { useProvidersStore } from './providers'

const essentialProviderIds = ['openai', 'azure-openai', 'anthropic', 'google-generative-ai', 'openrouter-ai', 'ollama', 'deepseek', 'openai-compatible', 'official-provider'] as const
const credentialBasedEssentialProviderIds = ['openai', 'azure-openai', 'anthropic', 'google-generative-ai', 'openrouter-ai', 'deepseek'] as const

/**
 * Returns true when value is a non-empty trimmed string.
 */
function hasNonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * First-time provider setup flags.
 *
 * Hosted login is out of scope for the web companion fork — onboarding never
 * gates on authentication.
 */
export const useOnboardingStore = defineStore('onboarding', () => {
  const providersStore = useProvidersStore()

  const hasCompletedSetup = useLocalStorage('onboarding/completed', false)
  const hasSkippedSetup = useLocalStorage('onboarding/skipped', false)
  const showingSetup = ref(false)

  const hasEssentialProviderConfigured = computed(() => {
    return essentialProviderIds.some(providerId => providersStore.configuredProviders[providerId])
  })

  const hasEssentialProviderCredentialConfigured = computed(() => {
    return credentialBasedEssentialProviderIds.some((providerId) => {
      const providerConfig = providersStore.providers[providerId] as Record<string, unknown> | undefined
      if (!providerConfig)
        return false

      return hasNonEmptyText(providerConfig.apiKey)
    })
  })

  /**
   * Always false in the no-auth companion fork.
   * Provider configuration is done in settings, not a login gate.
   */
  const needsOnboarding = computed(() => false)

  watch(needsOnboarding, (needSetup) => {
    if (!needSetup)
      showingSetup.value = false
  })

  /**
   * Marks first-time setup as completed.
   */
  function markSetupCompleted() {
    hasCompletedSetup.value = true
    hasSkippedSetup.value = false
    showingSetup.value = false
  }

  /**
   * Marks first-time setup as skipped.
   */
  function markSetupSkipped() {
    hasSkippedSetup.value = true
    showingSetup.value = false
  }

  /**
   * Clears persisted setup flags (tests / re-show).
   */
  function resetSetupState() {
    hasCompletedSetup.value = false
    hasSkippedSetup.value = false
    showingSetup.value = false
  }

  /**
   * Forces the setup dialog open (manual trigger only).
   */
  function forceShowSetup() {
    showingSetup.value = true
  }

  return {
    hasCompletedSetup,
    hasSkippedSetup,
    showingSetup,
    hasEssentialProviderConfigured,
    hasEssentialProviderCredentialConfigured,
    needsOnboarding,

    markSetupCompleted,
    markSetupSkipped,
    resetSetupState,
    forceShowSetup,
  }
})
