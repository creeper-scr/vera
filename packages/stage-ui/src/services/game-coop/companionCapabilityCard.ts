import type { GameMcpToolDescriptor } from '@proj-vera/core-agent'

/**
 * Player-facing capability labels for Layer 1.
 * Keys match MCP tool names (`minecraft.follow` → `minecraft_follow`) or bare verbs.
 */
const CAPABILITY_LABELS: Record<string, string> = {
  follow: '跟着玩家走',
  come: '走到玩家身边',
  stop: '停下当前动作',
  move: '走到指定坐标',
  collect: '采集方块或砍树',
  look: '看向玩家或坐标',
  craft: '合成物品或查看配方',
  smelt: '用熔炉烧东西',
  clear_furnace: '从熔炉取出物品',
  interact: '激活附近物体',
  say: '在游戏聊天里说话',
  give: '把物品交给玩家',
  equip: '装备工具、武器或护甲',
  eat: '吃东西或喝东西',
  sleep: '找床睡觉',
  place: '放置方块或火把',
  attack: '攻击附近生物',
  chest: '查看或存取箱子',
  discard: '扔掉背包里的物品',
  status: '查看自身状态',
  mine_at: '挖掉指定坐标的方块',
  goto_block: '走到某类方块旁边',
  goto_entity: '走到某类生物旁边',
  move_away: '往远处挪开',
  dig_down: '往脚下挖',
  goto_surface: '回到地表',
  farm: '耕地并可选播种',
  waypoint: '记住或前往地标',
}

/**
 * Resolves a short Chinese capability label for one MCP tool.
 * Prefers known maps; falls back to description, then a softened tool name.
 */
export function describeCompanionCapability(tool: Pick<GameMcpToolDescriptor, 'name' | 'description'>): string {
  const verb = capabilityVerb(tool.name)
  const mapped = CAPABILITY_LABELS[verb] ?? CAPABILITY_LABELS[tool.name]
  if (mapped)
    return mapped

  const description = tool.description?.trim()
  if (description)
    return softenEnglishDescription(description)

  return verb.replaceAll('_', ' ')
}

/**
 * Builds Layer 1 capability card: what the companion can do in-game.
 * Voice model must acknowledge intents for listed abilities; it does not call tools.
 */
export function formatCompanionCapabilityCard(tools: readonly GameMcpToolDescriptor[]): string[] {
  if (tools.length === 0) {
    return [
      '当前没有可用的游戏行动能力。可以闲聊，但不要承诺游戏动作，也不要说自己去执行。',
    ]
  }

  const lines = tools.map(tool => `- ${describeCompanionCapability(tool)}`)
  return [
    '你在游戏里现在能做的事（行动由队友侧执行；你只负责自然接话，不要念工具名）：',
    ...lines,
    '清单里有的能力：玩家一提就先答应去做，禁止说做不到、不会、没这个功能、我只是语音之类的推脱。',
    '清单里没有的能力：诚实说明暂时做不了，不要编造已经在做。',
  ]
}

/** Last path segment of `minecraft_follow` / `minecraft.follow` → `follow`. */
export function capabilityVerb(toolName: string): string {
  const normalized = toolName.trim().replaceAll('.', '_')
  const parts = normalized.split('_').filter(Boolean)
  if (parts.length <= 1)
    return normalized.toLowerCase()
  // minecraft_plan_craft → plan_craft; minecraft_follow → follow
  return parts.slice(1).join('_').toLowerCase()
}

function softenEnglishDescription(description: string): string {
  // Keep first sentence; voice layer should not speak raw English tool docs if avoidable.
  const first = description.split(/[.。]/)[0]?.trim() || description.trim()
  return first
}
