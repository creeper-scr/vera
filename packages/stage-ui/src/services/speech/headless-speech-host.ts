import type {
  CompanionCancelOutcome,
  CompanionCancelRequest,
  CompanionInterruptPort,
  SpeechPlaybackResult,
  SpeechPlaybackTerminal,
} from '@proj-vera/core-agent'
import type { IntentHandle, IntentOptions } from '@proj-vera/pipelines-audio'

import type { SpeechIntentResult, SpeechPipelineRuntime } from './pipeline-runtime'

import { createSpeechPipelineRuntime } from './pipeline-runtime'

export interface HeadlessSpeechHostDeps {
  /**
   * Optional prebuilt runtime. Defaults to a fresh {@link createSpeechPipelineRuntime}.
   * Tests inject a stub; Stage/companion inject the shared Pinia-backed runtime when needed.
   */
  runtime?: SpeechPipelineRuntime
}

export interface HeadlessSpeechSpeakOptions {
  sessionId: string
  turnId: string
  text: string
  intentId?: string
  ownerId?: string
  priority?: IntentOptions['priority']
  behavior?: IntentOptions['behavior']
}

/**
 * Speech host that owns openIntent / waitForIntent correlation without Stage.vue.
 *
 * Stage may still register the real TTS pipeline as host (visual consumer). This
 * module tracks active intents so companion barge-in can cancel by turnId and map
 * terminals to {@link SpeechPlaybackResult}.
 */
export interface HeadlessSpeechHost extends CompanionInterruptPort {
  openIntent: (options?: IntentOptions) => IntentHandle
  waitForIntent: (intentId: string) => Promise<SpeechIntentResult>
  /**
   * Open a one-shot literal intent, wait for terminal, map to SpeechPlaybackResult.
   */
  speakText: (options: HeadlessSpeechSpeakOptions) => Promise<SpeechPlaybackResult>
  registerHost: SpeechPipelineRuntime['registerHost']
  isHost: () => boolean
  /**
   * Active speech intents currently tracked for cancel (test/diagnostic surface).
   */
  listActiveIntents: () => Array<{ intentId: string, turnId?: string, sessionId?: string }>
  dispose: () => Promise<void>
}

interface TrackedIntent {
  intentId: string
  turnId?: string
  sessionId?: string
  handle: IntentHandle
}

function mapTerminal(result: SpeechIntentResult): {
  terminal: SpeechPlaybackTerminal
  reason?: string
} {
  if (result.status === 'completed')
    return { terminal: 'completed' }
  if (result.status === 'interrupted')
    return { terminal: 'interrupted', reason: result.reason }
  return { terminal: 'failed', reason: result.error }
}

/**
 * Create a headless speech host.
 *
 * Does not construct Web Audio or TTS providers — callers that need local
 * playback still `registerHost(createSpeechPipeline(...))`. Without a host,
 * openIntent still emits on the speech bus for a remote Stage host.
 */
export function createHeadlessSpeechHost(
  deps: HeadlessSpeechHostDeps = {},
): HeadlessSpeechHost {
  const runtime = deps.runtime ?? createSpeechPipelineRuntime()
  const active = new Map<string, TrackedIntent>()
  let disposed = false

  function track(handle: IntentHandle, sessionId?: string) {
    active.set(handle.intentId, {
      intentId: handle.intentId,
      turnId: handle.turnId,
      sessionId,
      handle,
    })
  }

  function untrack(intentId: string) {
    active.delete(intentId)
  }

  function openIntent(options?: IntentOptions) {
    if (disposed)
      throw new Error('Headless speech host disposed')
    const handle = runtime.openIntent(options)
    track(handle)
    return handle
  }

  async function waitForIntent(intentId: string): Promise<SpeechIntentResult> {
    try {
      return await runtime.waitForIntent(intentId)
    }
    finally {
      untrack(intentId)
    }
  }

  async function speakText(options: HeadlessSpeechSpeakOptions): Promise<SpeechPlaybackResult> {
    const handle = openIntent({
      turnId: options.turnId,
      intentId: options.intentId,
      ownerId: options.ownerId,
      priority: options.priority,
      behavior: options.behavior ?? 'queue',
    })

    const tracked = active.get(handle.intentId)
    if (tracked)
      tracked.sessionId = options.sessionId

    const finished = waitForIntent(handle.intentId)
    if (options.text)
      handle.writeLiteral(options.text)
    handle.writeFlush()
    handle.end()

    const result = await finished
    const mapped = mapTerminal(result)
    return {
      sessionId: options.sessionId,
      turnId: options.turnId,
      intentId: handle.intentId,
      terminal: mapped.terminal,
      reason: mapped.reason,
    }
  }

  async function cancel(request: CompanionCancelRequest): Promise<CompanionCancelOutcome[]> {
    if (disposed)
      return [{ status: 'missing', scope: request.scope }]

    if (request.scope !== 'speech')
      return [{ status: 'missing', scope: request.scope }]

    const matches = [...active.values()].filter((item) => {
      if (item.turnId !== request.turnId)
        return false
      if (item.sessionId != null && item.sessionId !== request.sessionId)
        return false
      return true
    })

    if (matches.length === 0)
      return [{ status: 'already-terminal', scope: 'speech' }]

    for (const item of matches) {
      item.handle.cancel(request.reason ?? 'cancel')
      // Keep tracked until waitForIntent settles so terminal mapping still works.
    }

    return [{ status: 'cancelled', scope: 'speech' }]
  }

  function listActiveIntents() {
    return [...active.values()].map(({ intentId, turnId, sessionId }) => ({
      intentId,
      turnId,
      sessionId,
    }))
  }

  async function dispose() {
    if (disposed)
      return
    disposed = true
    for (const item of active.values())
      item.handle.cancel('dispose')
    active.clear()
    await runtime.dispose()
  }

  return {
    openIntent,
    waitForIntent,
    speakText,
    registerHost: pipeline => runtime.registerHost(pipeline),
    isHost: () => runtime.isHost(),
    cancel,
    listActiveIntents,
    dispose,
  }
}
