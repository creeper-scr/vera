import type {
  CompanionAgentPhase,
  CompanionAgentTurnResult,
  CompanionObservationInput,
  VoiceTurn,
} from '@proj-vera/core-agent'
import type { GameExecutionPort } from '@proj-vera/game-coop-core'
import type { MaybeRefOrGetter } from 'vue'

import type { CompanionSession } from '../services/game-coop/companionSession'
import type { GameVoiceActionHistoryEntry } from '../services/game-coop/gameVoiceSystemPrompt'

import { errorMessageFrom } from '@moeru/std'
import { WebSocketEventSource } from '@proj-vera/server-sdk'
import { isStageTamagotchi } from '@proj-vera/stage-shared'
import { onUnmounted, readonly, ref, shallowRef, toValue, watch } from 'vue'

import { readPlayLlmCredentials } from '../libs/play-env-credentials'
import { createCompanionSession } from '../services/game-coop/companionSession'
import {
  createGameVoiceSystemPrompt,
  isGameVoiceEnvironmentStale,
  rememberGameVoiceAction,
} from '../services/game-coop/gameVoiceSystemPrompt'
import { ServerGameAdapter } from '../services/game-coop/serverGameAdapter'
import { useVeraCardStore } from '../stores/modules'
import { useCompanionAgentModel } from './useCompanionAgentModel'
import { useGameCoopServerChannel } from './useGameCoopServerChannel'

/** Web companion / play env has no Live2D stage to consume control markers. */
const PLAY_NO_STAGE_MARKERS = [
  'This console has no Live2D/stage renderer.',
  'Never emit <|ACT|>, <|DELAY|>, <|CALL|>, <IACT>, or any similar control markers.',
  'Reply with plain natural dialogue only.',
].join(' ')

/**
 * Character prompt for companion decisions; strips stage-marker instructions in play env.
 */
function resolveCompanionCharacterPrompt(base: string): string {
  if (!readPlayLlmCredentials())
    return base
  return `${base}\n\n${PLAY_NO_STAGE_MARKERS}`
}

export interface UseCompanionSessionOptions {
  /**
   * Logical session id used for VoiceTurn + MCP correlation.
   * Prefer the connection manager sessionId once connected.
   */
  sessionId: MaybeRefOrGetter<string>
  /**
   * Remote adapter id for the server-channel GameExecutionPort.
   * @default 'minecraft'
   */
  adapterId?: MaybeRefOrGetter<string>
  /**
   * Server route selector for lifecycle events returning to this Stage host.
   * Defaults to StageWeb, or StageTamagotchi when running in the desktop shell.
   */
  replyTo?: MaybeRefOrGetter<string>
  onTurnResult?: (result: CompanionAgentTurnResult, turn: VoiceTurn) => void
  onObservationResult?: (
    result: CompanionAgentTurnResult | null,
    observation: CompanionObservationInput,
  ) => void
}

/**
 * Stage-owned companion product path:
 * VoiceTurn / observation → createCompanionSession → generic Game MCP → ServerGameAdapter.
 *
 * Layer 1 voice context is built from the same MCP environment/tools Layer 2
 * reads, plus recent Layer 2 decision outcomes. No parallel observation bus.
 */
