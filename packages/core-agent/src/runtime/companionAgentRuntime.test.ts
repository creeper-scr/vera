import type { CompanionAgentModelRequest } from './companionAgentRuntime'

import { describe, expect, it, vi } from 'vitest'

import { createCompanionAgentRuntime } from './companionAgentRuntime'

function createHarness(options: {
  observedAt?: number
  freshnessMs?: number
  tools?: Array<{ name: string, description?: string, inputSchema: Record<string, unknown>, risk?: 'low' | 'medium' | 'high', cancellable?: boolean, waitForTerminal?: boolean }>
  callToolImpl?: (name: string) => unknown
  getSystemPrompt?: () => string
} = {}) {
  const modelRequests: CompanionAgentModelRequest[] = []
  const mcp = {
    listTools: vi.fn(async () => options.tools ?? [{
      name: 'follow',
      description: 'Follow player',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      risk: 'low' as const,
      cancellable: true,
    }]),
    readEnvironment: vi.fn(async (sessionId: string) => ({
      sessionId,
      observedAt: options.observedAt ?? 900,
      freshnessMs: options.freshnessMs ?? 5_000,
      content: { health: 10 },
      revision: 'r1',
    })),
    callTool: vi.fn(async (call: { name: string }) => {
      if (options.callToolImpl)
        return options.callToolImpl(call.name)
      return {
        status: 'terminal' as const,
        actionId: 'action-1',
        state: 'succeeded' as const,
        capabilityId: call.name,
        result: { ok: true },
      }
    }),
  }
  const model = {
    stream: vi.fn(async (request: CompanionAgentModelRequest) => {
      modelRequests.push(request)
      return {}
    }),
  }
  const runtime = createCompanionAgentRuntime({
    mcp,
    model,
    getSystemPrompt: options.getSystemPrompt,
    now: () => 1000,
    maxSteps: 4,
  })
  return { mcp, model, modelRequests, runtime }
}

