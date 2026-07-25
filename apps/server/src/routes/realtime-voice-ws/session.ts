import { Buffer } from 'node:buffer'

import WebSocket from 'ws'

import { useLogger } from '@guiiai/logg'

import {
  decodeRealtimeVoiceFrame,
  encodeRealtimeVoiceFrame,
  parseRealtimeVoiceJson,
  realtimeVoiceEvents,
} from './protocol'

const log = useLogger('realtime-voice-ws').useGlobalConfig()
const upstreamUrl = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue'

interface StartRequest {
  event: 'start'
  appId: string
  accessKey: string
  sessionId: string
  config: Record<string, unknown>
}

interface UpdateRequest {
  event: 'update'
  config: Record<string, unknown>
}

export interface RealtimeVoiceClient {
  send: (data: string | Uint8Array<ArrayBuffer>) => void
  close: (code?: number, reason?: string) => void
}

export interface RealtimeVoiceUpstream {
  isOpen: () => boolean
  send: (data: Buffer) => void
  close: (code?: number) => void
  onOpen: (listener: () => void) => void
  onMessage: (listener: (data: Buffer) => void) => void
  onClose: (listener: (code: number, reason: string) => void) => void
  onError: (listener: (error: Error) => void) => void
}

export interface RealtimeVoiceSessionOptions {
  openUpstream?: (request: StartRequest) => RealtimeVoiceUpstream
}

export interface RealtimeVoiceSession {
  attachClient: (ws: RealtimeVoiceClient) => void
  handleClientMessage: (message: { data: unknown }, ws: RealtimeVoiceClient) => void
  close: () => void
}

/** Owns one browser ↔ Vera server ↔ Doubao realtime voice lifecycle. */
export function createRealtimeVoiceSession(options: RealtimeVoiceSessionOptions = {}): RealtimeVoiceSession {
  let client: RealtimeVoiceClient | undefined
  let upstream: RealtimeVoiceUpstream | undefined
  let sessionId: string | undefined
  let started = false
  let sessionStarted = false
  let closed = false
  let pendingAudioBytes = 0
  const pendingAudio: Buffer[] = []
  let pendingConfigUpdate: Record<string, unknown> | undefined

  function attachClient(ws: RealtimeVoiceClient) {
    client = ws
  }

  function handleClientMessage(message: { data: unknown }, ws: RealtimeVoiceClient) {
    if (closed)
      return

    if (typeof message.data === 'string') {
      handleControl(message.data, ws)
      return
    }

    if (!started) {
      failClient('start_required', 'start event must precede audio')
      return
    }

    const audio = toBuffer(message.data)
    if (audio.length === 0)
      return
    if (audio.length > 256 * 1024) {
      failClient('audio_frame_too_large', 'audio frame exceeds 256 KiB')
      return
    }

    if (!sessionStarted || !upstream?.isOpen()) {
      pendingAudioBytes += audio.length
      if (pendingAudioBytes > 2 * 1024 * 1024) {
        failClient('audio_buffer_exceeded', 'audio buffered before session start exceeds 2 MiB')
        close()
        return
      }
      pendingAudio.push(audio)
      return
    }
    sendAudio(audio)
  }

  function handleControl(raw: string, ws: RealtimeVoiceClient) {
    let request: unknown
    try {
      request = JSON.parse(raw)
    }
    catch {
      failClient('invalid_json', 'control frame must be JSON')
      return
    }

    if (!isRecord(request) || typeof request.event !== 'string') {
      failClient('invalid_control', 'control frame event is required')
      return
    }

    if (request.event === 'stop') {
      close()
      try {
        ws.close(1000, 'session_finished')
      }
      catch {}
      return
    }

    if (request.event === 'update') {
      if (!started || sessionId == null) {
        failClient('start_required', 'start event must precede config updates')
        return
      }
      if (!isUpdateRequest(request)) {
        failClient('invalid_update', 'config update must be an object')
        return
      }
      if (!sessionStarted || !upstream?.isOpen()) {
        pendingConfigUpdate = request.config
        return
      }
      upstream.send(encodeRealtimeVoiceFrame(
        realtimeVoiceEvents.updateConfig,
        request.config,
        sessionId,
      ))
      return
    }

    if (request.event !== 'start') {
      failClient('unsupported_control', `unsupported control event: ${request.event}`)
      return
    }
    if (started) {
      failClient('duplicate_start', 'realtime voice session already started')
      return
    }
    if (!isStartRequest(request)) {
      failClient('invalid_start', 'appId, accessKey, sessionId, and config are required')
      return
    }

    started = true
    sessionId = request.sessionId
    dial(request)
  }

  function dial(request: StartRequest) {
    const connection = (options.openUpstream ?? openDoubaoUpstream)(request)
    upstream = connection

    connection.onOpen(() => {
      connection.send(encodeRealtimeVoiceFrame(realtimeVoiceEvents.startConnection, {}))
    })
    connection.onMessage((data) => {
      handleUpstreamMessage(data, request.config)
    })
    connection.onError((error) => {
      log.withError(error).warn('Doubao realtime voice upstream error')
      failClient('upstream_error', error.message)
      close()
    })
    connection.onClose((code, reason) => {
      if (!closed && code !== 1000) {
        failClient('upstream_closed', reason || `upstream closed (${code})`)
        close()
      }
    })
  }

  function handleUpstreamMessage(data: Buffer, config: Record<string, unknown>) {
    let frame
    try {
      frame = decodeRealtimeVoiceFrame(data)
    }
    catch (error) {
      failClient('upstream_protocol_error', error instanceof Error ? error.message : String(error))
      close()
      return
    }

    if (frame.sessionId != null && frame.sessionId !== sessionId) {
      log.withFields({ expectedSessionId: sessionId, receivedSessionId: frame.sessionId }).warn('ignored stale realtime voice frame')
      return
    }

    if (frame.event === 50) {
      upstream?.send(encodeRealtimeVoiceFrame(
        realtimeVoiceEvents.startSession,
        config,
        sessionId,
      ))
      return
    }

    if (frame.event === realtimeVoiceEvents.sessionStarted) {
      sessionStarted = true
      const payload = readJsonPayload(frame)
      if (payload == null)
        return
      sendClientJson('session.started', payload)
      for (const audio of pendingAudio)
        sendAudio(audio)
      pendingAudio.length = 0
      pendingAudioBytes = 0
      if (pendingConfigUpdate != null) {
        upstream?.send(encodeRealtimeVoiceFrame(
          realtimeVoiceEvents.updateConfig,
          pendingConfigUpdate,
          sessionId,
        ))
        pendingConfigUpdate = undefined
      }
      return
    }

    if (frame.event === realtimeVoiceEvents.ttsResponse) {
      try {
        client?.send(Uint8Array.from(frame.payload))
      }
      catch {}
      return
    }

    const event = clientEventName(frame.event)
    if (event != null) {
      const payload = readJsonPayload(frame)
      if (payload == null)
        return
      sendClientJson(event, payload)
    }

    if (frame.messageType === 0x0F)
      failClient('upstream_protocol_error', frame.payload.toString('utf8'))
  }

  function readJsonPayload(frame: ReturnType<typeof decodeRealtimeVoiceFrame>) {
    try {
      return parseRealtimeVoiceJson(frame)
    }
    catch (error) {
      failClient('upstream_protocol_error', error instanceof Error ? error.message : String(error))
      close()
    }
  }

  function sendAudio(audio: Buffer) {
    if (sessionId == null || !upstream?.isOpen())
      return
    upstream.send(encodeRealtimeVoiceFrame(realtimeVoiceEvents.taskRequest, audio, sessionId))
  }

  function sendClientJson(event: string, payload: Record<string, unknown>) {
    try {
      client?.send(JSON.stringify({ event, ...payload }))
    }
    catch {}
  }

  function failClient(code: string, message: string) {
    if (closed)
      return
    sendClientJson('error', { code, message })
  }

  function close() {
    if (closed)
      return
    closed = true
    pendingAudio.length = 0
    pendingAudioBytes = 0
    pendingConfigUpdate = undefined

    if (upstream?.isOpen()) {
      if (sessionStarted && sessionId != null)
        upstream.send(encodeRealtimeVoiceFrame(realtimeVoiceEvents.finishSession, {}, sessionId))
      upstream.send(encodeRealtimeVoiceFrame(realtimeVoiceEvents.finishConnection, {}))
      upstream.close(1000)
    }
    else {
      upstream?.close()
    }
    upstream = undefined
    client = undefined
  }

  return { attachClient, handleClientMessage, close }
}

