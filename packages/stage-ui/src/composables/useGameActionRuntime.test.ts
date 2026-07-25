import type { GameMcpClientPort } from '@proj-vera/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useGameActionRuntime } from './useGameActionRuntime'

const {
  activeModel,
  activeProvider,
  createPlayChatProvider,
  disposeCallbacks,
  getProviderInstance,
  streamWithExclusiveTools,
} = vi.hoisted(() => ({
  activeModel: { value: 'model-a' },
  activeProvider: { value: 'provider-a' },
  createPlayChatProvider: vi.fn(() => undefined),
  disposeCallbacks: [] as Array<() => void>,
  getProviderInstance: vi.fn(),
  streamWithExclusiveTools: vi.fn(),
}))

vi.mock('pinia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pinia')>()
  return {
    ...actual,
    storeToRefs: () => ({ activeModel, activeProvider }),
  }
})

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>()
  return {
    ...actual,
    onUnmounted: (callback: () => void) => disposeCallbacks.push(callback),
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

describe('useGameActionRuntime', () => {
  beforeEach(() => {
    activeModel.value = 'model-a'
    activeProvider.value = 'provider-a'
    disposeCallbacks.length = 0
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

  it('uses the active model with isolated single-step game tools', async () => {
    const callTool = vi.fn(async () => ({ ok: true }))
    const mcp = createMcp(callTool)
    streamWithExclusiveTools.mockImplementationOnce(async (
      _model,
      _provider,
      messages,
      options,
    ) => {
      await options.tools[0].execute(
        { direction: 'forward' },
        { messages, toolCallId: 'call-1' },
      )
    })
    const runtime = useGameActionRuntime(mcp)

    await expect(runtime.ingestUserTurn({
      sessionId: 'game-1',
      turnId: 'turn-1',
      text: '向前走',
    })).resolves.toEqual({
      status: 'executed',
      toolName: 'move',
      outcome: { kind: 'succeeded' },
    })

    expect(getProviderInstance).toHaveBeenCalledWith('provider-a')
    expect(streamWithExclusiveTools).toHaveBeenCalledWith(
      'model-a',
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({
        captureToolErrors: true,
        maxSteps: 1,
        supportsTools: true,
        waitForTools: true,
      }),
    )
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'game-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      name: 'move',
    }))
  })

  it('disposes the core runtime with its component owner', async () => {
    const runtime = useGameActionRuntime(createMcp(vi.fn()))

    expect(disposeCallbacks).toHaveLength(1)
    disposeCallbacks[0]()

    await expect(runtime.ingestUserTurn({
      sessionId: 'game-1',
      turnId: 'turn-1',
      text: '向前走',
    })).resolves.toEqual({ status: 'ignored', reason: 'disposed' })
    expect(streamWithExclusiveTools).not.toHaveBeenCalled()
  })
})

function createMcp(callTool: GameMcpClientPort['callTool']): GameMcpClientPort {
  return {
    listTools: async () => [{
      name: 'move',
      inputSchema: { type: 'object', properties: {} },
    }],
    readEnvironment: async sessionId => ({
      sessionId,
      observedAt: Date.now(),
      freshnessMs: 1000,
      content: { position: [0, 0, 0] },
    }),
    callTool,
  }
}
