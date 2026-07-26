import type {
  DoubaoRealtimeVoiceTurnAssemblerOptions,
  DoubaoRealtimeVoiceUserTurn,
} from './doubaoRealtimeVoiceTurn'

import {
  decodeDoubaoRealtimeVoiceFrame,
  doubaoRealtimeVoiceEvents,
  encodeDoubaoRealtimeVoiceFrame,
  parseDoubaoRealtimeVoiceJson,
} from '@proj-vera/stage-shared'

import { getAuthToken } from './auth'
import { createDoubaoRealtimeVoiceTurnAssembler } from './doubaoRealtimeVoiceTurn'
import { SERVER_URL } from './server'

export interface DoubaoRealtimeVoiceCredentials {
  appId: string
  accessKey: string
}

export interface DoubaoRealtimeVoiceOptions {
  workletUrl: string
  credentials: DoubaoRealtimeVoiceCredentials
  /** Uses a runtime-owned credential proxy instead of Vera's authenticated hosted relay. */
  resolveConnectionUrl?: (credentials: DoubaoRealtimeVoiceCredentials) => Promise<string>
  /** Character prompt shared with the companion decision model for this session. */
  systemPrompt?: string
  /** Character name exposed to Doubao; capped by provider limit when encoded. */
  botName?: string
  /** Stable provider conversation id; Doubao restores its latest 20 QA pairs. */
  dialogId?: string
  onAssistantSpeaking: (speaking: boolean) => void
  onUserTranscript?: (text: string) => void
  onUserTurn?: (turn: DoubaoRealtimeVoiceUserTurn) => void
  onAssistantText?: (text: string) => void
  onError?: (error: Error) => void
}

interface ServerEvent {
  event: string
  code?: string
  message?: string
  error?: string
  content?: string
  question_id?: string
  reply_id?: string
  results?: Array<{ text?: string, is_interim?: boolean }>
}

/**
 * Runs one full-duplex Doubao speech-to-speech session.
 *
 * Microphone capture never pauses for assistant playback. `asr.started`
 * immediately clears locally queued PCM, making server first-token detection
 * the single barge-in signal.
 */
export class DoubaoRealtimeVoiceSession {
  private socket?: WebSocket
  private captureContext?: AudioContext
  private captureSource?: MediaStreamAudioSourceNode
  private captureWorklet?: AudioWorkletNode
  private playbackContext?: AudioContext
  private playbackAt = 0
  private playbackSources = new Set<AudioBufferSourceNode>()
  private turnAssembler?: ReturnType<typeof createDoubaoRealtimeVoiceTurnAssembler>
  private assistantText = ''
  private assistantReplyId?: string
  private directProtocol = false
  private sessionStarted = false
  private sessionId?: string
  private systemPrompt?: string
  private lastSentSystemRole?: string
  private pendingAudio: ArrayBuffer[] = []
  private pendingAudioBytes = 0
  private generation = 0

  constructor(private readonly options: DoubaoRealtimeVoiceOptions) {
    this.systemPrompt = options.systemPrompt?.trim()
  }

  async start(stream: MediaStream) {
    await this.stop()
    const generation = ++this.generation
    const connectionUrl = await this.resolveConnectionUrl()
    if (generation !== this.generation)
      return

    const sessionId = crypto.randomUUID()
    this.sessionId = sessionId
    this.turnAssembler = createDoubaoRealtimeVoiceTurnAssembler({
      sessionId,
      onTranscript: this.options.onUserTranscript,
      onTurn: this.options.onUserTurn,
    } satisfies DoubaoRealtimeVoiceTurnAssemblerOptions)

    const socket = new WebSocket(connectionUrl)
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.addEventListener('open', () => {
      if (generation !== this.generation)
        return
      if (this.directProtocol) {
        socket.send(encodeDoubaoRealtimeVoiceFrame(doubaoRealtimeVoiceEvents.startConnection, {}))
      }
      else {
        const config = createSessionConfig(this.options, this.systemPrompt)
        this.lastSentSystemRole = config.dialog.system_role
        socket.send(JSON.stringify({
          event: 'start',
          appId: this.options.credentials.appId,
          accessKey: this.options.credentials.accessKey,
          sessionId,
          config,
        }))
      }
    })
    socket.addEventListener('message', (event) => {
      if (generation !== this.generation || this.socket !== socket)
        return
      this.handleServerMessage(event)
    })
    socket.addEventListener('error', () => {
      if (generation === this.generation && this.socket === socket)
        this.reportError(new Error('Doubao realtime voice connection failed'))
    })
    socket.addEventListener('close', (event) => {
      if (generation === this.generation && event.code !== 1000)
        this.reportError(new Error(event.reason || `Doubao realtime voice closed (${event.code})`))
    })

    await this.startCapture(stream, generation)
  }

