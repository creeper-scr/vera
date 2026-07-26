import type { GameActionModelRequest } from '../../../../packages/core-agent/src/runtime/gameActionRuntime'
import type {
  MinecraftGameDriver,
  MinecraftSnapshot,
} from './minecraftGameAdapter'

import { describe, expect, it, vi } from 'vitest'

import { createGameActionRuntime } from '../../../../packages/core-agent/src/runtime/gameActionRuntime'
import { createGameMcpClient } from '../../../../packages/stage-ui/src/services/game-coop/gameMcpClient'
import { createMinecraftMcpClient } from '../../../../packages/stage-ui/src/services/game-coop/minecraftMcpClient'
import { MinecraftGameAdapter } from './minecraftGameAdapter'

const snapshot: MinecraftSnapshot = {
  connected: true,
  username: 'vera-bot',
  position: { x: 10, y: 64, z: -3 },
  health: 20,
  food: 20,
  weather: 'clear',
  time: 'noon',
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
  position: { x: 10, y: 64, z: -3 },
  health: 20,
  food: 20,
  weather: 'clear',
  time: 'noon',
  lightLevel: 15,
  nearbyHostiles: null,
  nearbyBlocks: [],
  nearestLog: null,
}

function createTaskDriver(executeAction = vi.fn(async (tool: string, _params: Record<string, unknown>) => ({
  tool,
  ok: true,
}))): MinecraftGameDriver {
  return {
    getSnapshot: vi.fn(() => snapshot),
    getEnvironment: vi.fn(() => environment),
    follow: vi.fn(),
    stopFollow: vi.fn(),
    executeAction,
    stopAction: vi.fn(async () => {}),
  }
}

