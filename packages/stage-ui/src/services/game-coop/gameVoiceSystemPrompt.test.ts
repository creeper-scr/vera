import { describe, expect, it } from 'vitest'

import {
  createGameVoiceSystemPrompt,
  isGameVoiceEnvironmentStale,
  rememberGameVoiceAction,
} from './gameVoiceSystemPrompt'

describe('createGameVoiceSystemPrompt', () => {
  it('projects Layer 3 environment and Layer 2 outcomes for Layer 1', () => {
    const prompt = createGameVoiceSystemPrompt(
      {
        sessionId: 's1',
        observedAt: 1_000,
        freshnessMs: 5_000,
        content: { health: 12, position: { x: 1, y: 64, z: 2 } },
      },
      [{ name: 'minecraft_come', description: 'Walk to a player', inputSchema: { type: 'object' } }],
      [{ turnText: '过来', toolName: 'minecraft_come', status: 'executed' }],
      '你是 Vera。',
    )

    expect(prompt).toContain('你是 Vera。')
    expect(prompt).toContain('当前游戏环境：{"health":12,"position":{"x":1,"y":64,"z":2}}')
    expect(prompt).toContain('- minecraft_come：Walk to a player')
    expect(prompt).toContain('已经执行 minecraft_come')
    expect(prompt).toContain('用自然口语聊天')
  })

  it('projects failed action detail for companion speech context', () => {
    const prompt = createGameVoiceSystemPrompt(
      {
        sessionId: 's1',
        observedAt: 1_000,
        freshnessMs: 5_000,
        content: { nearestLog: null, nearbyBlocks: [] },
      },
      [],
      [{
        turnText: '砍树',
        toolName: 'minecraft_collect',
        status: 'failed',
        detail: 'minecraft_collect(target="oak_log")：No oak_log nearby',
      }],
    )

    expect(prompt).toContain('没做成：minecraft_collect(target="oak_log")：No oak_log nearby')
    expect(prompt).toContain('不要提工具名、模型名或系统分层')
  })
})

describe('isGameVoiceEnvironmentStale', () => {
  it('rejects expired snapshots', () => {
    expect(isGameVoiceEnvironmentStale({
      sessionId: 's1',
      observedAt: 1_000,
      freshnessMs: 100,
      content: {},
    }, 1_200)).toBe(true)
    expect(isGameVoiceEnvironmentStale({
      sessionId: 's1',
      observedAt: 1_000,
      freshnessMs: 500,
      content: {},
    }, 1_200)).toBe(false)
  })
})

describe('rememberGameVoiceAction', () => {
  it('keeps only the newest bounded entries', () => {
    const history: Array<{ turnText: string, toolName: string, status: 'executed' }> = []
    for (let index = 0; index < 7; index += 1) {
      rememberGameVoiceAction(history, {
        turnText: `t${index}`,
        toolName: `tool-${index}`,
        status: 'executed',
      })
    }
    expect(history).toHaveLength(5)
    expect(history[0]?.toolName).toBe('tool-2')
  })
})
