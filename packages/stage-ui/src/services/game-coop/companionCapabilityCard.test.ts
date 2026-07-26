import { describe, expect, it } from 'vitest'

import {
  capabilityVerb,
  describeCompanionCapability,
  formatCompanionCapabilityCard,
} from './companionCapabilityCard'

describe('companionCapabilityCard', () => {
  it('maps MCP tool names to player-facing Chinese abilities', () => {
    expect(describeCompanionCapability({
      name: 'minecraft_come',
      description: 'Walk once to a visible Minecraft player',
    })).toBe('走到玩家身边')
    expect(describeCompanionCapability({
      name: 'minecraft_collect',
      description: 'Collect nearby blocks',
    })).toBe('采集方块或砍树')
    expect(capabilityVerb('minecraft.chest')).toBe('chest')
    expect(describeCompanionCapability({
      name: 'minecraft_chest',
      description: 'Chest ops',
    })).toBe('查看或存取箱子')
    expect(describeCompanionCapability({
      name: 'minecraft_mine_at',
      description: 'Mine at coords',
    })).toBe('挖掉指定坐标的方块')
    expect(describeCompanionCapability({
      name: 'minecraft_waypoint',
      description: 'Waypoints',
    })).toBe('记住或前往地标')
  })

  it('builds a capability card that forbids denial for listed abilities', () => {
    const card = formatCompanionCapabilityCard([
      { name: 'minecraft_follow', description: 'Follow player', inputSchema: { type: 'object' } },
      { name: 'minecraft_come', description: 'Come to player', inputSchema: { type: 'object' } },
      { name: 'minecraft_craft', description: 'Craft', inputSchema: { type: 'object' } },
    ]).join('\n')

    expect(card).toContain('跟着玩家走')
    expect(card).toContain('走到玩家身边')
    expect(card).toContain('合成物品或查看配方')
    expect(card).not.toContain('minecraft_follow')
    expect(card).toContain('禁止说做不到')
  })

  it('states clearly when no game actions are available', () => {
    const card = formatCompanionCapabilityCard([]).join('\n')
    expect(card).toContain('没有可用的游戏行动能力')
  })
})
