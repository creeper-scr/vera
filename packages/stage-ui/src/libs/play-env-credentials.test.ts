import { createOpenAI } from '@xsai-ext/providers/create'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createPlayChatProvider,
  readPlayLlmCredentials,
  readPlayVolcengineCredentials,
} from './play-env-credentials'

vi.mock('@xsai-ext/providers/create', () => ({
  createOpenAI: vi.fn((apiKey: string, baseUrl: string) => ({ apiKey, baseUrl, chat: () => ({}) })),
}))

describe('play-env-credentials', () => {
  beforeEach(() => {
    vi.mocked(createOpenAI).mockClear()
  })

  it('reads LLM credentials from VITE_OPENAI_*', () => {
    expect(readPlayLlmCredentials({
      VITE_OPENAI_API_KEY: 'sk-test',
      VITE_OPENAI_API_BASEURL: 'https://api.deepseek.com',
      VITE_OPENAI_MODEL: 'deepseek-v4-flash',
    })).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    })
  })

  it('returns undefined when LLM env incomplete', () => {
    expect(readPlayLlmCredentials({
      VITE_OPENAI_API_KEY: 'sk-test',
    })).toBeUndefined()
  })

  it('reads volcengine credentials from VITE_VOLCENGINE_*', () => {
    expect(readPlayVolcengineCredentials({
      VITE_VOLCENGINE_APP_ID: 'app',
      VITE_VOLCENGINE_ACCESS_KEY: 'key',
    })).toEqual({ appId: 'app', accessKey: 'key' })
  })

  it('creates chat provider from play LLM env', () => {
    const result = createPlayChatProvider({
      VITE_OPENAI_API_KEY: 'sk-test',
      VITE_OPENAI_API_BASEURL: 'https://api.deepseek.com',
      VITE_OPENAI_MODEL: 'deepseek-v4-flash',
    })
    expect(result?.model).toBe('deepseek-v4-flash')
    expect(createOpenAI).toHaveBeenCalledWith('sk-test', 'https://api.deepseek.com')
  })
})
