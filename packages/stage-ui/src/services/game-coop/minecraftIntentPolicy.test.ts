import type {
  GameCapability,
  GameCommand,
} from '@proj-vera/game-coop-core'

import type { ResolveGameIntentInput } from './agent'
import type { UserTurn } from './interaction'

import { describe, expect, it } from 'vitest'

import { MinecraftIntentPolicy } from './minecraftIntentPolicy'

function capability(capabilityId: string): GameCapability {
  return {
    capabilityId,
    description: capabilityId,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    risk: 'low',
    cancellable: false,
  }
}

function input(text: string, capabilities = [
  capability('minecraft.status'),
  capability('minecraft.follow'),
  capability('minecraft.stop'),
]): ResolveGameIntentInput {
  return {
    turn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      timestamp: 1,
      text,
    },
    capabilities,
  }
}

function command(capabilityId: string, commandInput: GameCommand['input'] = {}): GameCommand {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    actionId: 'action-1',
    capabilityId,
    input: commandInput,
  }
}

const turn: UserTurn = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  timestamp: 1,
  text: '查看 Minecraft 状态',
}

describe('minecraft intent policy', () => {
  const policy = new MinecraftIntentPolicy()

  it('selects only capabilities present in the live catalog', async () => {
    await expect(policy.resolve(input('跟随 Steve 距离 3')))
      .resolves
      .toEqual({
        capabilityId: 'minecraft.follow',
        input: {
          playerName: 'Steve',
          distance: 3,
        },
      })

    await expect(policy.resolve(input('跟随 Steve', [capability('minecraft.status')])))
      .resolves
      .toBeNull()
  })

  it('prioritizes stop over the follow keyword', async () => {
    await expect(policy.resolve(input('停止跟随 Steve')))
      .resolves
      .toEqual({
        capabilityId: 'minecraft.stop',
        input: {},
      })
  })

  it('describes status snapshots without importing Minecraft runtime types', () => {
    expect(policy.describeAction({
      turn,
      capability: capability('minecraft.status'),
      command: command('minecraft.status'),
      event: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        actionId: 'action-1',
        capabilityId: 'minecraft.status',
        state: 'succeeded',
        timestamp: 2,
        result: {
          username: 'Vera',
          health: 20,
          food: 18,
          position: { x: 1, y: 64, z: -2 },
        },
      },
    })).toBe('Vera 当前状态，生命 20，饥饿 18，位置 1.0, 64.0, -2.0。')
  })
})
