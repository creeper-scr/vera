import { beforeEach, describe, expect, it, vi } from 'vitest'

const providers = {
  initializeProvider: vi.fn(),
  providers: {} as Record<string, Record<string, unknown>>,
  markProviderAdded: vi.fn(),
  disposeProviderInstance: vi.fn(),
  forceProviderConfigured: vi.fn(),
}

const consciousness = {
  activeProvider: '',
  activeModel: '',
}

vi.mock('@proj-vera/stage-ui/stores/providers', () => ({
  useProvidersStore: () => providers,
}))

vi.mock('@proj-vera/stage-ui/stores/modules/consciousness', () => ({
  useConsciousnessStore: () => consciousness,
}))

describe('seedPlayProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providers.providers = {}
    consciousness.activeProvider = 'stale-provider'
    consciousness.activeModel = 'stale-model'
  })

  it('forces openai + consciousness from play LLM env', async () => {
    const { seedPlayProviders } = await import('./seedPlayProviders')
    const result = seedPlayProviders({
      VITE_OPENAI_API_KEY: 'sk-test',
      VITE_OPENAI_API_BASEURL: 'https://api.deepseek.com',
      VITE_OPENAI_MODEL: 'deepseek-v4-flash',
    })

    expect(result.llm).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    })
    expect(providers.providers.openai).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
    })
    expect(consciousness.activeProvider).toBe('openai')
    expect(consciousness.activeModel).toBe('deepseek-v4-flash')
    expect(providers.forceProviderConfigured).toHaveBeenCalledWith('openai')
  })

  it('seeds volcengine credentials from VITE_VOLCENGINE_*', async () => {
    const { seedPlayProviders } = await import('./seedPlayProviders')
    const result = seedPlayProviders({
      VITE_VOLCENGINE_APP_ID: 'app-1',
      VITE_VOLCENGINE_ACCESS_KEY: 'access-1',
    })

    expect(result.volcengine).toEqual({ appId: 'app-1', accessKey: 'access-1' })
    expect(providers.providers.volcengine).toEqual({
      apiKey: 'access-1',
      baseUrl: 'https://unspeech.hyp3r.link/v1/',
      app: { appId: 'app-1' },
    })
  })

  it('skips seeding when play LLM env incomplete', async () => {
    const { seedPlayProviders } = await import('./seedPlayProviders')
    const result = seedPlayProviders({
      VITE_OPENAI_API_KEY: 'sk-test',
    })

    expect(result.llm).toBeUndefined()
    expect(consciousness.activeProvider).toBe('stale-provider')
  })
})
