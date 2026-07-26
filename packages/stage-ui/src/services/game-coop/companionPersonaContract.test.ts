import { describe, expect, it } from 'vitest'

import {
  buildLayer1HybridRules,
  buildLayer1PersonaSection,
  buildLayer2DecisionRules,
  buildLayer2SystemPrompt,
  buildSharedPersona,
} from './companionPersonaContract'

describe('companionPersonaContract', () => {
  it('shares persona identity across Layer 1 and Layer 2 builders', () => {
    const shared = buildSharedPersona('你是 Vera。')
    expect(buildLayer1PersonaSection('你是 Vera。')).toContain(shared)
    expect(buildLayer2SystemPrompt('你是 Vera。')).toContain(shared)
    expect(shared).toContain('不要提工具名、模型名、豆包、DeepSeek 或系统分层')
  })

  it('keeps Layer 1 hybrid short-ack and no-completion rules', () => {
    const rules = buildLayer1HybridRules()
    expect(rules).toContain('先短接玩家意向')
    expect(rules).toContain('禁止说已经砍好')
    expect(rules).toContain('已确认事实')
    expect(rules).toContain('需纠正')
    expect(rules).toContain('禁止说做不到')
  })

  it('keeps Layer 2 tool-call ownership rules', () => {
    const rules = buildLayer2DecisionRules()
    expect(rules).toContain('必须调用对应工具')
    expect(rules).toContain('nearestLog')
    expect(buildLayer2SystemPrompt('你是 Vera。')).toContain(rules)
  })
})
