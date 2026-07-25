import type { createSpeechPipeline, IntentHandle, IntentOptions, TextToken } from '@proj-vera/pipelines-audio'

import type {
  SpeechIntentStartPayload,
  SpeechIntentTerminalPayload,
  SpeechIntentTokenPayload,
} from './bus'

import { createPushStream } from '@proj-vera/pipelines-audio'
import { Mutex } from 'es-toolkit'
import { nanoid } from 'nanoid'

import {
  getSpeechBusContext,
  speechIntentCancelEvent,
  speechIntentEndEvent,
  speechIntentFlushEvent,
  speechIntentLiteralEvent,
  speechIntentSpecialEvent,
  speechIntentStartEvent,
  speechIntentTerminalEvent,
} from './bus'

function createId(prefix: string) {
  return `${prefix}-${nanoid()}`
}

export interface SpeechPipelineRuntime {
  openIntent: (options?: IntentOptions) => IntentHandle
  waitForIntent: (intentId: string) => Promise<SpeechIntentResult>
  registerHost: (pipeline: ReturnType<typeof createSpeechPipeline<AudioBuffer>>) => Promise<void>
  isHost: () => boolean
  dispose: () => Promise<void>
}

/** Real terminal outcome reported after speech playback drains or is stopped. */
export type SpeechIntentResult = SpeechIntentTerminalPayload['result']

interface HostedIntentProgress {
  requested: number
  produced: number
  result?: Exclude<SpeechIntentResult, { status: 'completed' }>
}