  async stop() {
    this.generation += 1
    this.clearPlayback()
    this.turnAssembler?.reset()
    this.turnAssembler = undefined
    this.assistantText = ''
    this.assistantReplyId = undefined

    this.captureWorklet?.disconnect()
    this.captureSource?.disconnect()
    this.captureWorklet = undefined
    this.captureSource = undefined
    if (this.captureContext != null)
      await this.captureContext.close()
    this.captureContext = undefined

    const socket = this.socket
    this.socket = undefined
    if (socket?.readyState === WebSocket.OPEN) {
      if (this.directProtocol) {
        if (this.sessionStarted && this.sessionId != null) {
          socket.send(encodeDoubaoRealtimeVoiceFrame(
            doubaoRealtimeVoiceEvents.finishSession,
            {},
            this.sessionId,
          ))
        }
        socket.send(encodeDoubaoRealtimeVoiceFrame(doubaoRealtimeVoiceEvents.finishConnection, {}))
      }
      else {
        socket.send(JSON.stringify({ event: 'stop' }))
      }
      socket.close(1000)
    }
    else {
      socket?.close()
    }

    if (this.playbackContext != null)
      await this.playbackContext.close()
    this.playbackContext = undefined
    this.directProtocol = false
    this.sessionStarted = false
    this.sessionId = undefined
    this.lastSentSystemRole = undefined
    this.pendingAudio = []
    this.pendingAudioBytes = 0
  }

  private async startCapture(stream: MediaStream, generation: number) {
    const context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
    await context.audioWorklet.addModule(this.options.workletUrl)
    if (generation !== this.generation) {
      await context.close()
      return
    }

    const source = context.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(context, 'vad-audio-worklet-processor')
    const silentSink = context.createGain()
    silentSink.gain.value = 0
    source.connect(worklet)
    worklet.connect(silentSink)
    silentSink.connect(context.destination)
    worklet.port.onmessage = ({ data }: MessageEvent<{ buffer?: Float32Array }>) => {
      if (generation !== this.generation || this.socket?.readyState !== WebSocket.OPEN || data.buffer == null)
        return
      this.sendAudio(float32ToPcm16(data.buffer))
    }

    this.captureContext = context
    this.captureSource = source
    this.captureWorklet = worklet
  }

  /**
   * Replaces runtime context without changing voice-session identity or tool policy.
   * Volcengine applies `UpdateConfig(201)` to subsequent dialogue inference.
   */
  updateSystemPrompt(systemPrompt: string) {
    this.systemPrompt = systemPrompt.trim()
    this.sendSystemPromptUpdate()
  }

  private handleServerMessage(event: MessageEvent<ArrayBuffer | string>) {
    if (this.directProtocol) {
      if (typeof event.data === 'string') {
        this.reportError(new Error('Doubao realtime voice returned an unexpected text frame'))
        return
      }
      this.handleDirectServerMessage(event.data)
      return
    }

    if (typeof event.data !== 'string') {
      this.playPcm(event.data)
      return
    }

    let message: ServerEvent
    try {
      message = JSON.parse(event.data) as ServerEvent
    }
    catch {
      this.reportError(new Error('Doubao realtime voice returned invalid JSON'))
      return
    }

    this.handleServerEvent(message)
  }

