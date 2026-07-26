import type {
  Client,
  WebSocketBaseEvent,
  WebSocketEventOptionalSource,
  WebSocketEvents,
} from '@proj-vera/server-sdk'

import type {
  GameActionModelRequest,
  GameActionTurnResult,
} from '../../../../packages/core-agent/src/runtime/gameActionRuntime'
import type { GameCoopServerChannel } from '../../../../packages/stage-ui/src/services/game-coop/serverGameAdapter'
import type {
  MinecraftGameDriver,
  MinecraftSnapshot,
} from './minecraftGameAdapter'

import { WebSocketEventSource } from '@proj-vera/server-sdk'
import { describe, expect, it, vi } from 'vitest'

import { createGameActionRuntime } from '../../../../packages/core-agent/src/runtime/gameActionRuntime'
import { createDoubaoRealtimeVoiceTurnAssembler } from '../../../../packages/stage-ui/src/libs/doubaoRealtimeVoiceTurn'
import { createGameMcpClient } from '../../../../packages/stage-ui/src/services/game-coop/gameMcpClient'
import { createMinecraftMcpClient } from '../../../../packages/stage-ui/src/services/game-coop/minecraftMcpClient'
import { ServerGameAdapter } from '../../../../packages/stage-ui/src/services/game-coop/serverGameAdapter'
import { MinecraftGameAdapter } from './minecraftGameAdapter'
import { MinecraftGameCoopChannel } from './minecraftGameCoopChannel'

type StageInboundEventType
  = | 'extension:module:de-announced'
    | 'game:coop:capabilities'
    | 'game:coop:action'
    | 'game:coop:environment'
    | 'game:coop:observation'

type MinecraftInboundEventType
  = | 'game:coop:capabilities:request'
    | 'game:coop:command'
    | 'game:coop:cancel'
    | 'game:coop:environment:request'
    | 'game:coop:observation:subscribe'
    | 'game:coop:observation:unsubscribe'

const snapshot: MinecraftSnapshot = {
  connected: true,
  username: 'vera-bot',
  position: { x: 1, y: 65, z: 2 },
  health: 20,
  food: 18,
  weather: 'clear',
  time: 'morning',
  follow: {
    playerName: null,
    distance: 2,
    active: false,
    error: null,
  },
}

const environment = {
  connected: true,
  username: 'vera-bot',
  masterUsername: 'Steve',
  playersOnline: ['Steve'],
  position: { x: 1, y: 65, z: 2 },
  health: 20,
  food: 18,
  weather: 'clear',
  time: 'morning',
  lightLevel: 12,
  nearbyHostiles: 0,
  nearbyBlocks: [],
  nearestLog: null,
}

