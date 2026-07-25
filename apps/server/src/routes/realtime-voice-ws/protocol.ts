import { Buffer } from 'node:buffer'

export const realtimeVoiceEvents = {
  startConnection: 1,
  finishConnection: 2,
  startSession: 100,
  finishSession: 102,
  taskRequest: 200,
  updateConfig: 201,
  sessionStarted: 150,
  configUpdated: 251,
  sessionFinished: 152,
  sessionFailed: 153,
  ttsResponse: 352,
  asrInfo: 450,
  asrResponse: 451,
  asrEnded: 459,
  chatResponse: 550,
  chatEnded: 559,
  dialogError: 599,
} as const

const connectionEvents = new Set<number>([
  realtimeVoiceEvents.startConnection,
  realtimeVoiceEvents.finishConnection,
  50,
  51,
  52,
])

export interface RealtimeVoiceFrame {
  event?: number
  sessionId?: string
  payload: Buffer
  messageType: number
  errorCode?: number
}

/**
 * Encodes one Volcengine realtime-dialogue event.
 *
 * Protocol fields use big-endian lengths. Session-scoped events carry the
 * same session ID for correlation across concurrent upstream connections.
 */
export function encodeRealtimeVoiceFrame(
  event: number,
  payload: Buffer | Record<string, unknown>,
  sessionId?: string,
): Buffer {
  const isAudio = event === realtimeVoiceEvents.taskRequest
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(JSON.stringify(payload))
  const session = sessionId == null ? undefined : Buffer.from(sessionId)
  const optionalLength = 4 + (session == null ? 0 : 4 + session.length)
  const frame = Buffer.allocUnsafe(4 + optionalLength + 4 + body.length)

  frame[0] = 0x11
  frame[1] = (isAudio ? 0x20 : 0x10) | 0x04
  frame[2] = isAudio ? 0x00 : 0x10
  frame[3] = 0x00

  let offset = 4
  frame.writeInt32BE(event, offset)
  offset += 4
  if (session != null) {
    frame.writeInt32BE(session.length, offset)
    offset += 4
    session.copy(frame, offset)
    offset += session.length
  }
  frame.writeInt32BE(body.length, offset)
  offset += 4
  body.copy(frame, offset)

  return frame
}

/** Decodes server JSON, audio, and error frames without retaining raw input. */
export function decodeRealtimeVoiceFrame(data: Buffer): RealtimeVoiceFrame {
  if (data.length < 8)
    throw new Error('realtime voice frame is truncated')

  const headerLength = (data[0] & 0x0F) * 4
  const messageType = data[1] >> 4
  const flags = data[1] & 0x0F
  let offset = headerLength
  let errorCode: number | undefined
  let event: number | undefined
  let sessionId: string | undefined

  if (messageType === 0x0F) {
    errorCode = readInt32(data, offset, 'error code')
    offset += 4
  }
  else {
    if (flags === 0x01 || flags === 0x03)
      offset += 4
    if ((flags & 0x04) !== 0) {
      event = readInt32(data, offset, 'event')
      offset += 4
    }

    if (event != null && !connectionEvents.has(event)) {
      const sessionLength = readInt32(data, offset, 'session id length')
      offset += 4
      ensureAvailable(data, offset, sessionLength, 'session id')
      sessionId = data.subarray(offset, offset + sessionLength).toString('utf8')
      offset += sessionLength
    }
  }

  const payloadLength = readInt32(data, offset, 'payload length')
  offset += 4
  ensureAvailable(data, offset, payloadLength, 'payload')

  return {
    event,
    sessionId,
    payload: data.subarray(offset, offset + payloadLength),
    messageType,
    errorCode,
  }
}

export function parseRealtimeVoiceJson(frame: RealtimeVoiceFrame): Record<string, unknown> {
  if (frame.payload.length === 0)
    return {}

  const value: unknown = JSON.parse(frame.payload.toString('utf8'))
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('realtime voice JSON payload must be an object')
  return value as Record<string, unknown>
}

function readInt32(data: Buffer, offset: number, field: string) {
  ensureAvailable(data, offset, 4, field)
  return data.readInt32BE(offset)
}

function ensureAvailable(data: Buffer, offset: number, length: number, field: string) {
  if (length < 0 || offset + length > data.length)
    throw new Error(`realtime voice frame has invalid ${field}`)
}