export function createSpeechPipelineRuntime(): SpeechPipelineRuntime {
  const mutex = new Mutex()
  const originId = `speech-${nanoid()}`

  let hostPipeline: ReturnType<typeof createSpeechPipeline<AudioBuffer>> | null = null
  let hostReady = false
  let bound = false

  const remoteIntentMap = new Map<string, IntentHandle>()
  const hostedIntentOrigins = new Map<string, string>()
  const hostedIntentProgress = new Map<string, HostedIntentProgress>()
  const intentWaiters = new Map<string, (result: SpeechIntentResult) => void>()
  const busUnsubscribes: Array<() => void> = []
  const hostUnsubscribes: Array<() => void> = []
  const context = getSpeechBusContext()

  function settleIntent(payload: SpeechIntentTerminalPayload) {
    if (payload.originId !== originId)
      return
    const resolve = intentWaiters.get(payload.intentId)
    if (!resolve)
      return
    intentWaiters.delete(payload.intentId)
    resolve(payload.result)
  }

  const unsubscribeTerminal = context.on(speechIntentTerminalEvent, (evt) => {
    const payload = evt?.body
    if (payload)
      settleIntent(payload)
  })

  function beginHostedIntent(intentId: string, requesterOriginId: string) {
    hostedIntentOrigins.set(intentId, requesterOriginId)
    hostedIntentProgress.set(intentId, { requested: 0, produced: 0 })
  }

  function finishHostedIntent(intentId: string, result: SpeechIntentResult) {
    const requesterOriginId = hostedIntentOrigins.get(intentId)
    hostedIntentOrigins.delete(intentId)
    hostedIntentProgress.delete(intentId)
    if (!requesterOriginId)
      return

    const payload: SpeechIntentTerminalPayload = {
      originId: requesterOriginId,
      intentId,
      result,
    }
    settleIntent(payload)
    context.emit(speechIntentTerminalEvent, payload)
  }

  function bindSpeechBusToHost() {
    if (bound)
      return
    bound = true

    busUnsubscribes.push(context.on(speechIntentStartEvent, (evt) => {
      const payload = (evt as { body?: SpeechIntentStartPayload })?.body
      if (!payload || payload.originId === originId)
        return

      if (!hostPipeline)
        return

      if (remoteIntentMap.has(payload.intentId))
        return

      const intent = hostPipeline.openIntent({
        turnId: payload.turnId,
        intentId: payload.intentId,
        streamId: payload.streamId,
        ownerId: payload.ownerId,
        priority: payload.priority,
        behavior: payload.behavior,
      })

      beginHostedIntent(payload.intentId, payload.originId)
      remoteIntentMap.set(payload.intentId, intent)
    }))

    const applyToken = (payload: SpeechIntentTokenPayload, writer: (intent: IntentHandle, value?: string) => void) => {
      if (!payload || payload.originId === originId)
        return
      const intent = remoteIntentMap.get(payload.intentId)
      if (!intent) {
        if (!hostPipeline)
          return
        const fallback = hostPipeline.openIntent({ turnId: payload.turnId, intentId: payload.intentId, streamId: payload.streamId })
        remoteIntentMap.set(payload.intentId, fallback)
        writer(fallback, payload.value)
        return
      }
      writer(intent, payload.value)
    }

    busUnsubscribes.push(context.on(speechIntentLiteralEvent, (evt) => {
      const payload = evt?.body
      if (!payload)
        return

      applyToken(payload, (intent, value) => {
        if (value)
          intent.writeLiteral(value)
      })
    }))

    busUnsubscribes.push(context.on(speechIntentSpecialEvent, (evt) => {
      const payload = evt?.body
      if (!payload)
        return

      applyToken(payload, (intent, value) => {
        if (value)
          intent.writeSpecial(value)
      })
    }))

    busUnsubscribes.push(context.on(speechIntentFlushEvent, (evt) => {
      const payload = evt?.body
      if (!payload)
        return

      applyToken(payload, (intent) => {
        intent.writeFlush()
      })
    }))

    busUnsubscribes.push(context.on(speechIntentEndEvent, (evt) => {
      const payload = evt?.body
      if (!payload || payload.originId === originId)
        return
      const intent = remoteIntentMap.get(payload.intentId)
      if (!intent)
        return
      intent.end()
      remoteIntentMap.delete(payload.intentId)
    }))

    busUnsubscribes.push(context.on(speechIntentCancelEvent, (evt) => {
      const payload = evt?.body
      if (!payload || payload.originId === originId)
        return
      const intent = remoteIntentMap.get(payload.intentId)
      if (!intent)
        return
      intent.cancel(payload.reason)
      remoteIntentMap.delete(payload.intentId)
    }))
  }

  function createRemoteIntent(options?: IntentOptions): IntentHandle {
    const intentId = options?.intentId ?? createId('intent')
    const turnId = options?.turnId
    const streamId = options?.streamId ?? createId('stream')
    const priority = typeof options?.priority === 'number' ? options?.priority : undefined
    const behavior = options?.behavior
    const ownerId = options?.ownerId

    const { stream, write, close } = createPushStream<TextToken>()
    let sequence = 0
    let closed = false

    context.emit(speechIntentStartEvent, {
      originId,
      turnId,
      intentId,
      streamId,
      ownerId,
      priority,
      behavior,
    })

    const handle: IntentHandle = {
      intentId,
      turnId,
      streamId,
      ownerId,
      priority: priority ?? 0,
      stream,
      writeLiteral(value: string) {
        if (closed)
          return
        write({ type: 'literal', value, turnId, streamId, intentId, sequence, createdAt: Date.now() })
        context.emit(speechIntentLiteralEvent, {
          originId,
          turnId,
          intentId,
          streamId,
          sequence: sequence++,
          value,
        })
      },
      writeSpecial(value: string) {
        if (closed)
          return
        write({ type: 'special', value, turnId, streamId, intentId, sequence, createdAt: Date.now() })
        context.emit(speechIntentSpecialEvent, {
          originId,
          turnId,
          intentId,
          streamId,
          sequence: sequence++,
          value,
        })
      },
      writeFlush() {
        if (closed)
          return
        write({ type: 'flush', turnId, streamId, intentId, sequence, createdAt: Date.now() })
        context.emit(speechIntentFlushEvent, {
          originId,
          turnId,
          intentId,
          streamId,
          sequence: sequence++,
        })
      },
      end() {
        if (closed)
          return
        closed = true
        close()
        context.emit(speechIntentEndEvent, {
          originId,
          turnId,
          intentId,
          streamId,
        })
      },
      cancel(reason?: string) {
        if (closed)
          return
        closed = true
        close()
        context.emit(speechIntentCancelEvent, {
          originId,
          turnId,
          intentId,
          streamId,
          reason,
        })
      },
    }

    return handle
  }

  async function registerHost(pipeline: ReturnType<typeof createSpeechPipeline<AudioBuffer>>) {
    await mutex.acquire()
    try {
      if (hostPipeline)
        return
      hostPipeline = pipeline
      hostReady = true
      bindSpeechBusToHost()

      hostUnsubscribes.push(
        pipeline.on('onTtsRequest', (request) => {
          const progress = hostedIntentProgress.get(request.intentId)
          if (progress)
            progress.requested += 1
        }),
        pipeline.on('onTtsResult', (result) => {
          const progress = hostedIntentProgress.get(result.intentId)
          if (progress)
            progress.produced += 1
        }),
        pipeline.on('onPlaybackInterrupt', (event) => {
          const progress = hostedIntentProgress.get(event.item.intentId)
          if (progress) {
            progress.result = {
              status: 'interrupted',
              reason: event.reason,
            }
          }
        }),
        pipeline.on('onPlaybackReject', (event) => {
          const progress = hostedIntentProgress.get(event.item.intentId)
          if (progress) {
            progress.result = {
              status: 'failed',
              error: event.reason,
            }
          }
        }),
        pipeline.on('onIntentCancel', (event) => {
          finishHostedIntent(event.intentId, {
            status: 'interrupted',
            reason: event.reason,
          })
        }),
        pipeline.on('onIntentEnd', (intentId) => {
          const progress = hostedIntentProgress.get(intentId)
          if (progress?.result) {
            finishHostedIntent(intentId, progress.result)
            return
          }
          if (progress != null && progress.requested > progress.produced) {
            finishHostedIntent(intentId, {
              status: 'failed',
              error: 'Speech synthesis produced no playable audio',
            })
            return
          }
          finishHostedIntent(intentId, { status: 'completed' })
        }),
      )
    }
    finally {
      mutex.release()
    }
  }

  function openIntent(options?: IntentOptions) {
    const intentId = options?.intentId ?? createId('intent')
    if (hostPipeline) {
      beginHostedIntent(intentId, originId)
      return hostPipeline.openIntent({ ...options, intentId })
    }

    return createRemoteIntent({ ...options, intentId })
  }

  function waitForIntent(intentId: string): Promise<SpeechIntentResult> {
    if (intentWaiters.has(intentId))
      throw new Error(`Speech intent "${intentId}" already has a terminal waiter`)

    return new Promise((resolve) => {
      intentWaiters.set(intentId, resolve)
    })
  }

  function isHost() {
    return hostReady && !!hostPipeline
  }

  async function dispose() {
    await mutex.acquire()
    try {
      hostPipeline = null
      hostReady = false
      remoteIntentMap.clear()
      hostedIntentOrigins.clear()
      hostedIntentProgress.clear()
      for (const unsubscribe of busUnsubscribes.splice(0))
        unsubscribe()
      bound = false
      for (const unsubscribe of hostUnsubscribes.splice(0))
        unsubscribe()
      for (const resolve of intentWaiters.values()) {
        resolve({
          status: 'failed',
          error: 'Speech runtime disposed before playback completed',
        })
      }
      intentWaiters.clear()
      unsubscribeTerminal()
    }
    finally {
      mutex.release()
    }
  }

  return {
    openIntent,
    waitForIntent,
    registerHost,
    isHost,
    dispose,
  }
}
