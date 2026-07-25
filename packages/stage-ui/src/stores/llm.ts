import type { StreamOptions } from '@proj-vera/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import { streamFrom as coreStreamFrom, isContentArrayRelatedError, isToolRelatedError, modelKey } from '@proj-vera/core-agent'
import { listModels } from '@xsai/model'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { resolveLlmTools } from './llm-tool-resolver'

export type { StreamEvent, StreamOptions } from '@proj-vera/core-agent'
export { isContentArrayRelatedError, isToolRelatedError } from '@proj-vera/core-agent'

export const useLLM = defineStore('llm', () => {
  const toolsCompatibility = ref<Map<string, boolean>>(new Map())
  const contentArrayCompatibility = ref<Map<string, boolean>>(new Map())

  async function stream(model: string, chatProvider: ChatProvider, messages: Message[], options?: StreamOptions) {
    const { tools: customTools, ...streamOptions } = options ?? {}
    const builtinToolsResolver = () => resolveLlmTools({ customTools })
    await runStream(model, chatProvider, messages, streamOptions, builtinToolsResolver)
  }

  /**
   * Streams with only request-scoped tools. Used by isolated action runtimes
   * that must not inherit chat, debug, Spark, web-search, or global MCP tools.
   */
  async function streamWithExclusiveTools(
    model: string,
    chatProvider: ChatProvider,
    messages: Message[],
    options?: StreamOptions,
  ) {
    await runStream(model, chatProvider, messages, options)
  }

  async function runStream(
    model: string,
    chatProvider: ChatProvider,
    messages: Message[],
    options?: StreamOptions,
    builtinToolsResolver?: () => ReturnType<typeof resolveLlmTools>,
  ) {
    const key = modelKey(model, chatProvider)
    const execute = () => coreStreamFrom({
      model,
      chatProvider,
      messages,
      options: {
        ...options,
        toolsCompatibility: toolsCompatibility.value,
        contentArrayCompatibility: contentArrayCompatibility.value,
      },
      builtinToolsResolver,
    })

    try {
      await execute()
    }
    catch (err) {
      if (isToolRelatedError(err)) {
        console.warn(`[llm] Auto-disabling tools for "${key}" due to tool-related error`)
        toolsCompatibility.value.set(key, false)
      }
      // NOTICE:
      // Auto-degrade content-part arrays to plain strings on the next attempt
      // when the provider returned the Rust/serde-style "expected a string"
      // 400. We retry once inline so the user's failing turn recovers without
      // requiring them to resend; subsequent calls reuse the cached degrade.
      // See: https://github.com/moeru-ai/airi/issues/1500
      if (isContentArrayRelatedError(err) && contentArrayCompatibility.value.get(key) !== false) {
        console.warn(`[llm] Auto-disabling content-part arrays for "${key}" and retrying once`)
        contentArrayCompatibility.value.set(key, false)
        await execute()
        return
      }
      throw err
    }
  }

  async function models(apiUrl: string, apiKey: string) {
    if (apiUrl === '')
      return []

    try {
      return await listModels({
        baseURL: (apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`) as `${string}/`,
        apiKey,
      })
    }
    catch (err) {
      if (String(err).includes(`Failed to construct 'URL': Invalid URL`))
        return []
      throw err
    }
  }

  return {
    models,
    stream,
    streamWithExclusiveTools,
  }
})
