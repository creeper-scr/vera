import type {
  GameCapability,
  JsonValue,
} from '@proj-vera/game-coop-core'

import type {
  DescribeGameActionInput,
  GameIntentPolicy,
  GameIntentResolution,
  ResolveGameIntentInput,
} from './agent'

const capabilityIds = {
  status: 'minecraft.status',
  follow: 'minecraft.follow',
  stop: 'minecraft.stop',
} as const

/**
 * Deterministic first-slice intent policy for Minecraft voice commands.
 *
 * ponytail: Rules cover status/follow/stop only. Replace this Integration
 * policy with catalog-aware model selection when free-form game commands land;
 * Core and adapters remain unchanged.
 */
export class MinecraftIntentPolicy implements GameIntentPolicy {
  public async resolve(input: ResolveGameIntentInput): Promise<GameIntentResolution | null> {
    const text = input.turn.text?.trim()
    if (text == null || text.length === 0)
      return null

    if (matchesStop(text) && hasCapability(input.capabilities, capabilityIds.stop)) {
      return {
        capabilityId: capabilityIds.stop,
        input: {},
      }
    }

    const follow = followInput(text)
    if (follow != null && hasCapability(input.capabilities, capabilityIds.follow)) {
      return {
        capabilityId: capabilityIds.follow,
        input: follow,
      }
    }

    if (matchesStatus(text) && hasCapability(input.capabilities, capabilityIds.status)) {
      return {
        capabilityId: capabilityIds.status,
        input: {},
      }
    }

    return null
  }

  public describeAction({ turn, command, event }: DescribeGameActionInput): string | null {
    const chinese = containsCjk(turn.text)

    if (event.state === 'failed')
      return chinese ? `游戏操作失败：${event.error}` : `Game action failed: ${event.error}`
    if (event.state === 'cancelled')
      return chinese ? '游戏操作已取消。' : 'Game action cancelled.'

    if (command.capabilityId === capabilityIds.follow && event.state === 'running') {
      const playerName = stringValue(command.input.playerName) ?? ''
      return chinese ? `开始跟随 ${playerName}。` : `Following ${playerName}.`
    }

    if (command.capabilityId === capabilityIds.stop && event.state === 'succeeded')
      return chinese ? '已停止跟随。' : 'Stopped following.'

    if (command.capabilityId === capabilityIds.status && event.state === 'succeeded')
      return describeStatus(event.result, chinese)

    return null
  }
}

function hasCapability(capabilities: GameCapability[], capabilityId: string) {
  return capabilities.some(capability => capability.capabilityId === capabilityId)
}

function matchesStop(text: string) {
  return /停止跟随|停止跟着|别跟(?:了|随)?|不要跟(?:了|随)?|(?:stop|quit)\s+follow(?:ing)?/i.test(text)
}

function matchesStatus(text: string) {
  return /(?:我的世界|minecraft|\bmc\b|游戏).*(?:状态|血量|生命|饥饿|位置)|(?:status|state).*(?:minecraft|\bmc\b)|(?:minecraft|\bmc\b).*(?:status|state)/i.test(text)
}

function followInput(text: string) {
  const match = text.match(/(?:跟随|跟着)(?:玩家)?\s*(\w{1,16})/)
    ?? text.match(/\bfollow(?:\s+player)?\s+(\w{1,16})\b/i)
  if (match == null)
    return null

  const distanceMatch = text.match(/(?:距离|保持)\s*(\d+(?:\.\d+)?)|(?:at|distance)\s+(\d+(?:\.\d+)?)\s*(?:blocks?)?/i)
  const distanceText = distanceMatch?.[1] ?? distanceMatch?.[2]
  return {
    playerName: match[1],
    ...(distanceText == null ? {} : { distance: Number(distanceText) }),
  }
}

function containsCjk(text?: string) {
  return text != null && /[\u3400-\u9FFF]/.test(text)
}

function describeStatus(result: JsonValue | undefined, chinese: boolean) {
  const snapshot = objectValue(result)
  if (snapshot == null)
    return chinese ? '已读取游戏状态。' : 'Minecraft status received.'

  const username = stringValue(snapshot.username) ?? 'Minecraft bot'
  const health = numberValue(snapshot.health)
  const food = numberValue(snapshot.food)
  const position = objectValue(snapshot.position)
  const coordinates = position == null
    ? null
    : [numberValue(position.x), numberValue(position.y), numberValue(position.z)]
  const positionText = coordinates?.every(value => value != null)
    ? coordinates.map(value => value?.toFixed(1)).join(', ')
    : null

  if (chinese) {
    return `${[
      `${username} 当前状态`,
      health == null ? null : `生命 ${health}`,
      food == null ? null : `饥饿 ${food}`,
      positionText == null ? null : `位置 ${positionText}`,
    ].filter(part => part != null).join('，')}。`
  }

  return `${[
    `${username} status`,
    health == null ? null : `health ${health}`,
    food == null ? null : `food ${food}`,
    positionText == null ? null : `position ${positionText}`,
  ].filter(part => part != null).join(', ')}.`
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return typeof value === 'object' && value != null && !Array.isArray(value)
    ? value
    : null
}

function stringValue(value: JsonValue | undefined) {
  return typeof value === 'string' ? value : null
}

function numberValue(value: JsonValue | undefined) {
  return typeof value === 'number' ? value : null
}
