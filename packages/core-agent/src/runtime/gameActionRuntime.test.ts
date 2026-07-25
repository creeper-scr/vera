import type { GameActionModelRequest } from './gameActionRuntime'

import { describe, expect, it, vi } from 'vitest'

import { createGameActionRuntime } from './gameActionRuntime'

function createHarness(options: {
  observedAt?: number
  freshnessMs?: number
  tools?: Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    waitForTerminal?: boolean
  }>
} = {}) {
  const modelRequests: GameActionModelRequest[] = []
  const mcp = {
    listTools: vi.fn(async () => options.tools ?? [{
      name: 'move',
      description: 'Move the player',
      inputSchema: {
        type: 'object',
        properties: { direction: { type: 'string' } },
        required: ['direction'],
      },
    }]),
    readEnvironment: vi.fn(async (sessionId: string, _signal: AbortSignal) => ({
      sessionId,
      observedAt: options.observedAt ?? 900,
      freshnessMs: options.freshnessMs ?? 200,
      content: { position: [0, 0, 0] },
    })),
    callTool: vi.fn(async () => ({
      status: 'terminal' as const,
      actionId: 'action-default',
      state: 'succeeded' as const,
      capabilityId: 'game.move',
    })),
  }
  const model = {
    stream: vi.fn(async (request: GameActionModelRequest) => {
      modelRequests.push(request)
    }),
  }
  const runtime = createGameActionRuntime({ mcp, model, now: () => 1000 })
  return { mcp, model, modelRequests, runtime }
}