describe('createCompanionAgentRuntime', () => {
  it('runs multiple tools inside one native model tool loop', async () => {
    const { mcp, model, runtime } = createHarness({
      tools: [
        {
          name: 'move',
          inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false },
          risk: 'low',
          cancellable: true,
        },
        {
          name: 'stop',
          inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
          risk: 'low',
          cancellable: true,
        },
      ],
    })

    model.stream.mockImplementation(async (request) => {
      await request.tools[0]!.execute({ x: 1 }, { messages: request.messages, toolCallId: 'tc-1' })
      await request.tools[1]!.execute({}, { messages: request.messages, toolCallId: 'tc-2' })
      return { assistantText: '到了' }
    })

    const result = await runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't1',
      text: '走到那边再停',
      createdAt: 1,
      metadata: { source: 'hearing', eventId: 'e1' },
    })

    expect(result.status).toBe('completed')
    expect(result.steps).toBe(2)
    expect(result.toolNames).toEqual(['move', 'stop'])
    expect(result.assistantText).toBe('到了')
    expect(mcp.callTool).toHaveBeenCalledTimes(2)
    expect(mcp.readEnvironment).toHaveBeenCalledOnce()
    expect(model.stream).toHaveBeenCalledOnce()
    expect(model.stream.mock.calls[0]![0].maxSteps).toBe(5)
  })

  it('waits for terminal tool results and surfaces failures without claiming success', async () => {
    const { model, runtime } = createHarness({
      callToolImpl: () => ({
        status: 'terminal',
        actionId: 'a1',
        state: 'failed',
        capabilityId: 'follow',
        error: 'path blocked',
      }),
    })

    model.stream.mockImplementationOnce(async (request) => {
      const toolResult = await request.tools[0]!.execute({}, { messages: request.messages, toolCallId: 'tc-1' })
      expect(toolResult).toMatchObject({ error: 'path blocked', state: 'failed' })
      return { assistantText: '过不去' }
    })

    const result = await runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't1',
      text: '跟着我',
      createdAt: 1,
      metadata: { source: 'hearing', eventId: 'e1' },
    })

    expect(result.status).toBe('completed')
    expect(result.toolNames).toEqual(['follow'])
    expect(result.toolSteps).toEqual([{
      name: 'follow',
      arguments: {},
      ok: false,
      error: 'path blocked',
    }])
    expect(result.assistantText).toBe('过不去')
  })

  it('returns continuous actions to the model after acceptance', async () => {
    const { mcp, model, runtime } = createHarness({
      tools: [{
        name: 'follow',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        risk: 'low',
        cancellable: true,
        waitForTerminal: false,
      }],
      callToolImpl: () => ({
        status: 'accepted',
        actionId: 'follow-1',
        state: 'running',
        capabilityId: 'follow',
      }),
    })

    model.stream.mockImplementationOnce(async (request) => {
      await request.tools[0]!.execute({}, { messages: request.messages, toolCallId: 'tc-follow' })
      return { assistantText: '正在跟随' }
    })

    const result = await runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't-follow',
      text: '跟着我',
      createdAt: 1,
      metadata: { source: 'doubao-realtime', eventId: 'e-follow' },
    })

    expect(result.status).toBe('completed')
    expect(result.assistantText).toBe('正在跟随')
    expect(mcp.callTool).toHaveBeenCalledWith(expect.objectContaining({
      waitForTerminal: false,
    }))
  })

  it('allows intentional repeated actions with distinct native tool call ids', async () => {
    const { mcp, model, runtime } = createHarness({
      tools: [{
        name: 'say',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
      }],
    })

    model.stream.mockImplementationOnce(async (request) => {
      await request.tools[0]!.execute(
        { message: '你好', options: { volume: 1, pitch: 2 } },
        { messages: request.messages, toolCallId: 'tc-1' },
      )
      await request.tools[0]!.execute(
        { options: { pitch: 2, volume: 1 }, message: '你好' },
        { messages: request.messages, toolCallId: 'tc-2' },
      )
      return {}
    })

    const result = await runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't-repeat',
      text: '在游戏里说你好',
      createdAt: 1,
      metadata: { source: 'doubao-realtime', eventId: 'e-repeat' },
    })

    expect(result.status).toBe('completed')
    expect(result.reason).toBeUndefined()
    expect(result.steps).toBe(2)
    expect(result.toolNames).toEqual(['say', 'say'])
    expect(mcp.callTool).toHaveBeenCalledTimes(2)
    expect(model.stream).toHaveBeenCalledOnce()
  })

  it('reacts to game observations through the same owner loop', async () => {
    const { model, runtime } = createHarness()
    model.stream.mockResolvedValueOnce({ assistantText: '好痛！' })

    const result = await runtime.ingestObservation({
      sessionId: 's1',
      eventId: 'obs-1',
      kind: 'hurt',
      urgency: 'high',
      text: 'Bot took damage',
      observedAt: 900,
      dedupeKey: 'hurt:1',
    })

    expect(result?.status).toBe('completed')
    expect(result?.assistantText).toBe('好痛！')
    expect(model.stream).toHaveBeenCalledOnce()
  })

  it('completes dialogue-only turns when no tools are available', async () => {
    const { mcp, model, runtime } = createHarness({ tools: [] })
    model.stream.mockResolvedValueOnce({ assistantText: '你好呀' })

    const result = await runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't-chat',
      text: '你好',
      createdAt: 1,
      metadata: { source: 'hearing', eventId: 'e1' },
    })

    expect(result.status).toBe('completed')
    expect(result.assistantText).toBe('你好呀')
    expect(result.steps).toBe(0)
    expect(result.toolNames).toEqual([])
    expect(model.stream).toHaveBeenCalledOnce()
    expect(model.stream.mock.calls[0]![0]!.tools).toEqual([])
    expect(model.stream.mock.calls[0]![0]!.maxSteps).toBe(1)
    expect(mcp.readEnvironment).not.toHaveBeenCalled()
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('reads the current character prompt for each turn', async () => {
    let characterPrompt = '你是猫娘小夜。'
    const { model, runtime } = createHarness({
      tools: [],
      getSystemPrompt: () => characterPrompt,
    })

    await runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't-persona-1',
      text: '你是谁',
      createdAt: 1,
      metadata: { source: 'doubao-realtime', eventId: 'e-persona-1' },
    })
    characterPrompt = '你是勇者小夜。'
    await runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't-persona-2',
      text: '你是谁',
      createdAt: 2,
      metadata: { source: 'doubao-realtime', eventId: 'e-persona-2' },
    })

    expect(model.stream.mock.calls[0]![0].messages[0]?.content).toContain('你是猫娘小夜。')
    expect(model.stream.mock.calls[1]![0].messages[0]?.content).toContain('你是勇者小夜。')
    expect(model.stream.mock.calls[1]![0].messages).toContainEqual({
      role: 'user',
      content: '你是谁',
    })
  })

  it('tells the action model how to resolve local voice player references', async () => {
    const { model, runtime } = createHarness()

    await runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't-local-player',
      text: '跟着我',
      createdAt: 1,
      metadata: { source: 'doubao-realtime', eventId: 'e-local-player' },
    })

    expect(model.stream.mock.calls[0]![0].messages[0]?.content).toContain(
      '若未配置且只有一个非自身在线玩家，可使用该玩家',
    )
    expect(model.stream.mock.calls[0]![0].messages[0]?.content).toContain(
      '没有工具调用就不要声称已经在做或已经完成',
    )
    expect(model.stream.mock.calls[0]![0].messages[0]?.content).toContain(
      '优先用环境字段 nearestLog',
    )
  })

  it('still chats when the environment is stale and no tools are available', async () => {
    const { model, runtime } = createHarness({
      tools: [],
      observedAt: 0,
      freshnessMs: 0,
    })
    model.stream.mockResolvedValueOnce({ assistantText: '我在' })

    const result = await runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't-chat-stale',
      text: '在吗',
      createdAt: 1,
      metadata: { source: 'hearing', eventId: 'e1' },
    })

    expect(result.status).toBe('completed')
    expect(result.assistantText).toBe('我在')
    expect(model.stream).toHaveBeenCalledOnce()
  })

  it('dedupes observations by dedupeKey', async () => {
    const { model, runtime } = createHarness()
    model.stream.mockResolvedValue({ assistantText: '哎' })

    const observation = {
      sessionId: 's1',
      eventId: 'obs-1',
      kind: 'hurt',
      urgency: 'high' as const,
      text: 'hurt',
      observedAt: 900,
      dedupeKey: 'hurt:same',
    }
    await runtime.ingestObservation(observation)
    const second = await runtime.ingestObservation({ ...observation, eventId: 'obs-2' })
    expect(second).toBeNull()
    expect(model.stream).toHaveBeenCalledOnce()
  })

  it('cancels in-flight inference via CompanionInterruptPort', async () => {
    const { model, runtime } = createHarness()
    let streamStarted!: () => void
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve
    })
    model.stream.mockImplementation(async (request) => {
      streamStarted()
      await new Promise<void>((_resolve, reject) => {
        request.abortSignal.addEventListener('abort', () => reject(new Error('aborted')))
      })
      return {}
    })

    const pending = runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 't-cancel',
      text: '跟着我',
      createdAt: 1,
      metadata: { source: 'hearing', eventId: 'e1' },
    })

    await started
    const outcomes = await runtime.cancel({
      sessionId: 's1',
      turnId: 't-cancel',
      scope: 'turn',
      reason: 'barge-in',
    })
    expect(outcomes).toEqual([{ status: 'cancelled', scope: 'turn' }])

    const result = await pending
    expect(result.status).toBe('cancelled')
  })

  it('isolates cancellation by session when turn ids collide', async () => {
    const { model, runtime } = createHarness()
    let started = 0
    let allStarted!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      allStarted = resolve
    })
    model.stream.mockImplementation(async (request) => {
      started += 1
      if (started === 2)
        allStarted()
      await new Promise<void>((_resolve, reject) => {
        request.abortSignal.addEventListener('abort', () => reject(new Error('aborted')))
      })
      return {}
    })

    const first = runtime.ingestVoiceTurn({
      sessionId: 's1',
      turnId: 'same-turn',
      text: '一号会话',
      createdAt: 1,
      metadata: { source: 'hearing', eventId: 'e1' },
    })
    const second = runtime.ingestVoiceTurn({
      sessionId: 's2',
      turnId: 'same-turn',
      text: '二号会话',
      createdAt: 1,
      metadata: { source: 'hearing', eventId: 'e2' },
    })

    await bothStarted
    await runtime.cancel({
      sessionId: 's1',
      turnId: 'same-turn',
      scope: 'turn',
    })
    expect((await first).status).toBe('cancelled')

    expect(await runtime.cancel({
      sessionId: 's2',
      turnId: 'same-turn',
      scope: 'turn',
    })).toEqual([{ status: 'cancelled', scope: 'turn' }])
    expect((await second).status).toBe('cancelled')
  })
})
