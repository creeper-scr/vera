import type { GameEnvironmentSnapshot, GameMcpToolDescriptor, VoiceSteerDirective } from '@proj-vera/core-agent'

import { formatCompanionCapabilityCard } from './companionCapabilityCard'
import { buildLayer1PersonaSection } from './companionPersonaContract'

/**
 * How often Layer 1 should refresh system_role from Layer 2/3 reads
 * while a Doubao session is active.
 */
export const GAME_VOICE_SYSTEM_PROMPT_REFRESH_MS = 1_000

/** Bounded history of Layer 2 decision outcomes projected into Layer 1. */
export const GAME_VOICE_ACTION_HISTORY_LIMIT = 5

/** One recorded outcome of a decision-model tool invocation for the voice layer. */
export interface GameVoiceActionHistoryEntry {
  turnText: string
  toolName: string
  status: 'executed' | 'no-action' | 'failed'
  /**
   * Companion-facing detail (args / outcome). Must stay natural-language friendly;
   * never expose dual-model architecture jargon.
   */
  detail?: string
}

function formatVoiceActionHistory(history: readonly GameVoiceActionHistoryEntry[]): string[] {
  if (history.length === 0)
    return []

  const lines = history.map((entry) => {
    const detail = entry.detail?.trim()
    if (entry.status === 'executed') {
      return detail
        ? `- 玩家说「${entry.turnText}」→ 已经去做：${detail}`
        : `- 玩家说「${entry.turnText}」→ 已经执行 ${entry.toolName}`
    }
    if (entry.status === 'no-action')
      return `- 玩家说「${entry.turnText}」→ 这一轮没有游戏动作`
    return detail
      ? `- 玩家说「${entry.turnText}」→ 没做成：${detail}`
      : `- 玩家说「${entry.turnText}」→ ${entry.toolName || '动作'}失败`
  })

  return [
    '最近发生的游戏事实（据此用伙伴口吻说话，不要提系统或模型）：',
    ...lines,
  ]
}

/** Formats the latest hybrid VoiceSteerDirective for Layer 1 UpdateConfig. */
export function formatVoiceSteer(steer: VoiceSteerDirective | null | undefined): string[] {
  if (steer == null)
    return []

  const sections: string[] = []
  if (steer.facts.length > 0) {
    sections.push(
      '已确认事实（下一句必须对齐，不要矛盾）：',
      ...steer.facts.map(fact => `- ${fact}`),
    )
  }
  if (steer.corrections != null && steer.corrections.length > 0) {
    sections.push(
      '需纠正（先改口再谈其他）：',
      ...steer.corrections.map(item => `- ${item}`),
    )
  }
  if (steer.speakHint?.trim()) {
    sections.push(
      '下一句意向（用伙伴口吻覆盖，勿照念系统词）：',
      `- ${steer.speakHint.trim()}`,
    )
  }
  return sections
}

/**
 * Builds Layer 1 chat-only context from the same MCP surfaces Layer 2 uses.
 *
 * Call stack for companion voice refresh:
 *
 * Layer 3 GameAdapter.getEnvironment / getCapabilities
 * -> GameMcpClientPort.readEnvironment / listTools
 * -> {@link createGameVoiceSystemPrompt}
 * -> Doubao updateSystemPrompt
 */
export function createGameVoiceSystemPrompt(
  environment: GameEnvironmentSnapshot,
  tools: readonly GameMcpToolDescriptor[],
  history: readonly GameVoiceActionHistoryEntry[],
  characterPrompt?: string,
  steer?: VoiceSteerDirective | null,
): string {
  const sections = [
    buildLayer1PersonaSection(characterPrompt),
    `当前游戏环境：${JSON.stringify(environment.content)}`,
    ...formatCompanionCapabilityCard(tools),
    ...formatVoiceActionHistory(history),
    ...formatVoiceSteer(steer),
  ]
  return sections.join('\n')
}

/** True when Layer 1 must not trust this snapshot for spoken answers. */
export function isGameVoiceEnvironmentStale(
  environment: GameEnvironmentSnapshot,
  now = Date.now(),
): boolean {
  return environment.freshnessMs < 0
    || now > environment.observedAt + environment.freshnessMs
}

/**
 * Append one decision outcome and enforce {@link GAME_VOICE_ACTION_HISTORY_LIMIT}.
 */
export function rememberGameVoiceAction(
  history: GameVoiceActionHistoryEntry[],
  entry: GameVoiceActionHistoryEntry,
): void {
  history.push(entry)
  if (history.length > GAME_VOICE_ACTION_HISTORY_LIMIT)
    history.splice(0, history.length - GAME_VOICE_ACTION_HISTORY_LIMIT)
}