describe('createGameActionRuntime', () => {
  it('discovers tools and environment, then routes one native tool call to MCP', async () => {
    const { mcp, model, modelRequests, runtime } = createHarness()
    model.stream.mockImplementationOnce(async (request) => {
      modelRequests.push(request)
      await request.tools[0].execute(
        { direction: 'forward' },
        { messages: request.messages, toolCallId: 'tool-call-1' },
      )
    })

    const result = await runtime.ingest({
      sessionId: 'game-1',
      turnId: 'turn-1',
      text: '向前走',
    })

    expect(result).toEqual({
      status: 'executed',
      toolName: 'move',
      outcome: { kind: 'succeeded' },
    })
    expect(mcp.listTools).toHaveBeenCalledWith('game-1', expect.any(AbortSignal))
    expect(mcp.readEnvironment).toHaveBeenCalledWith('game-1', expect.any(AbortSignal))
    expect(mcp.callTool).toHaveBeenCalledWith({
      sessionId: 'game-1',
      turnId: 'turn-1',
      toolCallId: 'tool-call-1',
      name: 'move',
      arguments: { direction: 'forward' },
      abortSignal: expect.any(AbortSignal),
      waitForTerminal: true,
    })
    expect(modelRequests[0].messages[1]).toEqual({
      role: 'user',
      content: '玩家语音：向前走\n当前游戏环境：{"position":[0,0,0]}',
    })
  })

  it('stays silent when the model selects no tool', async () => {
    const { mcp, runtime } = createHarness()

    await expect(runtime.ingest({
      sessionId: 'game-1',
      turnId: 'turn-1',
      text: '今天天气不错',
    })).resolves.toEqual({ status: 'no-action' })

    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('deduplicates turns and rejects a second tool call in one turn', async () => {
    const { mcp, model, runtime } = createHarness()
    model.stream.mockImplementationOnce(async (request) => {
      await request.tools[0].execute({}, {
        messages: request.messages,
        toolCallId: 'tool-call-1',
      })
      await expect(request.tools[0].execute({}, {
        messages: request.messages,
        toolCallId: 'tool-call-2',
      })).rejects.toThrow('Only one game tool call')
    })
    const turn = { sessionId: 'game-1', turnId: 'turn-1', text: '走两次' }

    await expect(runtime.ingest(turn)).resolves.toEqual({
      status: 'executed',
      toolName: 'move',
      outcome: { kind: 'succeeded' },
    })
    await expect(runtime.ingest(turn)).resolves.toEqual({ status: 'ignored', reason: 'duplicate' })

    expect(mcp.callTool).toHaveBeenCalledTimes(1)
  })

  it('ignores stale or mismatched environment snapshots before model execution', async () => {
    const { model, runtime } = createHarness({ observedAt: 700, freshnessMs: 200 })

    await expect(runtime.ingest({
      sessionId: 'game-1',
      turnId: 'turn-1',
      text: '向前走',
    })).resolves.toEqual({ status: 'ignored', reason: 'stale-environment' })

    expect(model.stream).not.toHaveBeenCalled()
  })

  it('skips model inference when the adapter exposes no actions', async () => {
    const { model, runtime } = createHarness({ tools: [] })

    await expect(runtime.ingest({
      sessionId: 'game-1',
      turnId: 'turn-1',
      text: '向前走',
    })).resolves.toEqual({ status: 'ignored', reason: 'no-tools' })

    expect(model.stream).not.toHaveBeenCalled()
  })

  it('maps accepted long actions and terminal failures into execution outcomes', async () => {
    const { mcp, model, runtime } = createHarness({
      tools: [{
        name: 'follow',
        description: 'Follow a player',
        inputSchema: { type: 'object', properties: {} },
        waitForTerminal: false,
      }],
    })
    mcp.callTool
      .mockResolvedValueOnce({
        status: 'accepted',
        actionId: 'action-1',
        state: 'running',
        capabilityId: 'minecraft.follow',
      })
      .mockResolvedValueOnce({
        status: 'terminal',
        actionId: 'action-2',
        state: 'failed',
        capabilityId: 'minecraft.collect',
        error: 'no oak_log nearby',
      })
    model.stream
      .mockImplementationOnce(async (request) => {
        await request.tools[0].execute({}, {
          messages: request.messages,
          toolCallId: 'tool-call-1',
        })
      })
      .mockImplementationOnce(async (request) => {
        await request.tools[0].execute({}, {
          messages: request.messages,
          toolCallId: 'tool-call-2',
        })
      })

    await expect(runtime.ingest({
      sessionId: 'game-1',
      turnId: 'turn-follow',
      text: '跟着我',
    })).resolves.toEqual({
      status: 'executed',
      toolName: 'follow',
      outcome: { kind: 'accepted' },
    })
    await expect(runtime.ingest({
      sessionId: 'game-1',
      turnId: 'turn-collect',
      text: '砍树',
    })).resolves.toEqual({
      status: 'executed',
      toolName: 'follow',
      outcome: { kind: 'failed', error: 'no oak_log nearby' },
    })
  })

  it('propagates model and MCP execution failures', async () => {
    const { mcp, model, runtime } = createHarness()
    mcp.callTool.mockRejectedValueOnce(new Error('game adapter unavailable'))
    model.stream.mockImplementationOnce(async (request) => {
      await request.tools[0].execute({}, {
        messages: request.messages,
        toolCallId: 'tool-call-1',
      })
    })

    await expect(runtime.ingest({
      sessionId: 'game-1',
      turnId: 'turn-1',
      text: '向前走',
    })).rejects.toThrow('game adapter unavailable')

    model.stream.mockRejectedValueOnce(new Error('model unavailable'))
    await expect(runtime.ingest({
      sessionId: 'game-1',
      turnId: 'turn-2',
      text: '向后走',
    })).rejects.toThrow('model unavailable')
  })

  it('keeps FIFO ordering per session', async () => {
    let releaseFirst: (() => void) | undefined
    let markFirstStarted: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const order: string[] = []
    const { model, runtime } = createHarness()
    model.stream
      .mockImplementationOnce(async () => {
        order.push('first-start')
        markFirstStarted?.()
        await firstBlocked
        order.push('first-end')
      })
      .mockImplementationOnce(async () => {
        order.push('second')
      })

    const first = runtime.ingest({ sessionId: 'game-1', turnId: 'turn-1', text: '一' })
    const second = runtime.ingest({ sessionId: 'game-1', turnId: 'turn-2', text: '二' })
    await firstStarted
    expect(order).toEqual(['first-start'])

    releaseFirst?.()
    await Promise.all([first, second])

    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('aborts active work and settles queued work on dispose', async () => {
    const { mcp, runtime } = createHarness()
    let markEnvironmentRead: (() => void) | undefined
    const environmentRead = new Promise<void>((resolve) => {
      markEnvironmentRead = resolve
    })
    mcp.readEnvironment.mockImplementationOnce(async (_sessionId, signal) => {
      markEnvironmentRead?.()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      throw new Error('unreachable')
    })

    const active = runtime.ingest({ sessionId: 'game-1', turnId: 'turn-1', text: '一' })
    const queued = runtime.ingest({ sessionId: 'game-1', turnId: 'turn-2', text: '二' })
    await environmentRead
    runtime.dispose()

    await expect(active).rejects.toMatchObject({ name: 'AbortError' })
    await expect(queued).resolves.toEqual({ status: 'ignored', reason: 'disposed' })
    await expect(runtime.ingest({
      sessionId: 'game-1',
      turnId: 'turn-3',
      text: '三',
    })).resolves.toEqual({ status: 'ignored', reason: 'disposed' })
  })
})
