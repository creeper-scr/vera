export const doubaoRealtimeVoiceEvents = {
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
  doubaoRealtimeVoiceEvents.startConnection,
  doubaoRealtimeVoiceEvents.finishConnection,
  50,
  51,
  52,
])

/** One decoded Volcengine realtime-dialogue binary frame. */
export interface DoubaoRealtimeVoiceFrame {
  event?: number
  sessionId?: string
  payload: Uint8Array
  messageType: number
  errorCode?: number
}

/**
 * Encodes one Volcengine realtime-dialogue event using big-endian lengths.
 *
 * Session-scoped events carry the same session ID across all frames. JSON
 * values are UTF-8 encoded; `Uint8Array` payloads remain raw PCM.
 */
export function encodeDoubaoRealtimeVoiceFrame(
  event: number,
  payload: Uint8Array | Record<string, unknown>,
  sessionId?: string,
): Uint8Array {
  const isAudio = event === doubaoRealtimeVoiceEvents.taskRequest
  const body = payload instanceof Uint8Array
    ? payload
    : new TextEncoder().encode(JSON.stringify(payload))
  const session = sessionId == null ? undefined : new TextEncoder().encode(sessionId)
  const optionalLength = 4 + (session == null ? 0 : 4 + session.length)
  const frame = new Uint8Array(4 + optionalLength + 4 + body.length)
  const view = new DataView(frame.buffer)

  frame[0] = 0x11
  frame[1] = (isAudio ? 0x20 : 0x10) | 0x04
  frame[2] = isAudio ? 0x00 : 0x10
  frame[3] = 0x00

  let offset = 4
  view.setInt32(offset, event)
  offset += 4
  if (session != null) {
    view.setInt32(offset, session.length)
    offset += 4
    frame.set(session, offset)
    offset += session.length
  }
  view.setInt32(offset, body.length)
  offset += 4
  frame.set(body, offset)

  return frame
}

/** Decodes server JSON, audio, and error frames without retaining raw input. */
export function decodeDoubaoRealtimeVoiceFrame(input: ArrayBuffer | ArrayBufferView): DoubaoRealtimeVoiceFrame {
  const data = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (data.length < 8)
    throw new Error('realtime voice frame is truncated')

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const headerLength = (data[0] & 0x0F) * 4
  const messageType = data[1] >> 4
  const flags = data[1] & 0x0F
  let offset = headerLength
  let errorCode: number | undefined
  let event: number | undefined
  let sessionId: string | undefined

  if (messageType === 0x0F) {
    errorCode = readInt32(view, data.length, offset, 'error code')
    offset += 4
  }
  else {
    if (flags === 0x01 || flags === 0x03)
      offset += 4
    if ((flags & 0x04) !== 0) {
      event = readInt32(view, data.length, offset, 'event')
      offset += 4
    }

    if (event != null && !connectionEvents.has(event)) {
      const sessionLength = readInt32(view, data.length, offset, 'session id length')
      offset += 4
      ensureAvailable(data.length, offset, sessionLength, 'session id')
      sessionId = new TextDecoder().decode(data.subarray(offset, offset + sessionLength))
      offset += sessionLength
    }
  }

  const payloadLength = readInt32(view, data.length, offset, 'payload length')
  offset += 4
  ensureAvailable(data.length, offset, payloadLength, 'payload')

  return {
    event,
    sessionId,
    payload: data.slice(offset, offset + payloadLength),
    messageType,
    errorCode,
  }
}

/** Parses a decoded JSON payload and rejects non-object protocol values. */
export function parseDoubaoRealtimeVoiceJson(frame: DoubaoRealtimeVoiceFrame): Record<string, unknown> {
  if (frame.payload.length === 0)
    return {}

  const value: unknown = JSON.parse(new TextDecoder().decode(frame.payload))
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('realtime voice JSON payload must be an object')
  return value as Record<string, unknown>
}

function readInt32(view: DataView, length: number, offset: number, field: string) {
  ensureAvailable(length, offset, 4, field)
  return view.getInt32(offset)
}

function ensureAvailable(totalLength: number, offset: number, length: number, field: string) {
  if (length < 0 || offset + length > totalLength)
    throw new Error(`realtime voice frame has invalid ${field}`)
}
