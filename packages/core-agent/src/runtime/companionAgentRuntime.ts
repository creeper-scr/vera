import type { Message, Tool, ToolExecuteResult } from '@xsai/shared-chat'

import type {
  CompanionCancelOutcome,
  CompanionCancelRequest,
  CompanionInterruptPort,
} from '../contracts/companionCancel'
import type {
  GameEnvironmentSnapshot,
  GameMcpClientPort,
  GameMcpToolCallResult,
  GameMcpToolDescriptor,
} from '../contracts/gameMcpPort'
import type { VoiceTurn } from '../contracts/voiceTurn'

import { errorMessageFrom } from '@moeru/std'

const MAX_REMEMBERED_TURNS = 1024
const MAX_CONVERSATION_MESSAGES = 40
const DEFAULT_MAX_STEPS = 6

/** Agent phase projected to UI. */
export type CompanionAgentPhase
  = | 'idle'
    | 'listening'
    | 'thinking'
    | 'speaking'
    | 'acting'

export interface CompanionObservationInput {
  sessionId: string
  eventId: string
  kind: string
  urgency: 'low' | 'normal' | 'high' | 'critical'
  text: string
  observedAt: number
  data?: Record<string, unknown>
  dedupeKey?: string
}

/** One MCP tool step observed during a companion turn, for voice/context projection. */
export interface CompanionAgentToolStep {
  name: string
  arguments: Record<string, unknown>
  ok: boolean
  error?: string
}

export interface CompanionAgentTurnResult {
  status: 'completed' | 'cancelled' | 'ignored' | 'failed'
  reason?: string
  steps: number
  toolNames: string[]
  /** Per-tool outcomes for Layer 1 history; empty when no tools ran. */
  toolSteps: CompanionAgentToolStep[]
  assistantText?: string
}

export interface CompanionAgentModelRequest {
  messages: Message[]
  tools: Tool[]
  /** Maximum native model/tool rounds for this turn. */
  maxSteps: number
  abortSignal: AbortSignal
}

/**
 * Exclusive model boundary for companion dialogue + tool loop.
 *
 * Implementations stream assistant text and may invoke provided tools.
 * They must honor abortSignal.
 */
export interface CompanionAgentModelPort {
  stream: (request: CompanionAgentModelRequest) => Promise<{ assistantText?: string }>
}

export interface CompanionAgentRuntime {
  ingestVoiceTurn: (turn: VoiceTurn) => Promise<CompanionAgentTurnResult>
  ingestObservation: (observation: CompanionObservationInput) => Promise<CompanionAgentTurnResult | null>
  /**
   * Records Layer 1 spoken dialogue into conversation history so Layer 2
   * stays aligned with what the player already heard.
   */
  rememberExternalAssistant: (sessionId: string, text: string) => void
  cancel: CompanionInterruptPort['cancel']
  getPhase: () => CompanionAgentPhase
  dispose: () => void
}

export interface CompanionAgentRuntimeDeps {
  mcp: GameMcpClientPort
  model: CompanionAgentModelPort
  /** Returns current character prompt; read per turn so card changes need no runtime restart. */
  getSystemPrompt?: () => string
  /**
   * Max game tool executions per user turn. The model receives one additional
   * native round so it can answer after the final tool result.
   * @default 6
   */
  maxSteps?: number
  now?: () => number
  /**
   * Optional proactive policy. Return false to drop an observation without inference.
   */
  shouldReactToObservation?: (observation: CompanionObservationInput) => boolean
}

interface CompanionConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Single-brain companion policy: dialogue, continuous MCP tool loop, proactive
 * observation reactions, and cancel ownership for inference/tool scopes.
 *
 * Platform wiring (Vue/Pinia/Electron) stays outside this module.
 *
 * Replaces single-step {@link createGameActionRuntime} for the companion product
 * path. The old runtime remains for existing Stage demos until Wave 4 removal.
 */
