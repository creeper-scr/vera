import type { ChatProvider } from '@xsai-ext/providers/utils'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCompanionAgentModel } from './useCompanionAgentModel'

const {
  activeModel,
  activeProvider,
  getProviderInstance,
  streamWithExclusiveTools,
  createPlayChatProvider,
} = vi.hoisted(() => ({
  activeModel: { value: 'model-a' },
  activeProvider: { value: 'provider-a' },
  getProviderInstance: vi.fn(),
  streamWithExclusiveTools: vi.fn(),
  createPlayChatProvider: vi.fn(() => undefined),
}))

vi.mock('pinia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pinia')>()
  return {
    ...actual,
    storeToRefs: () => ({ activeModel, activeProvider }),
  }
})

vi.mock('../stores/llm', () => ({
  useLLM: () => ({ streamWithExclusiveTools }),
}))

vi.mock('../stores/modules/consciousness', () => ({
  useConsciousnessStore: () => ({}),
}))

vi.mock('../stores/providers', () => ({
  useProvidersStore: () => ({ getProviderInstance }),
}))

vi.mock('../libs/play-env-credentials', () => ({
  createPlayChatProvider,
}))

describe('useCompanionAgentModel', () => {
  beforeEach(() => {
    activeModel.value = 'model-a'
    activeProvider.value = 'provider-a'
    getProviderInstance.mockReset()
    streamWithExclusiveTools.mockReset()
    createPlayChatProvider.mockReset()
    createPlayChatProvider.mockReturnValue(undefined)
    const provider: ChatProvider = {
      chat: model => ({
        baseURL: 'https://example.com/',
        model,
      }),
    }
    getProviderInstance.mockResolvedValue(provider)
  })

  it('streams one native multi-step tool loop and returns accumulated text', async () => {
    streamWithExclusiveTools.mockImplementationOnce(async (
      _model,
      _provider,
      _messages,
      options,
    ) => {
      await options.onStreamEvent?.({ type: 'text-delta', text: '你好' })
      await options.onStreamEvent?.({ type: 'text-delta', text: '，世界' })
    })

    const model = useCompanionAgentModel()
    const result = await model.stream({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxSteps: 4,
      abortSignal: new AbortController().signal,
    })

    expect(getProviderInstance).toHaveBeenCalledWith('provider-a')
    expect(streamWithExclusiveTools).toHaveBeenCalledWith(
      'model-a',
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({
        captureToolErrors: true,
        maxSteps: 4,
        supportsTools: true,
        waitForTools: true,
      }),
    )
    expect(result).toEqual({ assistantText: '你好，世界' })
  })

  it('prefers play-env LLM over consciousness store', async () => {
    const playProvider: ChatProvider = {
      chat: model => ({
        baseURL: 'https://api.deepseek.com/',
        model,
      }),
    }
    createPlayChatProvider.mockReturnValue({
      provider: playProvider,
      model: 'deepseek-v4-flash',
    })
    streamWithExclusiveTools.mockImplementationOnce(async () => {})

    const model = useCompanionAgentModel()
    await model.stream({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxSteps: 4,
      abortSignal: new AbortController().signal,
    })

    expect(getProviderInstance).not.toHaveBeenCalled()
    expect(streamWithExclusiveTools).toHaveBeenCalledWith(
      'deepseek-v4-flash',
      playProvider,
      expect.any(Array),
      expect.anything(),
    )
  })

  it('returns an empty result when no text-delta streams', async () => {
    streamWithExclusiveTools.mockImplementationOnce(async () => {})

    const model = useCompanionAgentModel()
    const result = await model.stream({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxSteps: 4,
      abortSignal: new AbortController().signal,
    })

    expect(result).toEqual({})
  })
})