export function useCompanionSession(options: UseCompanionSessionOptions) {
  const veraCard = useVeraCardStore()
  const model = useCompanionAgentModel()

  const phase = ref<CompanionAgentPhase>('idle')
  const lastResult = ref<CompanionAgentTurnResult | null>(null)
  const lastAssistantText = ref('')
  const lastError = ref<string | null>(null)
  const toolNames = ref<string[]>([])
  const worldActive = ref(false)
  const actionHistory: GameVoiceActionHistoryEntry[] = []
  const contextControllers = new Set<AbortController>()

  const channel = useGameCoopServerChannel()

  function resolveReplyTo(): string {
    return toValue(options.replyTo)
      ?? (isStageTamagotchi()
        ? WebSocketEventSource.StageTamagotchi
        : WebSocketEventSource.StageWeb)
  }

  function createExecutionPort(adapterId: string): GameExecutionPort {
    return new ServerGameAdapter({
      channel,
      adapterId,
      destination: `module:${adapterId}-bot`,
      replyTo: resolveReplyTo(),
      unavailableAsEmpty: true,
    })
  }

  const currentAdapterId = () => toValue(options.adapterId) ?? 'minecraft'
  const executionPort = shallowRef<GameExecutionPort>(createExecutionPort(currentAdapterId()))
  let session: CompanionSession = createSession(toValue(options.sessionId), executionPort.value)

  /**
   * Records Layer 2 decisions for Layer 1 voice prompt context.
   */
  function rememberDecision(result: CompanionAgentTurnResult, turn: VoiceTurn) {
    // Synthetic observation turns are Layer 2 policy inputs, not player speech.
    if (turn.metadata.source === 'game-observation')
      return

    const toolSteps = result.toolSteps ?? []
    const names = result.toolNames ?? []

    if (result.status === 'completed' && toolSteps.length > 0) {
      const failed = toolSteps.some(step => !step.ok)
      rememberGameVoiceAction(actionHistory, {
        turnText: turn.text,
        toolName: names.join(', '),
        status: failed ? 'failed' : 'executed',
        detail: toolSteps.map(formatToolStepDetail).join('；'),
      })
      return
    }
    if (result.status === 'completed') {
      rememberGameVoiceAction(actionHistory, {
        turnText: turn.text,
        toolName: '',
        status: 'no-action',
      })
      return
    }
    if (result.status === 'failed') {
      rememberGameVoiceAction(actionHistory, {
        turnText: turn.text,
        toolName: names[0] ?? '',
        status: 'failed',
        detail: result.reason,
      })
    }
  }

  /**
   * Formats one tool step into companion-facing history detail.
   */
  function formatToolStepDetail(step: CompanionAgentTurnResult['toolSteps'][number]): string {
    const args = Object.keys(step.arguments).length > 0
      ? `(${Object.entries(step.arguments).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')})`
      : ''
    if (step.ok)
      return `${step.name}${args}`
    return `${step.name}${args}：${step.error ?? '失败'}`
  }

  /**
   * Builds a CompanionSession bound to the active execution port.
   */
  function createSession(sessionId: string, port: GameExecutionPort): CompanionSession {
    return createCompanionSession({
      executionPort: port,
      sessionId,
      getSystemPrompt: () => resolveCompanionCharacterPrompt(veraCard.systemPrompt),
      maxSteps: 6,
      // Cooperative Minecraft tools (collect/craft/attack/chest) are `medium`.
      // Keep `high` closed until GamePermissionPolicy / UI confirmation exists.
      allowedRisks: ['low', 'medium'],
      model,
      onTurnResult(result, turn) {
        lastResult.value = result
        toolNames.value = result.toolNames ?? []
        if (result.assistantText)
          lastAssistantText.value = result.assistantText
        rememberDecision(result, turn)
        options.onTurnResult?.(result, turn)
      },
      onObservationResult(result, observation) {
        if (result) {
          lastResult.value = result
          toolNames.value = result.toolNames ?? []
          if (result.assistantText)
            lastAssistantText.value = result.assistantText
        }
        options.onObservationResult?.(result, observation)
      },
      onPhaseChange(next) {
        phase.value = next
      },
    })
  }

  /**
   * Replaces the live session when sessionId or adapterId changes.
   */
  async function replaceSession(sessionId: string, adapterId: string) {
    const shouldObserve = worldActive.value
    const previous = session
    const nextExecutionPort = createExecutionPort(adapterId)
    executionPort.value = nextExecutionPort
    session = createSession(sessionId, nextExecutionPort)
    await previous.dispose()
    if (shouldObserve)
      session.startWorldObservations()
  }

  watch(
    [() => toValue(options.sessionId), currentAdapterId],
    ([nextSessionId, nextAdapterId], [previousSessionId, previousAdapterId]) => {
      if (
        !nextSessionId
        || (nextSessionId === previousSessionId && nextAdapterId === previousAdapterId)
      ) {
        return
      }
      void replaceSession(nextSessionId, nextAdapterId)
    },
  )

  /**
   * Ingests a finalized voice/text turn into Layer 2.
   */
  async function ingestVoiceTurn(turn: VoiceTurn) {
    lastError.value = null
    phase.value = 'thinking'
    try {
      return await session.ingestVoiceTurn(turn)
    }
    catch (error) {
      lastError.value = errorMessageFrom(error) ?? 'Companion turn failed'
      throw error
    }
    finally {
      phase.value = session.getPhase()
    }
  }

  /**
   * Ingests a world observation into Layer 2.
   */
  async function ingestObservation(observation: CompanionObservationInput) {
    lastError.value = null
    try {
      return await session.ingestObservation(observation)
    }
    catch (error) {
      lastError.value = errorMessageFrom(error) ?? 'Companion observation failed'
      throw error
    }
    finally {
      phase.value = session.getPhase()
    }
  }

  /**
   * Cancels the in-flight turn for the active session.
   */
  async function cancelTurn(turnId: string, reason?: string) {
    const outcomes = await session.cancel({
      sessionId: toValue(options.sessionId),
      turnId,
      scope: 'turn',
      reason,
    })
    phase.value = session.getPhase()
    return outcomes
  }

  /**
   * Starts remote world observation streaming for the active session.
   */
  function startWorldObservations() {
    worldActive.value = true
    session.startWorldObservations()
  }

  /**
   * Stops remote world observation streaming.
   */
  function stopWorldObservations() {
    worldActive.value = false
    session.stopWorldObservations()
  }

  /**
   * Layer 1 prompt: same MCP environment/tools Layer 2 uses + recent L2 outcomes.
   */
  async function getSystemPrompt() {
    const controller = new AbortController()
    contextControllers.add(controller)
    try {
      const [environment, tools] = await Promise.all([
        session.readEnvironment(controller.signal),
        session.listTools(controller.signal),
      ])
      if (isGameVoiceEnvironmentStale(environment)) {
        return '当前游戏环境快照已过期。明确说明暂时无法确认位置或状态，不要编造。'
      }
      return createGameVoiceSystemPrompt(
        environment,
        tools,
        [...actionHistory],
        resolveCompanionCharacterPrompt(veraCard.systemPrompt),
      )
    }
    catch {
      return '当前无法读取游戏环境。明确说明暂时无法确认位置或状态，不要编造。'
    }
    finally {
      contextControllers.delete(controller)
    }
  }

  /**
   * Tears down the companion session and pending prompt reads.
   */
  async function dispose() {
    worldActive.value = false
    for (const controller of contextControllers)
      controller.abort()
    contextControllers.clear()
    actionHistory.length = 0
    await session.dispose()
  }

  onUnmounted(() => {
    void dispose()
  })

  return {
    phase,
    lastResult,
    lastAssistantText,
    lastError,
    toolNames,
    executionPort: readonly(executionPort),
    ingestVoiceTurn,
    ingestObservation,
    cancelTurn,
    startWorldObservations,
    stopWorldObservations,
    getSystemPrompt,
    dispose,
    getPhase: () => session.getPhase(),
  }
}