describe('minecraft closed loop E2E', () => {
  it('routes final Doubao ASR through MCP and game:coop into the Mineflayer driver', async () => {
    const bus = createGameCoopBus()
    const executeAction = vi.fn(async (tool: string, _params: Record<string, unknown>) => ({
      tool,
      ok: true,
    }))
    const driver: MinecraftGameDriver = {
      getSnapshot: vi.fn(() => snapshot),
      getEnvironment: vi.fn(() => environment),
      follow: vi.fn(),
      stopFollow: vi.fn(),
      executeAction,
      stopAction: vi.fn(async () => {}),
    }
    const gameAdapter = new MinecraftGameAdapter({ driver, now: () => 2_000 })
    const gameChannel = new MinecraftGameCoopChannel({
      client: bus.minecraftClient,
      adapter: gameAdapter,
    })
    gameChannel.init()

    const executionPort = new ServerGameAdapter({
      channel: bus.stageChannel,
      adapterId: 'minecraft',
      destination: 'module:minecraft-bot',
      replyTo: WebSocketEventSource.StageTamagotchi,
      requestTimeoutMs: 500,
      actionAckTimeoutMs: 500,
      actionTerminalTimeoutMs: 500,
    })
    let actionSequence = 0
    const mcp = createMinecraftMcpClient({
      executionPort,
      createActionId: () => `e2e-action-${++actionSequence}`,
      now: () => 2_000,
    })
    const modelRequests: GameActionModelRequest[] = []
    const runtime = createGameActionRuntime({
      mcp,
      now: () => 2_000,
      model: {
        async stream(request) {
          modelRequests.push(request)
          const say = request.tools.find(tool => tool.function.name === 'minecraft_say')
          if (say == null)
            throw new Error('Expected minecraft_say tool')
          await say.execute(
            { text: '你好，史蒂夫' },
            { messages: request.messages, toolCallId: 'e2e-tool-call-1' },
          )
        },
      },
    })
    const turnResults: Array<Promise<GameActionTurnResult>> = []
    const assembler = createDoubaoRealtimeVoiceTurnAssembler({
      sessionId: 'voice-session',
      onTurn(turn) {
        turnResults.push(runtime.ingest(turn))
      },
    })

    try {
      assembler.started('question-42')
      assembler.result([{ text: '在游戏里', is_interim: true }])
      assembler.result([{ text: '在游戏里说你好，史蒂夫', is_interim: false }])

      expect(turnResults).toEqual([])
      expect(bus.stageSent).toEqual([])
      expect(executeAction).not.toHaveBeenCalled()

      assembler.ended()
      assembler.ended()

      expect(turnResults).toHaveLength(1)
      await expect(turnResults[0]).resolves.toEqual({
        status: 'executed',
        toolName: 'minecraft_say',
        outcome: { kind: 'succeeded' },
      })
      await bus.flush()

      expect(modelRequests).toHaveLength(1)
      expect(modelRequests[0].messages[1]).toEqual({
        role: 'user',
        content: `玩家语音：在游戏里说你好，史蒂夫\n当前游戏环境：${JSON.stringify(environment)}`,
      })
      const toolNames = modelRequests[0].tools.map(tool => tool.function.name)
      expect(toolNames).toContain('minecraft_say')
      expect(toolNames).toContain('minecraft_come')
      expect(toolNames).not.toContain('minecraft_status')
      expect(toolNames).not.toContain('minecraft_collect')
      expect(executeAction).toHaveBeenCalledOnce()
      expect(executeAction).toHaveBeenCalledWith('chat', { message: '你好，史蒂夫' })

      const commands = bus.stageSent.flatMap(event =>
        event.type === 'game:coop:command' ? [event.data.command] : [],
      )
      expect(commands.map(command => command.capabilityId)).toEqual([
        'minecraft.say',
      ])
      expect(commands[0]).toMatchObject({
        sessionId: 'voice-session',
        turnId: 'question-42',
        actionId: 'e2e-action-1',
        capabilityId: 'minecraft.say',
        input: { text: '你好，史蒂夫' },
      })

      const sayStates = bus.minecraftSent.flatMap(event =>
        event.type === 'game:coop:action'
        && event.data.event.capabilityId === 'minecraft.say'
          ? [event.data.event.state]
          : [],
      )
      expect(sayStates).toEqual(['queued', 'running', 'succeeded'])
    }
    finally {
      runtime.dispose()
      await mcp.dispose()
      await bus.flush()
      gameChannel.destroy()
    }

    expect(bus.stageListenerCount()).toBe(0)
    expect(bus.minecraftListenerCount()).toBe(0)
  })

  it('companion path exposes medium tools and routes craft over game:coop', async () => {
    const bus = createGameCoopBus()
    const executeAction = vi.fn(async (tool: string, params: Record<string, unknown>) => ({
      tool,
      params,
      ok: true,
    }))
    const driver: MinecraftGameDriver = {
      getSnapshot: vi.fn(() => snapshot),
      getEnvironment: vi.fn(() => environment),
      follow: vi.fn(),
      stopFollow: vi.fn(),
      executeAction,
      stopAction: vi.fn(async () => {}),
    }
    const gameAdapter = new MinecraftGameAdapter({ driver, now: () => 2_000 })
    const gameChannel = new MinecraftGameCoopChannel({
      client: bus.minecraftClient,
      adapter: gameAdapter,
    })
    gameChannel.init()

    const executionPort = new ServerGameAdapter({
      channel: bus.stageChannel,
      adapterId: 'minecraft',
      destination: 'module:minecraft-bot',
      replyTo: WebSocketEventSource.StageTamagotchi,
      requestTimeoutMs: 500,
      actionAckTimeoutMs: 500,
      actionTerminalTimeoutMs: 500,
    })
    let actionSequence = 0
    // Product companion path: generic MCP + low/medium risk projection.
    const mcp = createGameMcpClient({
      executionPort,
      createActionId: () => `companion-e2e-${++actionSequence}`,
      now: () => 2_000,
      allowedRisks: ['low', 'medium'],
    })
    const modelRequests: GameActionModelRequest[] = []
    const runtime = createGameActionRuntime({
      mcp,
      now: () => 2_000,
      model: {
        async stream(request) {
          modelRequests.push(request)
          const craft = request.tools.find(tool => tool.function.name === 'minecraft_craft')
          if (craft == null)
            throw new Error('Expected minecraft_craft tool')
          await craft.execute(
            { itemName: 'stick', count: 1 },
            { messages: request.messages, toolCallId: 'companion-e2e-tool-1' },
          )
        },
      },
    })
    const turnResults: Array<Promise<GameActionTurnResult>> = []
    const assembler = createDoubaoRealtimeVoiceTurnAssembler({
      sessionId: 'companion-voice',
      onTurn(turn) {
        turnResults.push(runtime.ingest(turn))
      },
    })

    try {
      assembler.started('craft-turn-1')
      assembler.result([{ text: '帮我合成木棍', is_interim: false }])
      assembler.ended()

      expect(turnResults).toHaveLength(1)
      await expect(turnResults[0]).resolves.toEqual({
        status: 'executed',
        toolName: 'minecraft_craft',
        outcome: { kind: 'succeeded' },
      })
      await bus.flush()

      const toolNames = modelRequests[0].tools.map(tool => tool.function.name)
      expect(toolNames).toContain('minecraft_craft')
      expect(toolNames).toContain('minecraft_collect')
      expect(toolNames).toContain('minecraft_come')
      expect(toolNames).toContain('minecraft_give')
      expect(toolNames).not.toContain('minecraft_status')

      expect(executeAction).toHaveBeenCalledOnce()
      expect(executeAction).toHaveBeenCalledWith('craftRecipe', {
        recipe_name: 'stick',
        num: 1,
        mode: 'execute',
      })

      const commands = bus.stageSent.flatMap(event =>
        event.type === 'game:coop:command' ? [event.data.command] : [],
      )
      expect(commands).toEqual([
        expect.objectContaining({
          sessionId: 'companion-voice',
          turnId: 'craft-turn-1',
          actionId: 'companion-e2e-1',
          capabilityId: 'minecraft.craft',
          input: { itemName: 'stick', count: 1 },
        }),
      ])

      const craftStates = bus.minecraftSent.flatMap(event =>
        event.type === 'game:coop:action'
        && event.data.event.capabilityId === 'minecraft.craft'
          ? [event.data.event.state]
          : [],
      )
      expect(craftStates).toEqual(['queued', 'running', 'succeeded'])
    }
    finally {
      runtime.dispose()
      await mcp.dispose()
      await bus.flush()
      gameChannel.destroy()
    }

    expect(bus.stageListenerCount()).toBe(0)
    expect(bus.minecraftListenerCount()).toBe(0)
  })

  it('companion path routes come (low) and rejects stale high-risk tools', async () => {
    const bus = createGameCoopBus()
    const executeAction = vi.fn(async (tool: string, params: Record<string, unknown>) => ({
      tool,
      params,
      ok: true,
    }))
    const driver: MinecraftGameDriver = {
      getSnapshot: vi.fn(() => snapshot),
      getEnvironment: vi.fn(() => environment),
      follow: vi.fn(),
      stopFollow: vi.fn(),
      executeAction,
      stopAction: vi.fn(async () => {}),
    }
    const gameAdapter = new MinecraftGameAdapter({ driver, now: () => 2_000 })
    const gameChannel = new MinecraftGameCoopChannel({
      client: bus.minecraftClient,
      adapter: gameAdapter,
    })
    gameChannel.init()

    const executionPort = new ServerGameAdapter({
      channel: bus.stageChannel,
      adapterId: 'minecraft',
      destination: 'module:minecraft-bot',
      replyTo: WebSocketEventSource.StageTamagotchi,
      requestTimeoutMs: 500,
      actionAckTimeoutMs: 500,
      actionTerminalTimeoutMs: 500,
    })
    let actionSequence = 0
    const mcp = createGameMcpClient({
      executionPort,
      createActionId: () => `come-e2e-${++actionSequence}`,
      now: () => 2_000,
      allowedRisks: ['low', 'medium'],
    })
    const runtime = createGameActionRuntime({
      mcp,
      now: () => 2_000,
      model: {
        async stream(request) {
          expect(request.tools.some(tool => tool.function.name === 'minecraft_attack_player')).toBe(false)
          const come = request.tools.find(tool => tool.function.name === 'minecraft_come')
          if (come == null)
            throw new Error('Expected minecraft_come tool')
          await come.execute(
            { playerName: 'Steve', closeness: 3 },
            { messages: request.messages, toolCallId: 'come-e2e-tool-1' },
          )
        },
      },
    })

    try {
      await expect(runtime.ingest({
        sessionId: 'companion-voice',
        turnId: 'come-turn-1',
        text: '到我这里来',
      })).resolves.toEqual({
        status: 'executed',
        toolName: 'minecraft_come',
        outcome: { kind: 'succeeded' },
      })
      await bus.flush()

      expect(executeAction).toHaveBeenCalledWith('goToPlayer', {
        player_name: 'Steve',
        closeness: 3,
      })
      const commands = bus.stageSent.flatMap(event =>
        event.type === 'game:coop:command' ? [event.data.command] : [],
      )
      expect(commands[0]).toMatchObject({
        capabilityId: 'minecraft.come',
        input: { playerName: 'Steve', closeness: 3 },
      })
    }
    finally {
      runtime.dispose()
      await mcp.dispose()
      await bus.flush()
      gameChannel.destroy()
    }
  })

  it('companion path exposes expanded tools and routes waypoint then mine_at over game:coop', async () => {
    const bus = createGameCoopBus()
    const executeAction = vi.fn(async (tool: string, params: Record<string, unknown>) => ({
      tool,
      params,
      ok: true,
    }))
    const driver: MinecraftGameDriver = {
      getSnapshot: vi.fn(() => snapshot),
      getEnvironment: vi.fn(() => environment),
      follow: vi.fn(),
      stopFollow: vi.fn(),
      executeAction,
      stopAction: vi.fn(async () => {}),
    }
    const gameAdapter = new MinecraftGameAdapter({ driver, now: () => 2_000 })
    const gameChannel = new MinecraftGameCoopChannel({
      client: bus.minecraftClient,
      adapter: gameAdapter,
    })
    gameChannel.init()

    const executionPort = new ServerGameAdapter({
      channel: bus.stageChannel,
      adapterId: 'minecraft',
      destination: 'module:minecraft-bot',
      replyTo: WebSocketEventSource.StageTamagotchi,
      requestTimeoutMs: 500,
      actionAckTimeoutMs: 500,
      actionTerminalTimeoutMs: 500,
    })
    let actionSequence = 0
    const mcp = createGameMcpClient({
      executionPort,
      createActionId: () => `expand-e2e-${++actionSequence}`,
      now: () => 2_000,
      allowedRisks: ['low', 'medium'],
    })
    const modelRequests: GameActionModelRequest[] = []
    let turnIndex = 0
    const runtime = createGameActionRuntime({
      mcp,
      now: () => 2_000,
      model: {
        async stream(request) {
          modelRequests.push(request)
          const toolNames = request.tools.map(tool => tool.function.name)
          expect(toolNames).toContain('minecraft_mine_at')
          expect(toolNames).toContain('minecraft_chest')
          expect(toolNames).toContain('minecraft_goto_block')
          expect(toolNames).toContain('minecraft_waypoint')
          expect(toolNames).toContain('minecraft_farm')
          expect(toolNames).not.toContain('minecraft_recipe')
          expect(toolNames).not.toContain('minecraft_chest_put')

          const waypoint = request.tools.find(tool => tool.function.name === 'minecraft_waypoint')
          const mineAt = request.tools.find(tool => tool.function.name === 'minecraft_mine_at')
          if (waypoint == null || mineAt == null)
            throw new Error('Expected waypoint and mine_at tools')

          if (turnIndex === 0) {
            await waypoint.execute(
              { action: 'set', name: 'camp' },
              { messages: request.messages, toolCallId: 'wp-set-1' },
            )
          }
          else {
            await mineAt.execute(
              { target: '8,64,9' },
              { messages: request.messages, toolCallId: 'mine-e2e-1' },
            )
          }
          turnIndex += 1
        },
      },
    })

    try {
      await expect(runtime.ingest({
        sessionId: 'companion-voice',
        turnId: 'expand-turn-1',
        text: '记住这里叫 camp',
      })).resolves.toMatchObject({ status: 'executed' })
      await bus.flush()

      await expect(runtime.ingest({
        sessionId: 'companion-voice',
        turnId: 'expand-turn-2',
        text: '挖那个坐标',
      })).resolves.toMatchObject({ status: 'executed' })
      await bus.flush()

      expect(executeAction).toHaveBeenCalledWith('mineBlockAt', {
        x: 8,
        y: 64,
        z: 9,
      })

      const commands = bus.stageSent.flatMap(event =>
        event.type === 'game:coop:command' ? [event.data.command] : [],
      )
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          capabilityId: 'minecraft.waypoint',
          input: { action: 'set', name: 'camp' },
        }),
        expect.objectContaining({
          capabilityId: 'minecraft.mine_at',
          input: { target: '8,64,9' },
        }),
      ]))

      const mineStates = bus.minecraftSent.flatMap(event =>
        event.type === 'game:coop:action'
        && event.data.event.capabilityId === 'minecraft.mine_at'
          ? [event.data.event.state]
          : [],
      )
      expect(mineStates).toEqual(['queued', 'running', 'succeeded'])

      const waypointStates = bus.minecraftSent.flatMap(event =>
        event.type === 'game:coop:action'
        && event.data.event.capabilityId === 'minecraft.waypoint'
          ? [event.data.event.state]
          : [],
      )
      expect(waypointStates).toContain('succeeded')
      expect(modelRequests).toHaveLength(2)
    }
    finally {
      runtime.dispose()
      await mcp.dispose()
      await bus.flush()
      gameChannel.destroy()
    }
  })
})