export function createCompanionAgentRuntime(deps: CompanionAgentRuntimeDeps): CompanionAgentRuntime {
  const now = deps.now ?? Date.now
  const maxToolCalls = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const seenTurnKeys = new Set<string>()
  const seenObservationKeys = new Set<string>()
  const conversationHistoryBySession = new Map<string, CompanionConversationMessage[]>()
  /** Layer 1 utterances that arrived before the matching user turn was remembered. */
  const pendingSpokenBySession = new Map<string, string[]>()
  const activeControllers = new Map<string, AbortController>()
  const sessionTails = new Map<string, Promise<void>>()
  let phase: CompanionAgentPhase = 'idle'
  let disposed = false

  function getPhase() {
    return phase
  }

  function rememberKey(set: Set<string>, key: string) {
    set.add(key)
    if (set.size <= MAX_REMEMBERED_TURNS)
      return
    const oldest = set.values().next().value
    if (oldest != null)
      set.delete(oldest)
  }

  function enqueue(sessionId: string, task: () => Promise<CompanionAgentTurnResult>): Promise<CompanionAgentTurnResult> {
    const previous = sessionTails.get(sessionId) ?? Promise.resolve()
    const run = previous
      .catch(() => {})
      .then(task)
    const tail = run.then(() => {}, () => {})
    sessionTails.set(sessionId, tail)
    void tail.finally(() => {
      if (sessionTails.get(sessionId) === tail)
        sessionTails.delete(sessionId)
    })
    return run
  }

  async function processVoiceTurn(turn: VoiceTurn): Promise<CompanionAgentTurnResult> {
    if (disposed)
      return { status: 'ignored', reason: 'disposed', steps: 0, toolNames: [], toolSteps: [] }

    const turnKey = `${turn.sessionId}\0${turn.turnId}`
    if (seenTurnKeys.has(turnKey))
      return { status: 'ignored', reason: 'duplicate', steps: 0, toolNames: [], toolSteps: [] }
    rememberKey(seenTurnKeys, turnKey)

    const controller = new AbortController()
    activeControllers.set(turnKey, controller)
    phase = 'thinking'
    const toolNames: string[] = []
    const toolSteps: CompanionAgentToolStep[] = []
    let steps = 0
    let assistantText: string | undefined
    const conversationHistory = conversationHistoryBySession.get(turn.sessionId) ?? []

    try {
      const descriptors = await deps.mcp.listTools(turn.sessionId, controller.signal)

      // No Adapter capability means dialogue-only. Do not ask the unavailable
      // game transport for environment state merely to let conversation proceed.
      if (descriptors.length === 0) {
        const modelResult = await deps.model.stream({
          messages: createCompanionMessages(turn, undefined, conversationHistory, deps.getSystemPrompt?.()),
          tools: [],
          maxSteps: 1,
          abortSignal: controller.signal,
        })
        assistantText = modelResult.assistantText
        phase = assistantText ? 'speaking' : 'idle'
        return { status: 'completed', steps, toolNames, toolSteps, assistantText }
      }

      const environment = await deps.mcp.readEnvironment(turn.sessionId, controller.signal)
      if (!environmentIsFresh(environment, turn.sessionId, now()))
        return { status: 'ignored', reason: 'stale-environment', steps: 0, toolNames: [], toolSteps: [] }

      const tools = descriptors.map(descriptor => createTool(
        descriptor,
        turn,
        controller.signal,
        async (name, toolCallId, input) => {
          if (steps >= maxToolCalls)
            throw new Error(`Companion tool call limit of ${maxToolCalls} reached`)

          phase = 'acting'
          steps += 1
          toolNames.push(name)
          const result = await deps.mcp.callTool({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            toolCallId,
            name,
            arguments: input,
            abortSignal: controller.signal,
            waitForTerminal: descriptor.waitForTerminal ?? true,
          })
          const normalized = normalizeToolResult(result)
          toolSteps.push(toolStepFromResult(name, input, normalized))
          return normalized
        },
      ))

      phase = 'thinking'
      const modelResult = await deps.model.stream({
        messages: createCompanionMessages(turn, environment, conversationHistory, deps.getSystemPrompt?.()),
        tools,
        maxSteps: maxToolCalls + 1,
        abortSignal: controller.signal,
      })
      assistantText = modelResult.assistantText
      phase = 'idle'
      return {
        status: 'completed',
        steps,
        toolNames,
        toolSteps,
        assistantText,
      }
    }
    catch (error) {
      if (controller.signal.aborted) {
        phase = 'idle'
        return { status: 'cancelled', reason: 'aborted', steps, toolNames, toolSteps, assistantText }
      }
      phase = 'idle'
      return {
        status: 'failed',
        reason: errorMessageFrom(error) ?? 'Companion agent turn failed',
        steps,
        toolNames,
        toolSteps,
        assistantText,
      }
    }
    finally {
      activeControllers.delete(turnKey)
      phase = 'idle'
    }
  }

  function ingestVoiceTurn(turn: VoiceTurn): Promise<CompanionAgentTurnResult> {
    if (disposed)
      return Promise.resolve({ status: 'ignored', reason: 'disposed', steps: 0, toolNames: [], toolSteps: [] })
    return enqueue(turn.sessionId, async () => {
      const result = await processVoiceTurn(turn)
      if (result.status === 'completed')
        rememberConversation(turn, result.assistantText)
      return result
    })
  }

  function trimConversation(history: CompanionConversationMessage[]) {
    if (history.length > MAX_CONVERSATION_MESSAGES)
      history.splice(0, history.length - MAX_CONVERSATION_MESSAGES)
  }

  function takePendingSpoken(sessionId: string): string | undefined {
    const pending = pendingSpokenBySession.get(sessionId)
    if (pending == null || pending.length === 0)
      return undefined
    const spoken = pending.shift()
    if (pending.length === 0)
      pendingSpokenBySession.delete(sessionId)
    return spoken
  }

  function rememberConversation(turn: VoiceTurn, assistantText?: string) {
    const history = conversationHistoryBySession.get(turn.sessionId) ?? []
    history.push({ role: 'user', content: turn.text })
    const pendingSpoken = takePendingSpoken(turn.sessionId)
    // Doubao owns audible dialogue; prefer Layer 1 speech over Layer 2 draft text.
    if (turn.metadata.source === 'doubao-realtime') {
      if (pendingSpoken)
        history.push({ role: 'assistant', content: pendingSpoken })
    }
    else if (assistantText?.trim()) {
      history.push({ role: 'assistant', content: assistantText.trim() })
    }
    else if (pendingSpoken) {
      history.push({ role: 'assistant', content: pendingSpoken })
    }
    trimConversation(history)
    conversationHistoryBySession.set(turn.sessionId, history)
  }

  /**
   * Mirrors Layer 1 spoken text into Layer 2 history (hybrid alignment).
   */
  function rememberExternalAssistant(sessionId: string, text: string) {
    if (disposed)
      return
    const trimmed = text.trim()
    if (!trimmed)
      return

    const history = conversationHistoryBySession.get(sessionId) ?? []
    const last = history[history.length - 1]
    if (last?.role === 'user') {
      history.push({ role: 'assistant', content: trimmed })
      trimConversation(history)
      conversationHistoryBySession.set(sessionId, history)
      return
    }

    const pending = pendingSpokenBySession.get(sessionId) ?? []
    pending.push(trimmed)
    pendingSpokenBySession.set(sessionId, pending)
  }

  async function processObservation(
    observation: CompanionObservationInput,
  ): Promise<CompanionAgentTurnResult | null> {
    if (disposed)
      return { status: 'ignored', reason: 'disposed', steps: 0, toolNames: [], toolSteps: [] }

    const dedupe = observation.dedupeKey ?? observation.eventId
    const key = `${observation.sessionId}\0${dedupe}`
    if (seenObservationKeys.has(key))
      return null
    rememberKey(seenObservationKeys, key)

    if (deps.shouldReactToObservation && !deps.shouldReactToObservation(observation))
      return null

    // Map observation into a synthetic VoiceTurn so the same loop owns dialogue.
    const turn: VoiceTurn = {
      sessionId: observation.sessionId,
      turnId: `obs:${observation.eventId}`,
      text: `[game-observation kind=${observation.kind} urgency=${observation.urgency}] ${observation.text}`,
      createdAt: observation.observedAt,
      metadata: {
        source: 'game-observation',
        eventId: observation.eventId,
      },
    }
    return processVoiceTurn(turn)
  }

  function ingestObservation(
    observation: CompanionObservationInput,
  ): Promise<CompanionAgentTurnResult | null> {
    if (disposed)
      return Promise.resolve({ status: 'ignored', reason: 'disposed', steps: 0, toolNames: [], toolSteps: [] })
    return enqueue(observation.sessionId, async () => {
      const result = await processObservation(observation)
      return result ?? { status: 'ignored', reason: 'filtered', steps: 0, toolNames: [], toolSteps: [] }
    }).then((result) => {
      if (result.reason === 'filtered')
        return null
      return result
    })
  }

  async function cancel(request: CompanionCancelRequest): Promise<CompanionCancelOutcome[]> {
    const outcomes: CompanionCancelOutcome[] = []
    if (request.scope === 'speech') {
      outcomes.push({ status: 'missing', scope: 'speech' })
      return outcomes
    }

    const controller = activeControllers.get(`${request.sessionId}\0${request.turnId}`)
    if (controller == null) {
      outcomes.push({ status: 'already-terminal', scope: request.scope })
      return outcomes
    }

    if (request.scope === 'inference' || request.scope === 'tool' || request.scope === 'turn' || request.scope === 'game-action') {
      controller.abort()
      outcomes.push({ status: 'cancelled', scope: request.scope })
    }
    return outcomes
  }

  function dispose() {
    if (disposed)
      return
    disposed = true
    for (const controller of activeControllers.values())
      controller.abort()
    activeControllers.clear()
    seenTurnKeys.clear()
    seenObservationKeys.clear()
    conversationHistoryBySession.clear()
    pendingSpokenBySession.clear()
    phase = 'idle'
  }

  return {
    ingestVoiceTurn,
    ingestObservation,
    rememberExternalAssistant,
    cancel,
    getPhase,
    dispose,
  }
}