  private handleDirectServerMessage(data: ArrayBuffer) {
    let frame
    try {
      frame = decodeDoubaoRealtimeVoiceFrame(data)
    }
    catch (error) {
      this.reportError(error instanceof Error ? error : new Error('Doubao realtime voice returned an invalid frame'))
      return
    }

    if (frame.sessionId != null && frame.sessionId !== this.sessionId)
      return

    if (frame.messageType === 0x0F) {
      const message = new TextDecoder().decode(frame.payload)
      this.reportError(new Error(message || `Doubao realtime voice protocol error (${frame.errorCode ?? 'unknown'})`))
      return
    }
    if (frame.event === 50) {
      if (this.sessionId != null) {
        const config = createSessionConfig(this.options, this.systemPrompt)
        this.lastSentSystemRole = config.dialog.system_role
        this.socket?.send(encodeDoubaoRealtimeVoiceFrame(
          doubaoRealtimeVoiceEvents.startSession,
          config,
          this.sessionId,
        ))
      }
      return
    }
    if (frame.event === doubaoRealtimeVoiceEvents.sessionStarted) {
      this.sessionStarted = true
      for (const audio of this.pendingAudio)
        this.sendAudio(audio)
      this.pendingAudio = []
      this.pendingAudioBytes = 0
      this.sendSystemPromptUpdate()
      return
    }
    if (frame.event === doubaoRealtimeVoiceEvents.ttsResponse) {
      this.playPcm(frame.payload.slice().buffer)
      return
    }

    const eventName = directClientEventName(frame.event)
    if (eventName == null)
      return

    try {
      this.handleServerEvent({
        ...parseDoubaoRealtimeVoiceJson(frame),
        event: eventName,
      })
    }
    catch (error) {
      this.reportError(error instanceof Error ? error : new Error('Doubao realtime voice returned invalid JSON'))
    }
  }

  private handleServerEvent(message: ServerEvent) {
    if (message.event === 'session.started') {
      this.sessionStarted = true
      this.sendSystemPromptUpdate()
      return
    }
    if (message.event === 'asr.started') {
      this.flushAssistantText()
      this.clearPlayback()
      this.turnAssembler?.started(message.question_id)
      return
    }
    if (message.event === 'asr.result') {
      this.turnAssembler?.result(message.results ?? [], message.question_id)
      return
    }
    if (message.event === 'asr.ended') {
      this.turnAssembler?.ended(message.question_id)
      return
    }
    if (message.event === 'chat.result' && message.content?.trim()) {
      if (this.assistantReplyId != null && message.reply_id != null && message.reply_id !== this.assistantReplyId)
        this.flushAssistantText()
      this.assistantReplyId = message.reply_id ?? this.assistantReplyId
      this.assistantText += message.content
      return
    }
    if (message.event === 'chat.ended') {
      if (message.reply_id == null || this.assistantReplyId == null || message.reply_id === this.assistantReplyId)
        this.flushAssistantText()
      return
    }
    if (message.event === 'session.finished')
      this.flushAssistantText()
    if (message.event === 'error' || message.event === 'session.failed')
      this.reportError(new Error(message.message || message.error || message.code || 'Doubao realtime voice session failed'))
  }

  private flushAssistantText() {
    const text = this.assistantText.trim()
    this.assistantText = ''
    this.assistantReplyId = undefined
    if (text)
      this.options.onAssistantText?.(text)
  }

  private sendAudio(audio: ArrayBuffer) {
    if (!this.directProtocol) {
      this.socket?.send(audio)
      return
    }
    if (!this.sessionStarted || this.sessionId == null) {
      this.pendingAudioBytes += audio.byteLength
      if (this.pendingAudioBytes <= 2 * 1024 * 1024)
        this.pendingAudio.push(audio)
      else
        this.reportError(new Error('Doubao realtime voice startup audio buffer exceeded 2 MiB'))
      return
    }
    this.socket?.send(encodeDoubaoRealtimeVoiceFrame(
      doubaoRealtimeVoiceEvents.taskRequest,
      new Uint8Array(audio),
      this.sessionId,
    ))
  }

  private sendSystemPromptUpdate() {
    if (
      !this.sessionStarted
      || this.sessionId == null
      || this.socket?.readyState !== WebSocket.OPEN
    ) {
      return
    }

    const systemRole = createSystemRole(this.options, this.systemPrompt)
    if (systemRole === this.lastSentSystemRole)
      return
    this.lastSentSystemRole = systemRole

    const config = { dialog: { system_role: systemRole } }
    if (this.directProtocol) {
      this.socket.send(encodeDoubaoRealtimeVoiceFrame(
        doubaoRealtimeVoiceEvents.updateConfig,
        config,
        this.sessionId,
      ))
      return
    }
    this.socket.send(JSON.stringify({ event: 'update', config }))
  }

  private async resolveConnectionUrl() {
    if (this.options.resolveConnectionUrl != null) {
      this.directProtocol = true
      return await this.options.resolveConnectionUrl(this.options.credentials)
    }

    this.directProtocol = false
    const playRelay = String(import.meta.env.VITE_DOUBAO_REALTIME_WS_URL ?? '').trim()
    if (playRelay)
      return playRelay

    const token = getAuthToken()
    if (!token)
      throw new Error('Doubao realtime voice requires authentication')
    return toWebSocketUrl(SERVER_URL, token)
  }

