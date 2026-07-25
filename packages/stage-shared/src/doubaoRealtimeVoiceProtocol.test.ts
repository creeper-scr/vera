import { describe, expect, it } from 'vitest'

import {
  decodeDoubaoRealtimeVoiceFrame,
  doubaoRealtimeVoiceEvents,
  encodeDoubaoRealtimeVoiceFrame,
  parseDoubaoRealtimeVoiceJson,
} from './doubaoRealtimeVoiceProtocol'

describe('doubao realtime voice protocol', () => {
  it('round-trips session JSON and raw PCM frames', () => {
    const json = decodeDoubaoRealtimeVoiceFrame(encodeDoubaoRealtimeVoiceFrame(
      doubaoRealtimeVoiceEvents.startSession,
      { dialog: { bot_name: 'Vera' } },
      'session-1',
    ))
    const pcm = new Uint8Array([0x01, 0x00, 0xFF, 0x7F])
    const audio = decodeDoubaoRealtimeVoiceFrame(encodeDoubaoRealtimeVoiceFrame(
      doubaoRealtimeVoiceEvents.taskRequest,
      pcm,
      'session-1',
    ))

    expect(json.event).toBe(doubaoRealtimeVoiceEvents.startSession)
    expect(json.sessionId).toBe('session-1')
    expect(parseDoubaoRealtimeVoiceJson(json)).toEqual({ dialog: { bot_name: 'Vera' } })
    expect(audio.messageType).toBe(0x02)
    expect(audio.payload).toEqual(pcm)
  })

  it('rejects truncated payloads', () => {
    const encoded = encodeDoubaoRealtimeVoiceFrame(doubaoRealtimeVoiceEvents.startConnection, {})

    expect(() => decodeDoubaoRealtimeVoiceFrame(encoded.subarray(0, -1))).toThrow('invalid payload')
  })
})
