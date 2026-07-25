import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveDoubaoRealtimeVoiceCredentials } from './use-doubao-realtime-voice'

describe('resolveDoubaoRealtimeVoiceCredentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers play env over provider store', () => {
    vi.stubEnv('VITE_VOLCENGINE_APP_ID', 'env-app')
    vi.stubEnv('VITE_VOLCENGINE_ACCESS_KEY', 'env-key')
    expect(resolveDoubaoRealtimeVoiceCredentials({
      apiKey: 'store-key',
      app: { appId: 'store-app' },
    })).toEqual({ appId: 'env-app', accessKey: 'env-key' })
  })

  it('falls back to provider store when play env missing', () => {
    vi.stubEnv('VITE_VOLCENGINE_APP_ID', '')
    vi.stubEnv('VITE_VOLCENGINE_ACCESS_KEY', '')
    expect(resolveDoubaoRealtimeVoiceCredentials({
      apiKey: 'store-key',
      app: { appId: 'store-app' },
    })).toEqual({ appId: 'store-app', accessKey: 'store-key' })
  })

  it('returns undefined when neither store nor env is complete', () => {
    vi.stubEnv('VITE_VOLCENGINE_APP_ID', 'env-app')
    vi.stubEnv('VITE_VOLCENGINE_ACCESS_KEY', '')
    expect(resolveDoubaoRealtimeVoiceCredentials({})).toBeUndefined()
  })
})