function environmentIsFresh(
  environment: GameEnvironmentSnapshot,
  sessionId: string,
  currentTime: number,
) {
  return environment.sessionId === sessionId
    && environment.freshnessMs >= 0
    && currentTime <= environment.observedAt + environment.freshnessMs
}

function createCompanionMessages(
  turn: VoiceTurn,
  environment: GameEnvironmentSnapshot | undefined,
  conversationHistory: ReadonlyArray<CompanionConversationMessage>,
  characterPrompt?: string,
): Message[] {
  return [
    {
      role: 'system',
      content: [
        characterPrompt?.trim() || '你是游戏陪玩伙伴。',
        turn.metadata.source === 'doubao-realtime'
          ? '当前输入来自本地语音。“我”或“主人”指本地操作者：优先使用环境中的明确主人身份；若未配置且只有一个非自身在线玩家，可使用该玩家；存在歧义时再询问。'
          : undefined,
      ].filter(Boolean).join('\n\n'),
    },
    ...conversationHistory,
    {
      role: 'user',
      content: [
        `玩家：${turn.text}`,
        environment == null
          ? '当前没有可用游戏能力；仅进行自然对话，不要声称执行了游戏操作。'
          : `当前游戏环境：${JSON.stringify(environment.content)}\n环境修订：${environment.revision ?? 'unknown'}`,
      ].join('\n'),
    },
  ]
}