  private playPcm(pcm: ArrayBuffer) {
    if (pcm.byteLength < 2)
      return
    const context = this.playbackContext ?? new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' })
    this.playbackContext = context

    const samples = new DataView(pcm)
    const sampleCount = Math.floor(samples.byteLength / 2)
    const buffer = context.createBuffer(1, sampleCount, 24000)
    const channel = buffer.getChannelData(0)
    for (let index = 0; index < sampleCount; index++)
      channel[index] = samples.getInt16(index * 2, true) / 0x8000

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      this.playbackSources.delete(source)
      if (this.playbackSources.size === 0)
        this.options.onAssistantSpeaking(false)
    }
    this.playbackSources.add(source)
    this.options.onAssistantSpeaking(true)
    this.playbackAt = Math.max(context.currentTime, this.playbackAt)
    source.start(this.playbackAt)
    this.playbackAt += buffer.duration
  }

  private clearPlayback() {
    for (const source of this.playbackSources) {
      try {
        source.stop()
      }
      catch {}
    }
    this.playbackSources.clear()
    this.playbackAt = 0
    this.options.onAssistantSpeaking(false)
  }

  private reportError(error: Error) {
    this.options.onError?.(error)
  }
}

function createSessionConfig(options: DoubaoRealtimeVoiceOptions, systemPrompt = options.systemPrompt) {
  const botName = [...(options.botName?.trim() || 'Vera')].slice(0, 20).join('')
  return {
    asr: {
      audio_info: {
        format: 'pcm',
        sample_rate: 16000,
        channel: 1,
      },
      extra: {},
    },
    dialog: {
      bot_name: botName,
      system_role: createSystemRole(options, systemPrompt),
      speaking_style: '自然、有温度，避免冗长回答。',
      dialog_id: options.dialogId || undefined,
      extra: {
        model: '1.2.1.1',
        enable_conversation_truncate: true,
      },
    },
    tts: {
      speaker: 'zh_female_vv_jupiter_bigtts',
      audio_config: {
        channel: 1,
        format: 'pcm_s16le',
        sample_rate: 24000,
      },
      extra: {},
    },
  }
}

function createSystemRole(options: DoubaoRealtimeVoiceOptions, systemPrompt = options.systemPrompt) {
  const botName = [...(options.botName?.trim() || 'Vera')].slice(0, 20).join('')
  return [
    systemPrompt?.trim() || `你是 ${botName}。`,
    '你正在作为玩家的实时游戏陪玩伙伴交流。',
    `严格保持上述角色身份；名字是 ${botName}。不要自称豆包、火山引擎、DeepSeek 或其他模型名。`,
    '自然、简洁地短接话；只输出适合直接朗读的自然口语，不要输出 XML、JSON、动作标记或其他控制标记。',
    '未出现「已确认事实」前不要说完成态；有「需纠正」先改口；有「已确认事实」下一句必须对齐。',
    '能力清单里有的事，禁止说做不到或不会；先答应再等事实更新。',
    '游戏动作由同一角色的决策侧执行，不要虚构动作已经完成。',
  ].join('\n\n')
}

function directClientEventName(event?: number) {
  switch (event) {
    case 51: return 'error'
    case doubaoRealtimeVoiceEvents.sessionFinished: return 'session.finished'
    case doubaoRealtimeVoiceEvents.sessionFailed: return 'session.failed'
    case doubaoRealtimeVoiceEvents.asrInfo: return 'asr.started'
    case doubaoRealtimeVoiceEvents.asrResponse: return 'asr.result'
    case doubaoRealtimeVoiceEvents.asrEnded: return 'asr.ended'
    case doubaoRealtimeVoiceEvents.chatResponse: return 'chat.result'
    case doubaoRealtimeVoiceEvents.chatEnded: return 'chat.ended'
    case doubaoRealtimeVoiceEvents.dialogError: return 'error'
  }
}

function float32ToPcm16(input: Float32Array) {
  const output = new ArrayBuffer(input.length * 2)
  const view = new DataView(output)
  for (let index = 0; index < input.length; index++) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
  }
  return output
}

function toWebSocketUrl(serverUrl: string, token: string) {
  const url = new URL('/api/v1/audio/realtime/ws', serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url.toString()
}
