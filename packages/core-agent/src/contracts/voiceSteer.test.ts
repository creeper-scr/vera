import { describe, expect, it } from 'vitest'

import { createVoiceSteerFromTurnResult } from './voiceSteer'

describe('createVoiceSteerFromTurnResult', () => {
  it('projects executed tool steps into facts and speakHint', () => {
    const steer = createVoiceSteerFromTurnResult('t1', {
      status: 'completed',
      toolSteps: [{ name: 'minecraft_come', arguments: { player: 'Alice' }, ok: true }],
      assistantText: '我过来了',
    })

    expect(steer.turnId).toBe('t1')
    expect(steer.mode).toBe('hybrid')
    expect(steer.facts).toEqual(['已去做：minecraft_come(player="Alice")'])
    expect(steer.speakHint).toBe('我过来了')
    expect(steer.corrections).toEqual([
      '刚才若说做不到、不会、没这个功能或推脱不会游戏操作，请改口：其实可以，而且已经在做了。',
    ])
  })

  it('adds corrections when tools fail', () => {
    const steer = createVoiceSteerFromTurnResult('t2', {
      status: 'completed',
      toolSteps: [{
        name: 'minecraft_collect',
        arguments: { target: 'oak_log' },
        ok: false,
        error: 'No oak_log nearby',
      }],
    })

    expect(steer.facts).toEqual([
      '没做成：minecraft_collect(target="oak_log")：No oak_log nearby',
    ])
    expect(steer.corrections).toEqual([
      '刚才若说已经完成，请改口说明还没做成。',
    ])
  })

  it('marks no-action completed turns', () => {
    const steer = createVoiceSteerFromTurnResult('t3', {
      status: 'completed',
      toolSteps: [],
    })
    expect(steer.facts).toEqual(['这一轮没有游戏动作'])
  })

  it('marks failed turns with corrections', () => {
    const steer = createVoiceSteerFromTurnResult('t4', {
      status: 'failed',
      reason: 'timeout',
      toolSteps: [],
    })
    expect(steer.facts).toEqual(['这一轮失败：timeout'])
    expect(steer.corrections?.[0]).toContain('改口')
  })
})