describe('minecraft game action integration', () => {
  it('legacy MCP path keeps medium collect tools hidden (low-risk only)', async () => {
    const executeAction = vi.fn(async (tool: string, _params: Record<string, unknown>) => ({
      tool,
      ok: true,
    }))
    const adapter = new MinecraftGameAdapter({
      driver: createTaskDriver(executeAction),
      now: () => 1_000,
    })
    let actionSequence = 0
    const mcp = createMinecraftMcpClient({
      executionPort: adapter,
      createActionId: () => `action-${++actionSequence}`,
      now: () => 1_000,
    })
    const modelRequests: GameActionModelRequest[] = []
    const runtime = createGameActionRuntime({
      mcp,
      now: () => 1_000,
      model: {
        async stream(request) {
          modelRequests.push(request)
          const say = request.tools.find(tool => tool.function.name === 'minecraft_say')
          if (say == null)
            throw new Error('Expected minecraft_say tool')
          await say.execute(
            { text: '你好，世界' },
            { messages: request.messages, toolCallId: 'model-tool-call-1' },
          )
        },
      },
    })

    try {
      await expect(runtime.ingest({
        sessionId: 'voice-session',
        turnId: 'question-1',
        text: '在游戏里说你好，世界',
      })).resolves.toEqual({
        status: 'executed',
        toolName: 'minecraft_say',
        outcome: { kind: 'succeeded' },
      })

      expect(modelRequests).toHaveLength(1)
      expect(modelRequests[0].messages[1]).toEqual({
        role: 'user',
        content: `玩家语音：在游戏里说你好，世界\n当前游戏环境：${JSON.stringify(environment)}`,
      })
      const toolNames = modelRequests[0].tools.map(tool => tool.function.name)
      expect(toolNames).toContain('minecraft_say')
      expect(toolNames).toContain('minecraft_come')
      expect(toolNames).toContain('minecraft_give')
      expect(toolNames).not.toContain('minecraft_status')
      expect(toolNames).not.toContain('minecraft_collect')
      expect(toolNames).not.toContain('minecraft_craft')
      expect(executeAction).toHaveBeenCalledOnce()
      expect(executeAction).toHaveBeenCalledWith('chat', { message: '你好，世界' })
    }
    finally {
      runtime.dispose()
      await mcp.dispose()
    }
  })

  it('companion MCP path exposes medium tools and executes come through adapter', async () => {
    const executeAction = vi.fn(async (tool: string, _params: Record<string, unknown>) => ({
      tool,
      ok: true,
    }))
    const adapter = new MinecraftGameAdapter({
      driver: createTaskDriver(executeAction),
      now: () => 1_000,
    })
    let actionSequence = 0
    const mcp = createGameMcpClient({
      executionPort: adapter,
      createActionId: () => `companion-action-${++actionSequence}`,
      now: () => 1_000,
      allowedRisks: ['low', 'medium'],
    })
    const modelRequests: GameActionModelRequest[] = []
    const runtime = createGameActionRuntime({
      mcp,
      now: () => 1_000,
      model: {
        async stream(request) {
          modelRequests.push(request)
          const come = request.tools.find(tool => tool.function.name === 'minecraft_come')
          if (come == null)
            throw new Error('Expected minecraft_come tool')
          await come.execute(
            { playerName: 'Steve', closeness: 2 },
            { messages: request.messages, toolCallId: 'companion-tool-call-1' },
          )
        },
      },
    })

    try {
      await expect(runtime.ingest({
        sessionId: 'companion-session',
        turnId: 'come-1',
        text: '过来',
      })).resolves.toEqual({
        status: 'executed',
        toolName: 'minecraft_come',
        outcome: { kind: 'succeeded' },
      })

      const toolNames = modelRequests[0].tools.map(tool => tool.function.name)
      expect(toolNames).toContain('minecraft_come')
      expect(toolNames).toContain('minecraft_collect')
      expect(toolNames).toContain('minecraft_craft')
      expect(toolNames).toContain('minecraft_attack')
      expect(toolNames).not.toContain('minecraft_status')
      expect(executeAction).toHaveBeenCalledOnce()
      expect(executeAction).toHaveBeenCalledWith('goToPlayer', {
        player_name: 'Steve',
        closeness: 2,
      })
    }
    finally {
      runtime.dispose()
      await mcp.dispose()
    }
  })

  it('companion MCP path executes medium craft capability end-to-end', async () => {
    const executeAction = vi.fn(async (tool: string, params: Record<string, unknown>) => ({
      tool,
      params,
      ok: true,
    }))
    const adapter = new MinecraftGameAdapter({
      driver: createTaskDriver(executeAction),
      now: () => 1_000,
    })
    let actionSequence = 0
    const mcp = createGameMcpClient({
      executionPort: adapter,
      createActionId: () => `craft-action-${++actionSequence}`,
      now: () => 1_000,
      allowedRisks: ['low', 'medium'],
    })
    const runtime = createGameActionRuntime({
      mcp,
      now: () => 1_000,
      model: {
        async stream(request) {
          const craft = request.tools.find(tool => tool.function.name === 'minecraft_craft')
          if (craft == null)
            throw new Error('Expected minecraft_craft tool')
          await craft.execute(
            { itemName: 'stick', count: 2 },
            { messages: request.messages, toolCallId: 'craft-tool-call-1' },
          )
        },
      },
    })

    try {
      await expect(runtime.ingest({
        sessionId: 'companion-session',
        turnId: 'craft-1',
        text: '帮我合成木棍',
      })).resolves.toEqual({
        status: 'executed',
        toolName: 'minecraft_craft',
        outcome: { kind: 'succeeded' },
      })
      expect(executeAction).toHaveBeenCalledWith('craftRecipe', {
        recipe_name: 'stick',
        num: 2,
        mode: 'execute',
      })
    }
    finally {
      runtime.dispose()
      await mcp.dispose()
    }
  })

  it('companion MCP path exposes expanded tools and executes mine_at chest goto_block across turns', async () => {
    const executeAction = vi.fn(async (tool: string, params: Record<string, unknown>) => ({
      tool,
      params,
      ok: true,
    }))
    const adapter = new MinecraftGameAdapter({
      driver: createTaskDriver(executeAction),
      now: () => 1_000,
    })
    let actionSequence = 0
    const mcp = createGameMcpClient({
      executionPort: adapter,
      createActionId: () => `expand-action-${++actionSequence}`,
      now: () => 1_000,
      allowedRisks: ['low', 'medium'],
    })
    const modelRequests: GameActionModelRequest[] = []
    let turnIndex = 0
    const runtime = createGameActionRuntime({
      mcp,
      now: () => 1_000,
      model: {
        async stream(request) {
          modelRequests.push(request)
          const mineAt = request.tools.find(tool => tool.function.name === 'minecraft_mine_at')
          const chest = request.tools.find(tool => tool.function.name === 'minecraft_chest')
          const gotoBlock = request.tools.find(tool => tool.function.name === 'minecraft_goto_block')
          if (mineAt == null || chest == null || gotoBlock == null)
            throw new Error('Expected expanded companion tools')

          if (turnIndex === 0) {
            await mineAt.execute(
              { target: '3,64,4', expectedBlockType: 'oak_log' },
              { messages: request.messages, toolCallId: 'mine-1' },
            )
          }
          else if (turnIndex === 1) {
            await chest.execute(
              { action: 'view' },
              { messages: request.messages, toolCallId: 'chest-1' },
            )
          }
          else {
            await gotoBlock.execute(
              { blockType: 'crafting_table', closeness: 2 },
              { messages: request.messages, toolCallId: 'goto-1' },
            )
          }
          turnIndex += 1
        },
      },
    })

    try {
      await expect(runtime.ingest({
        sessionId: 'companion-session',
        turnId: 'expand-1',
        text: '挖那棵树旁边的方块',
      })).resolves.toMatchObject({ status: 'executed' })
      await expect(runtime.ingest({
        sessionId: 'companion-session',
        turnId: 'expand-2',
        text: '看看箱子',
      })).resolves.toMatchObject({ status: 'executed' })
      await expect(runtime.ingest({
        sessionId: 'companion-session',
        turnId: 'expand-3',
        text: '走到工作台',
      })).resolves.toMatchObject({ status: 'executed' })

      const toolNames = modelRequests[0].tools.map(tool => tool.function.name)
      expect(toolNames).toContain('minecraft_mine_at')
      expect(toolNames).toContain('minecraft_chest')
      expect(toolNames).toContain('minecraft_goto_block')
      expect(toolNames).toContain('minecraft_waypoint')
      expect(toolNames).toContain('minecraft_farm')
      expect(toolNames).not.toContain('minecraft_recipe')
      expect(toolNames).not.toContain('minecraft_chest_put')
      expect(toolNames).not.toContain('minecraft_status')

      expect(executeAction).toHaveBeenCalledWith('mineBlockAt', {
        x: 3,
        y: 64,
        z: 4,
        expected_block_type: 'oak_log',
      })
      expect(executeAction).toHaveBeenCalledWith('chest', { action: 'view' })
      expect(executeAction).toHaveBeenCalledWith('goToNearestBlock', {
        type: 'crafting_table',
        closeness: 2,
        range: 64,
      })
    }
    finally {
      runtime.dispose()
      await mcp.dispose()
    }
  })
})
