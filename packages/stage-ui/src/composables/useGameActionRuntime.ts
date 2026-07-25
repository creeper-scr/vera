import type {
  GameActionTurnResult,
  GameActionUserTurn,
  GameMcpClientPort,
} from '@proj-vera/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { createGameActionRuntime } from '@proj-vera/core-agent'
import { storeToRefs } from 'pinia'
import { onUnmounted } from 'vue'

import { createPlayChatProvider } from '../libs/play-env-credentials'
import { useLLM } from '../stores/llm'
import { useConsciousnessStore } from '../stores/modules/consciousness'
import { useProvidersStore } from '../stores/providers'

export interface UseGameActionRuntimeOptions {
  onResult?: (result: GameActionTurnResult, turn: GameActionUserTurn) => void
  onError?: (error: unknown, turn: GameActionUserTurn) => void
}

/**
 * Binds platform-neutral game decision policy to play-env LLM when present,
 * otherwise active stage consciousness settings.
 *
 * Pass `ingestUserTurn` to `useDoubaoRealtimeVoice({ onUserTurn })`. The MCP
 * client remains injected by the third-layer owner.
 */
export function useGameActionRuntime(
  mcp: GameMcpClientPort,
  options: UseGameActionRuntimeOptions = {},
) {
  const consciousness = useConsciousnessStore()
  const providers = useProvidersStore()
  const llm = useLLM()
  const { activeModel, activeProvider } = storeToRefs(consciousness)

  const runtime = createGameActionRuntime({
    mcp,
    model: {
      async stream(request) {
        const play = createPlayChatProvider()
        const providerId = play ? 'openai' : activeProvider.value
        const model = play ? play.model : activeModel.value
        if (!providerId || !model)
          throw new Error('Configure a consciousness provider and model before enabling game actions')

        const chatProvider = play?.provider
          ?? await providers.getProviderInstance<ChatProvider>(providerId)
        request.abortSignal.throwIfAborted()
        await llm.streamWithExclusiveTools(model, chatProvider, request.messages, {
          abortSignal: request.abortSignal,
          captureToolErrors: true,
          maxSteps: 1,
          supportsTools: true,
          tools: request.tools,
          waitForTools: true,
        })
      },
    },
  })

  async function ingestUserTurn(turn: GameActionUserTurn) {
    try {
      const result = await runtime.ingest(turn)
      options.onResult?.(result, turn)
      return result
    }
    catch (error) {
      options.onError?.(error, turn)
      throw error
    }
  }

  onUnmounted(runtime.dispose)

  return {
    dispose: runtime.dispose,
    ingestUserTurn,
  }
}
