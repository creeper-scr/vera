import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import {
  decodeRealtimeVoiceFrame,
  encodeRealtimeVoiceFrame,
  parseRealtimeVoiceJson,
  realtimeVoiceEvents,
} from './protocol'

describe('volcengine realtime voice protocol', () => {
  it('round-trips a session JSON event', () => {
    const encoded = encodeRealtimeVoiceFrame(
      realtimeVoiceEvents.startSession,
      { dialog: { bot_name: 'Vera' } },
      'session-1',
    )
    const decoded = decodeRealtimeVoiceFrame(encoded)

    expect(decoded.event).toBe(realtimeVoiceEvents.startSession)
    expect(decoded.sessionId).toBe('session-1')
    expect(parseRealtimeVoiceJson(decoded)).toEqual({ dialog: { bot_name: 'Vera' } })
  })

  it('round-trips PCM without JSON serialization', () => {
    const pcm = Buffer.from([0x01, 0x00, 0xFF, 0x7F])
    const decoded = decodeRealtimeVoiceFrame(encodeRealtimeVoiceFrame(
      realtimeVoiceEvents.taskRequest,
      pcm,
      'session-2',
    ))

    expect(decoded.messageType).toBe(0x02)
    expect(decoded.payload).toEqual(pcm)
  })

  it('rejects truncated payloads', () => {
    const encoded = encodeRealtimeVoiceFrame(realtimeVoiceEvents.startConnection, {})

    expect(() => decodeRealtimeVoiceFrame(encoded.subarray(0, -1))).toThrow('invalid payload')
  })
})
