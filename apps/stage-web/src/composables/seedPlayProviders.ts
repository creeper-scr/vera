import {
  readPlayLlmCredentials,
  readPlayVolcengineCredentials,
} from '@proj-vera/stage-ui/libs/play-env-credentials'
import { useConsciousnessStore } from '@proj-vera/stage-ui/stores/modules/consciousness'
import { useProvidersStore } from '@proj-vera/stage-ui/stores/providers'

export type { PlayLlmCredentials, PlayVolcengineCredentials } from '@proj-vera/stage-ui/libs/play-env-credentials'
export { readPlayLlmCredentials, readPlayVolcengineCredentials }

/**
 * Force Web Companion stores to mirror play-env LLM + Doubao credentials.
 *
 * Companion/game-action runtimes also bypass the store when `VITE_OPENAI_*`
 * is present; this seed keeps UI / card / context-bridge aligned and blocks
 * stale localStorage from lingering on screen.
 */
export function seedPlayProviders(env = import.meta.env): {
  llm: ReturnType<typeof readPlayLlmCredentials>
  volcengine: ReturnType<typeof readPlayVolcengineCredentials>
} {
  const providers = useProvidersStore()
  const consciousness = useConsciousnessStore()
  const llm = readPlayLlmCredentials(env)
  const volcengine = readPlayVolcengineCredentials(env)

  if (llm) {
    providers.initializeProvider('openai')
    providers.providers.openai = {
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
    }
    providers.markProviderAdded('openai')
    void providers.disposeProviderInstance('openai')
    providers.forceProviderConfigured('openai')
    consciousness.activeProvider = 'openai'
    consciousness.activeModel = llm.model
  }

  if (volcengine) {
    providers.initializeProvider('volcengine')
    providers.providers.volcengine = {
      apiKey: volcengine.accessKey,
      baseUrl: 'https://unspeech.hyp3r.link/v1/',
      app: { appId: volcengine.appId },
    }
    providers.markProviderAdded('volcengine')
    void providers.disposeProviderInstance('volcengine')
    providers.forceProviderConfigured('volcengine')
  }

  return { llm, volcengine }
}