function toolStepFromResult(
  name: string,
  input: Record<string, unknown>,
  normalized: ToolExecuteResult,
): CompanionAgentToolStep {
  if (isRecord(normalized) && typeof normalized.error === 'string') {
    return {
      name,
      arguments: input,
      ok: false,
      error: normalized.error,
    }
  }
  return { name, arguments: input, ok: true }
}

function createTool(
  descriptor: GameMcpToolDescriptor,
  turn: VoiceTurn,
  abortSignal: AbortSignal,
  execute: (name: string, toolCallId: string, input: Record<string, unknown>) => Promise<ToolExecuteResult>,
): Tool {
  return {
    type: 'function',
    function: {
      name: descriptor.name,
      description: describeTool(descriptor),
      parameters: descriptor.inputSchema,
    },
    async execute(input, options) {
      abortSignal.throwIfAborted()
      if (!isRecord(input))
        throw new TypeError(`Game tool "${descriptor.name}" requires object arguments for turn ${turn.turnId}`)
      return execute(descriptor.name, options.toolCallId, input)
    },
  }
}

function describeTool(descriptor: GameMcpToolDescriptor): string | undefined {
  const parts = [descriptor.description]
  if (descriptor.risk)
    parts.push(`risk=${descriptor.risk}`)
  if (descriptor.cancellable != null)
    parts.push(`cancellable=${descriptor.cancellable}`)
  return parts.filter(Boolean).join(' | ') || undefined
}

function normalizeToolResult(result: unknown): ToolExecuteResult {
  if (isGameMcpToolCallResult(result)) {
    if (result.status === 'terminal') {
      if (result.state === 'failed')
        return { error: result.error ?? 'tool failed', state: result.state, actionId: result.actionId }
      if (result.state === 'cancelled')
        return { cancelled: true, reason: result.reason, actionId: result.actionId }
      return { ok: true, state: result.state, actionId: result.actionId, result: result.result ?? null }
    }
    return { accepted: true, state: result.state, actionId: result.actionId }
  }
  if (typeof result === 'string' || Array.isArray(result))
    return result
  if (isRecord(result))
    return result
  return { value: result }
}

function isGameMcpToolCallResult(value: unknown): value is GameMcpToolCallResult {
  if (!isRecord(value) || typeof value.status !== 'string' || typeof value.actionId !== 'string')
    return false
  return value.status === 'accepted' || value.status === 'terminal'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