function openDoubaoUpstream(request: StartRequest): RealtimeVoiceUpstream {
  const socket = new WebSocket(upstreamUrl, {
    headers: {
      'X-Api-App-ID': request.appId,
      'X-Api-Access-Key': request.accessKey,
      'X-Api-Resource-Id': 'volc.speech.dialog',
      'X-Api-App-Key': 'PlgvMymc7f3tQnJ6',
      'X-Api-Connect-Id': request.sessionId,
    },
  })

  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: data => socket.send(data),
    close: code => socket.close(code),
    onOpen: listener => socket.on('open', listener),
    onMessage: listener => socket.on('message', data => listener(toBuffer(data))),
    onClose: listener => socket.on('close', (code, reason) => listener(code, reason.toString())),
    onError: listener => socket.on('error', listener),
  }
}

function clientEventName(event?: number) {
  switch (event) {
    case 51: return 'error'
    case realtimeVoiceEvents.sessionFinished: return 'session.finished'
    case realtimeVoiceEvents.sessionFailed: return 'session.failed'
    case realtimeVoiceEvents.asrInfo: return 'asr.started'
    case realtimeVoiceEvents.asrResponse: return 'asr.result'
    case realtimeVoiceEvents.asrEnded: return 'asr.ended'
    case realtimeVoiceEvents.chatResponse: return 'chat.result'
    case realtimeVoiceEvents.chatEnded: return 'chat.ended'
    case realtimeVoiceEvents.dialogError: return 'error'
  }
}

function isStartRequest(value: unknown): value is StartRequest {
  return isRecord(value)
    && value.event === 'start'
    && typeof value.appId === 'string'
    && value.appId.trim().length > 0
    && typeof value.accessKey === 'string'
    && value.accessKey.trim().length > 0
    && typeof value.sessionId === 'string'
    && value.sessionId.trim().length > 0
    && isRecord(value.config)
}

function isUpdateRequest(value: unknown): value is UpdateRequest {
  return isRecord(value)
    && value.event === 'update'
    && isRecord(value.config)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value))
    return value
  if (value instanceof ArrayBuffer)
    return Buffer.from(value)
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (Array.isArray(value))
    return Buffer.concat(value.map(toBuffer))
  throw new TypeError('unsupported websocket frame')
}
