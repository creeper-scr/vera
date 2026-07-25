import type { ChatProvider } from '@xsai-ext/providers/utils'

import { createOpenAI } from '@xsai-ext/providers/create'

/** Subset of Vite env used by play credential helpers. */
export interface PlayEnvSource {
  VITE_OPENAI_API_KEY?: string
  VITE_OPENAI_API_BASEURL?: string
  VITE_OPENAI_MODEL?: string
  VITE_VOLCENGINE_APP_ID?: string
  VITE_VOLCENGINE_ACCESS_KEY?: string
}

/** Play-env OpenAI-compatible LLM credentials (`VITE_OPENAI_*` ← `OPENAI_*`). */
export interface PlayLlmCredentials {
  apiKey: string
  baseUrl: string
  model: string
}

/** Play-env Doubao / Volcengine realtime voice credentials. */
export interface PlayVolcengineCredentials {
  appId: string
  accessKey: string
}

/**
 * Reads Vite-exposed play LLM env. Present only in stage-web `pnpm dev:play`.
 */
export function readPlayLlmCredentials(
  env: PlayEnvSource = import.meta.env,
): PlayLlmCredentials | undefined {
  const apiKey = String(env.VITE_OPENAI_API_KEY ?? '').trim()
  const model = String(env.VITE_OPENAI_MODEL ?? '').trim()
  if (!apiKey || !model)
    return undefined
  const baseUrl = String(env.VITE_OPENAI_API_BASEURL ?? '').trim() || 'https://api.openai.com/v1/'
  return { apiKey, baseUrl, model }
}

/**
 * Reads Vite-exposed Doubao credentials (`VITE_VOLCENGINE_*`).
 */
export function readPlayVolcengineCredentials(
  env: PlayEnvSource = import.meta.env,
): PlayVolcengineCredentials | undefined {
  const appId = String(env.VITE_VOLCENGINE_APP_ID ?? '').trim()
  const accessKey = String(env.VITE_VOLCENGINE_ACCESS_KEY ?? '').trim()
  if (!appId || !accessKey)
    return undefined
  return { appId, accessKey }
}

/**
 * Builds a chat provider from play env when available (bypasses browser store).
 */
export function createPlayChatProvider(
  env: PlayEnvSource = import.meta.env,
): { provider: ChatProvider, model: string } | undefined {
  const llm = readPlayLlmCredentials(env)
  if (!llm)
    return undefined
  return {
    provider: createOpenAI(llm.apiKey, llm.baseUrl) as ChatProvider,
    model: llm.model,
  }
}
