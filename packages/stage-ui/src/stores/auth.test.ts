import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { triggerSignIn } from '../libs/auth'
import { useAuthStore } from './auth'

vi.mock('../libs/auth', () => ({
  triggerSignIn: vi.fn(),
}))

describe('auth store sign-in requests', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(triggerSignIn).mockReset()
    vi.mocked(triggerSignIn).mockResolvedValue()
  })

  it('consumes needsLogin as a no-op without hosted OIDC redirect', async () => {
    const authStore = useAuthStore()

    authStore.needsLogin = true
    await nextTick()

    expect(triggerSignIn).not.toHaveBeenCalled()
    expect(authStore.needsLogin).toBe(false)

    authStore.needsLogin = true
    await nextTick()

    expect(triggerSignIn).not.toHaveBeenCalled()
    expect(authStore.needsLogin).toBe(false)
  })
})
