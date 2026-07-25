import type { CompanionAgentModelPort } from '@proj-vera/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { storeToRefs } from 'pinia'

import { createPlayChatProvider } from '../libs/play-env-credentials'
import { useLLM } from '../stores/llm'
import { useConsciousnessStore } from '../stores/modules/consciousness'
import { useProvidersStore } from '../stores/providers'

/**
 * Binds the companion agent's exclusive model port to play-env LLM when
 * `VITE_OPENAI_*` is set, otherwise the active consciousness provider/model.
 *
 * Runs one native multi-step model/tool loop, captures tool errors, and
 * accumulates streamed `text-delta` into `assistantText` for projection.
 */
export function useCompanionAgentModel(): CompanionAgentModelPort {
  const consciousness = useConsciousnessStore()
  const providers = useProvidersStore()
  const llm = useLLM()
  const { activeModel, activeProvider } = storeToRefs(consciousness)

  return {
    async stream(request) {
      const play = createPlayChatProvider()
      const providerId = play ? 'openai' : activeProvider.value
      const model = play ? play.model : activeModel.value
      if (!providerId || !model)
        throw new Error('Configure a consciousness provider and model before enabling the companion agent')

      const chatProvider = play?.provider
        ?? await providers.getProviderInstance<ChatProvider>(providerId)
      request.abortSignal.throwIfAborted()

      let assistantText = ''
      await llm.streamWithExclusiveTools(model, chatProvider, request.messages, {
        abortSignal: request.abortSignal,
        captureToolErrors: true,
        maxSteps: request.maxSteps,
        supportsTools: true,
        tools: request.tools,
        waitForTools: true,
        onStreamEvent: (event) => {
          if (event.type === 'text-delta')
            assistantText += event.text
        },
      })

      return assistantText ? { assistantText } : {}
    },
  }
}
