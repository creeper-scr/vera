import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useOnboardingStore } from './onboarding'

vi.mock('./providers', () => ({
  useProvidersStore: () => ({
    configuredProviders: {},
    providers: {},
  }),
}))

describe('onboarding store (no-auth fork)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('never requires onboarding for hosted login', () => {
    const store = useOnboardingStore()
    expect(store.needsOnboarding).toBe(false)
  })

  it('keeps setup flags writable for manual/testing use', () => {
    const store = useOnboardingStore()
    store.resetSetupState()
    expect(store.hasCompletedSetup).toBe(false)
    expect(store.hasSkippedSetup).toBe(false)

    store.markSetupSkipped()
    expect(store.hasSkippedSetup).toBe(true)
    expect(store.showingSetup).toBe(false)
  })
})
