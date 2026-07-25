import type { RealtimeVoiceClient, RealtimeVoiceUpstream } from './session'

import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { decodeRealtimeVoiceFrame, encodeRealtimeVoiceFrame, realtimeVoiceEvents } from './protocol'
import { createRealtimeVoiceSession } from './session'

class TestClient implements RealtimeVoiceClient {
  sent: Array<string | Uint8Array<ArrayBuffer>> = []
  closed: Array<{ code?: number, reason?: string }> = []

  send(data: string | Uint8Array<ArrayBuffer>) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.closed.push({ code, reason })
  }
}

class TestUpstream implements RealtimeVoiceUpstream {
  sent: Buffer[] = []
  closed: number[] = []
  open = false
  private openListeners: Array<() => void> = []
  private messageListeners: Array<(data: Buffer) => void> = []
  private closeListeners: Array<(code: number, reason: string) => void> = []
  private errorListeners: Array<(error: Error) => void> = []

  isOpen() {
    return this.open
  }

  send(data: Buffer) {
    this.sent.push(data)
  }

  close(code = 1000) {
    this.closed.push(code)
    this.open = false
  }

  onOpen(listener: () => void) {
    this.openListeners.push(listener)
  }

  onMessage(listener: (data: Buffer) => void) {
    this.messageListeners.push(listener)
  }

  onClose(listener: (code: number, reason: string) => void) {
    this.closeListeners.push(listener)
  }

  onError(listener: (error: Error) => void) {
    this.errorListeners.push(listener)
  }

  emitOpen() {
    this.open = true
    for (const listener of this.openListeners)
      listener()
  }

  emitMessage(data: Buffer) {
    for (const listener of this.messageListeners)
      listener(data)
  }

  emitError(error: Error) {
    for (const listener of this.errorListeners)
      listener(error)
  }
}

describe('realtime voice session', () => {
  it('rejects duplicate start without opening another upstream', () => {
    const client = new TestClient()
    const upstream = new TestUpstream()
    let openCount = 0
    const session = createRealtimeVoiceSession({
      openUpstream() {
        openCount += 1
        return upstream
      },
    })
    session.attachClient(client)
    const start = JSON.stringify(startRequest('session-1'))

    session.handleClientMessage({ data: start }, client)
    session.handleClientMessage({ data: start }, client)

    expect(openCount).toBe(1)
    expect(client.sent.at(-1)).toBe(JSON.stringify({
      event: 'error',
      code: 'duplicate_start',
      message: 'realtime voice session already started',
    }))
  })

  it('ignores stale session frames and disposes upstream in protocol order', () => {
    const client = new TestClient()
    const upstream = new TestUpstream()
    const session = createRealtimeVoiceSession({ openUpstream: () => upstream })
    session.attachClient(client)
    session.handleClientMessage({ data: JSON.stringify(startRequest('session-1')) }, client)
    upstream.emitOpen()
    upstream.emitMessage(serverConnectionFrame(50, {}))
    upstream.emitMessage(serverFrame(realtimeVoiceEvents.sessionStarted, 'stale-session', { dialog_id: 'ignored' }))

    expect(client.sent).toHaveLength(0)

    upstream.emitMessage(serverFrame(realtimeVoiceEvents.sessionStarted, 'session-1', { dialog_id: 'dialog-1' }))
    session.close()

    expect(client.sent).toEqual([JSON.stringify({ event: 'session.started', dialog_id: 'dialog-1' })])
    expect(upstream.sent.map(frame => decodeRealtimeVoiceFrame(frame).event)).toEqual([
      realtimeVoiceEvents.startConnection,
      realtimeVoiceEvents.startSession,
      realtimeVoiceEvents.finishSession,
      realtimeVoiceEvents.finishConnection,
    ])
    expect(upstream.closed).toEqual([1000])
  })

  it('settles an upstream failure and ignores later audio', () => {
    const client = new TestClient()
    const upstream = new TestUpstream()
    const session = createRealtimeVoiceSession({ openUpstream: () => upstream })
    session.attachClient(client)
    session.handleClientMessage({ data: JSON.stringify(startRequest('session-1')) }, client)
    upstream.emitOpen()
    upstream.emitError(new Error('dial failed'))
    const sentBeforeLateAudio = upstream.sent.length

    session.handleClientMessage({ data: Buffer.from([1, 2]) }, client)

    expect(client.sent.at(-1)).toBe(JSON.stringify({
      event: 'error',
      code: 'upstream_error',
      message: 'dial failed',
    }))
    expect(upstream.sent).toHaveLength(sentBeforeLateAudio)
  })

  it('forwards ASR turn boundaries and preserves question correlation', () => {
    const client = new TestClient()
    const upstream = new TestUpstream()
    const session = createRealtimeVoiceSession({ openUpstream: () => upstream })
    session.attachClient(client)
    session.handleClientMessage({ data: JSON.stringify(startRequest('session-1')) }, client)
    upstream.emitOpen()

    upstream.emitMessage(serverFrame(450, 'session-1', { question_id: 'question-1' }))
    upstream.emitMessage(serverFrame(451, 'session-1', {
      results: [{ text: '向前走', is_interim: false }],
    }))
    upstream.emitMessage(serverFrame(459, 'session-1', {}))

    expect(client.sent).toEqual([
      JSON.stringify({ event: 'asr.started', question_id: 'question-1' }),
      JSON.stringify({
        event: 'asr.result',
        results: [{ text: '向前走', is_interim: false }],
      }),
      JSON.stringify({ event: 'asr.ended' }),
    ])
  })

  it('forwards runtime context updates to the active Doubao session', () => {
    const client = new TestClient()
    const upstream = new TestUpstream()
    const session = createRealtimeVoiceSession({ openUpstream: () => upstream })
    session.attachClient(client)
    session.handleClientMessage({ data: JSON.stringify(startRequest('session-1')) }, client)
    upstream.emitOpen()
    upstream.emitMessage(serverConnectionFrame(50, {}))
    upstream.emitMessage(serverFrame(realtimeVoiceEvents.sessionStarted, 'session-1', {}))

    session.handleClientMessage({
      data: JSON.stringify({
        event: 'update',
        config: {
          dialog: {
            system_role: '当前游戏环境：{"position":{"x":12,"y":64,"z":-8}}',
          },
        },
      }),
    }, client)

    const update = decodeRealtimeVoiceFrame(upstream.sent.at(-1)!)
    expect(update.event).toBe(realtimeVoiceEvents.updateConfig)
    expect(update.sessionId).toBe('session-1')
    expect(JSON.parse(update.payload.toString('utf8'))).toEqual({
      dialog: {
        system_role: '当前游戏环境：{"position":{"x":12,"y":64,"z":-8}}',
      },
    })
  })
})

function startRequest(sessionId: string) {
  return {
    event: 'start',
    appId: 'app-id',
    accessKey: 'access-key',
    sessionId,
    config: { asr: { extra: {} }, tts: { extra: {} } },
  }
}

function serverFrame(event: number, sessionId: string, payload: Record<string, unknown>) {
  const frame = encodeRealtimeVoiceFrame(event, payload, sessionId)
  frame[1] = 0x94
  return frame
}

function serverConnectionFrame(event: number, payload: Record<string, unknown>) {
  const frame = encodeRealtimeVoiceFrame(event, payload)
  frame[1] = 0x94
  return frame
}