function createGameCoopBus() {
  const stageListeners = new Map<StageInboundEventType, Set<(event: never) => void | Promise<void>>>()
  const minecraftListeners = new Map<MinecraftInboundEventType, Set<(event: never) => void | Promise<void>>>()
  const disconnectListeners = new Set<(reason?: string) => void>()
  const pendingHandlers = new Set<Promise<void>>()
  const handlerErrors: unknown[] = []
  const stageSent: WebSocketEventOptionalSource[] = []
  const minecraftSent: WebSocketEventOptionalSource[] = []
  let eventSequence = 0

  function track(result: void | Promise<void>) {
    if (result == null)
      return
    const task = Promise.resolve(result).catch((error) => {
      handlerErrors.push(error)
    })
    pendingHandlers.add(task)
    void task.finally(() => pendingHandlers.delete(task))
  }

  function dispatch(
    listeners: Set<(event: never) => void | Promise<void>> | undefined,
    event: WebSocketBaseEvent<keyof WebSocketEvents, WebSocketEvents[keyof WebSocketEvents]>,
  ) {
    for (const listener of listeners ?? [])
      track(listener(event as never))
  }

  function envelope<E extends keyof WebSocketEvents>(
    type: E,
    data: WebSocketEvents[E],
    source: { id: string, extension: { id: string } },
  ): WebSocketBaseEvent<E, WebSocketEvents[E]> {
    eventSequence += 1
    return {
      type,
      data,
      metadata: {
        source,
        event: { id: `bus-event-${eventSequence}` },
      },
    }
  }

  const stageChannel: GameCoopServerChannel = {
    isConnected: () => true,
    send(event) {
      stageSent.push(event)
      const type = event.type as MinecraftInboundEventType
      dispatch(
        minecraftListeners.get(type),
        envelope(type, event.data as WebSocketEvents[typeof type], {
          id: 'stage-instance',
          extension: { id: 'stage-tamagotchi' },
        }),
      )
    },
    onEvent(type, listener) {
      const eventListeners = stageListeners.get(type) ?? new Set<(event: never) => void | Promise<void>>()
      eventListeners.add(listener as (event: never) => void | Promise<void>)
      stageListeners.set(type, eventListeners)
      return () => eventListeners.delete(listener as (event: never) => void | Promise<void>)
    },
    onDisconnected(listener) {
      disconnectListeners.add(listener)
      return () => disconnectListeners.delete(listener)
    },
  }

  const onEvent: Client['onEvent'] = vi.fn((type, listener) => {
    const inboundType = type as MinecraftInboundEventType
    const eventListeners = minecraftListeners.get(inboundType) ?? new Set<(event: never) => void | Promise<void>>()
    eventListeners.add(listener as (event: never) => void | Promise<void>)
    minecraftListeners.set(inboundType, eventListeners)
    return () => eventListeners.delete(listener as (event: never) => void | Promise<void>)
  })
  const send = vi.fn((event: WebSocketEventOptionalSource) => {
    minecraftSent.push(event)
    const type = event.type as StageInboundEventType
    dispatch(
      stageListeners.get(type),
      envelope(type, event.data as WebSocketEvents[typeof type], {
        id: 'minecraft-instance',
        extension: { id: 'minecraft-bot' },
      }),
    )
    return true
  })

  return {
    stageChannel,
    minecraftClient: { onEvent, send },
    stageSent,
    minecraftSent,
    async flush() {
      while (pendingHandlers.size > 0)
        await Promise.all(pendingHandlers)
      if (handlerErrors.length > 0)
        throw handlerErrors[0]
    },
    stageListenerCount() {
      return [...stageListeners.values()].reduce((count, listeners) => count + listeners.size, 0)
        + disconnectListeners.size
    },
    minecraftListenerCount() {
      return [...minecraftListeners.values()].reduce((count, listeners) => count + listeners.size, 0)
    },
  }
}
