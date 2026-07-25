import { describe, expect, it } from 'vitest'

import { stripCompanionDisplayMarkers } from './stripCompanionDisplayMarkers'

describe('stripCompanionDisplayMarkers', () => {
  it('strips standard ACT / DELAY tokens', () => {
    expect(stripCompanionDisplayMarkers(
      '<|ACT {"emotion":"happy","intensity":0.8}|>你好<|DELAY 1|>世界',
    )).toBe('你好世界')
  })

  it('strips malformed IACT tokens from the feed', () => {
    expect(stripCompanionDisplayMarkers(
      '<IACT {"emotion":"happy","intensity":0.8}|>哇，你好呀！',
    )).toBe('哇，你好呀！')
  })

  it('leaves plain dialogue unchanged', () => {
    expect(stripCompanionDisplayMarkers('只是普通对话')).toBe('只是普通对话')
  })
})
