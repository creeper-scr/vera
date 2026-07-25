import type { GameActionEvent, GameCommand } from '@proj-vera/game-coop-core'

import type {
  MinecraftGameDriver,
  MinecraftSnapshot,
} from './minecraftGameAdapter'

import { describe, expect, it, vi } from 'vitest'

import { createMinecraftGameDriver, MinecraftGameAdapter } from './minecraftGameAdapter'

const snapshot: MinecraftSnapshot = {
  connected: true,
  username: 'vera',
  position: { x: 1, y: 64, z: 2 },
  health: 20,
  food: 18,
  weather: 'clear',
  time: '10:00 AM',
  follow: {
    playerName: null,
    distance: 2,
    active: false,
    error: null,
  },
}

function createDriver(): MinecraftGameDriver {
  return {
    getSnapshot: vi.fn(() => snapshot),
    follow: vi.fn(),
    stopFollow: vi.fn(),
  }
}

function createTaskDriver(): MinecraftGameDriver {
  return {
    ...createDriver(),
    executeAction: vi.fn(async tool => ({ tool, ok: true })),
    stopAction: vi.fn(async () => {}),
  }
}

function command(
  capabilityId: string,
  actionId: string,
  input: GameCommand['input'] = {},
  sessionId = 'session-1',
): GameCommand {
  return {
    sessionId,
    turnId: `turn-${actionId}`,
    actionId,
    capabilityId,
    input,
  }
}

function observe(adapter: MinecraftGameAdapter, sessionId = 'session-1') {
  const events: GameActionEvent[] = []
  adapter.observe(sessionId, event => events.push(event))
  return events
}

describe('minecraft game adapter', () => {
  it('exposes owner identity and online players to upper intelligence', () => {
    const mineflayer = Object.assign(Object.create(null), {
      ready: true,
      bot: {
        username: 'vera',
        players: {
          vera: {},
          Alex: {},
          Steve: {},
        },
        entity: {
          position: { x: 1, y: 64, z: 2 },
        },
        health: 20,
        food: 18,
      },
    }) as Parameters<typeof createMinecraftGameDriver>[0]
    const reflexManager = Object.assign(Object.create(null), {
      getContextSnapshot: () => ({
        environment: {
          weather: 'clear',
          time: '10:00 AM',
          lightLevel: 15,
        },
      }),
    }) as Parameters<typeof createMinecraftGameDriver>[1]
    const taskExecutor = Object.create(null) as Parameters<typeof createMinecraftGameDriver>[2]
    const driver = createMinecraftGameDriver(mineflayer, reflexManager, taskExecutor, 'Steve')

    expect(driver.getEnvironment?.()).toMatchObject({
      masterUsername: 'Steve',
      playersOnline: ['Alex', 'Steve'],
      nearbyBlocks: [],
      nearestLog: null,
    })
  })

  it('declares status, follow, and stop capabilities', async () => {
    const adapter = new MinecraftGameAdapter({ driver: createDriver() })

    const capabilities = await adapter.getCapabilities('session-1')

    expect(capabilities.map(item => item.capabilityId)).toEqual([
      'minecraft.status',
      'minecraft.follow',
      'minecraft.stop',
    ])
  })

  it('declares companion task capabilities when TaskExecutor is available', async () => {
    const adapter = new MinecraftGameAdapter({ driver: createTaskDriver() })

    const capabilities = await adapter.getCapabilities('session-1')

    expect(capabilities.map(item => item.capabilityId)).toEqual([
      'minecraft.status',
      'minecraft.follow',
      'minecraft.stop',
      'minecraft.move',
      'minecraft.come',
      'minecraft.collect',
      'minecraft.interact',
      'minecraft.say',
      'minecraft.give',
      'minecraft.equip',
      'minecraft.eat',
      'minecraft.sleep',
      'minecraft.recipe',
      'minecraft.craft',
      'minecraft.smelt',
      'minecraft.clear_furnace',
      'minecraft.place',
      'minecraft.attack',
      'minecraft.chest_put',
      'minecraft.chest_take',
      'minecraft.discard',
    ])
  })

  it('reports a status snapshot through a complete lifecycle', async () => {
    const driver = createDriver()
    const adapter = new MinecraftGameAdapter({ driver, now: () => 10 })
    const events = observe(adapter)

    await adapter.execute(command('minecraft.status', 'status-1'))

    expect(events.map(event => event.state)).toEqual([
      'queued',
      'running',
      'snapshot',
      'succeeded',
    ])
    expect(events[2]).toMatchObject({ snapshot })
    expect(events[3]).toMatchObject({ result: snapshot })
    expect(events.every(event => event.timestamp === 10)).toBe(true)
  })

  it('keeps follow running until action-scoped cancellation', async () => {
    const driver = createDriver()
    const adapter = new MinecraftGameAdapter({ driver })
    const events = observe(adapter)
    const follow = command('minecraft.follow', 'follow-1', {
      playerName: 'Steve',
      distance: 3,
    })

    await adapter.execute(follow)
    await adapter.cancel(follow.actionId, 'voice interrupt')

    expect(driver.follow).toHaveBeenCalledWith('Steve', 3)
    expect(driver.stopFollow).toHaveBeenCalledOnce()
    expect(events.map(event => event.state)).toEqual([
      'queued',
      'running',
      'cancelled',
    ])
    expect(events[2]).toMatchObject({ reason: 'voice interrupt' })
  })

  it('replaces follow only within the same session', async () => {
    const driver = createDriver()
    const adapter = new MinecraftGameAdapter({ driver })
    const firstSessionEvents = observe(adapter)
    const secondSessionEvents = observe(adapter, 'session-2')

    await adapter.execute(command('minecraft.follow', 'follow-1', { playerName: 'Steve' }))
    await adapter.execute(command('minecraft.follow', 'follow-2', { playerName: 'Alex' }))
    await adapter.execute(command('minecraft.follow', 'follow-3', { playerName: 'Sam' }, 'session-2'))

    expect(driver.follow).toHaveBeenCalledTimes(2)
    expect(driver.stopFollow).toHaveBeenCalledOnce()
    expect(firstSessionEvents).toContainEqual(expect.objectContaining({
      actionId: 'follow-1',
      state: 'cancelled',
      reason: 'Replaced by a newer follow action',
    }))
    expect(secondSessionEvents.map(event => event.state)).toEqual(['queued', 'failed'])
  })

  it('stop cancels only the current session follow action', async () => {
    const driver = createDriver()
    const adapter = new MinecraftGameAdapter({ driver })
    const events = observe(adapter)

    await adapter.execute(command('minecraft.follow', 'follow-1', { playerName: 'Steve' }))
    await adapter.execute(command('minecraft.stop', 'stop-1'))

    expect(driver.stopFollow).toHaveBeenCalledOnce()
    expect(events.map(event => [event.actionId, event.state])).toEqual([
      ['follow-1', 'queued'],
      ['follow-1', 'running'],
      ['stop-1', 'queued'],
      ['stop-1', 'running'],
      ['follow-1', 'cancelled'],
      ['stop-1', 'succeeded'],
    ])
    expect(events[5]).toMatchObject({
      result: { stoppedActionIds: ['follow-1'] },
    })
  })

  it('stop clears legacy follow when no Coop action is tracked', async () => {
    const driver = createDriver()
    const adapter = new MinecraftGameAdapter({ driver })
    const events = observe(adapter)

    await adapter.execute(command('minecraft.stop', 'stop-1'))

    expect(driver.stopFollow).toHaveBeenCalledOnce()
    expect(events.map(event => event.state)).toEqual([
      'queued',
      'running',
      'succeeded',
    ])
    expect(events[2]).toMatchObject({
      result: { stoppedActionIds: [] },
    })
  })

  it('maps companion task capabilities to TaskExecutor actions', async () => {
    const driver = createTaskDriver()
    const adapter = new MinecraftGameAdapter({ driver })
    const events = observe(adapter)

    await adapter.execute(command('minecraft.move', 'move-1', {
      target: '1,64,2',
      closeness: 2,
    }))
    await adapter.execute(command('minecraft.come', 'come-1', {
      playerName: 'Steve',
      closeness: 3,
    }))
    await adapter.execute(command('minecraft.collect', 'collect-1', {
      target: 'oak_log',
      count: 3,
    }))
    await adapter.execute(command('minecraft.interact', 'interact-1', {
      target: 'crafting_table',
    }))
    await adapter.execute(command('minecraft.say', 'say-1', {
      text: 'hello',
    }))
    await adapter.execute(command('minecraft.give', 'give-1', {
      playerName: 'Steve',
      itemName: 'cooked_beef',
      count: 2,
    }))
    await adapter.execute(command('minecraft.craft', 'craft-1', {
      itemName: 'stick',
      count: 1,
    }))
    await adapter.execute(command('minecraft.attack', 'attack-1', {
      entityType: 'zombie',
    }))

    expect(driver.executeAction).toHaveBeenNthCalledWith(1, 'goToCoordinate', {
      x: 1,
      y: 64,
      z: 2,
      closeness: 2,
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(2, 'goToPlayer', {
      player_name: 'Steve',
      closeness: 3,
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(3, 'collectBlocks', {
      type: 'oak_log',
      num: 3,
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(4, 'activate', {
      type: 'crafting_table',
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(5, 'chat', {
      message: 'hello',
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(6, 'givePlayer', {
      player_name: 'Steve',
      item_name: 'cooked_beef',
      num: 2,
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(7, 'craftRecipe', {
      recipe_name: 'stick',
      num: 1,
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(8, 'attack', {
      type: 'zombie',
    })
    expect(events.filter(event => event.state === 'succeeded')).toHaveLength(8)
  })

  it('stops a running TaskExecutor action with one cancelled terminal event', async () => {
    let rejectTask: ((reason?: unknown) => void) | undefined
    const driver: MinecraftGameDriver = {
      ...createDriver(),
      executeAction: vi.fn(() => new Promise<never>((_resolve, reject) => {
        rejectTask = reject
      })),
      stopAction: vi.fn(async () => {
        rejectTask?.(new Error('stopped'))
      }),
    }
    const adapter = new MinecraftGameAdapter({ driver })
    const events = observe(adapter)

    const moveTask = adapter.execute(command('minecraft.move', 'move-1', {
      target: '1,64,2',
    }))
    await Promise.resolve()
    await adapter.execute(command('minecraft.stop', 'stop-1'))
    await moveTask

    expect(driver.stopAction).toHaveBeenCalledOnce()
    expect(events.map(event => [event.actionId, event.state])).toEqual([
      ['move-1', 'queued'],
      ['move-1', 'running'],
      ['stop-1', 'queued'],
      ['stop-1', 'running'],
      ['move-1', 'cancelled'],
      ['stop-1', 'succeeded'],
    ])
  })

  it('fails invalid input before touching the driver', async () => {
    const driver = createDriver()
    const adapter = new MinecraftGameAdapter({ driver })
    const events = observe(adapter)

    await adapter.execute(command('minecraft.follow', 'follow-1', {
      playerName: '',
    }))

    expect(events.map(event => event.state)).toEqual(['queued', 'failed'])
    expect(driver.follow).not.toHaveBeenCalled()
  })

  it('maps remaining companion survival and inventory capabilities', async () => {
    const driver = createTaskDriver()
    const adapter = new MinecraftGameAdapter({ driver })
    const events = observe(adapter)

    await adapter.execute(command('minecraft.equip', 'equip-1', { itemName: 'iron_sword' }))
    await adapter.execute(command('minecraft.eat', 'eat-1', { itemName: 'cooked_beef' }))
    await adapter.execute(command('minecraft.sleep', 'sleep-1'))
    await adapter.execute(command('minecraft.recipe', 'recipe-1', {
      itemName: 'stone_pickaxe',
      count: 1,
    }))
    await adapter.execute(command('minecraft.smelt', 'smelt-1', {
      itemName: 'iron_ore',
      count: 2,
    }))
    await adapter.execute(command('minecraft.clear_furnace', 'furnace-1'))
    await adapter.execute(command('minecraft.place', 'place-1', { blockType: 'torch' }))
    await adapter.execute(command('minecraft.chest_put', 'chest-put-1', {
      itemName: 'cobblestone',
      count: 16,
    }))
    await adapter.execute(command('minecraft.chest_take', 'chest-take-1', {
      itemName: 'coal',
      count: 4,
    }))
    await adapter.execute(command('minecraft.discard', 'discard-1', {
      itemName: 'dirt',
      count: 8,
    }))

    expect(driver.executeAction).toHaveBeenNthCalledWith(1, 'equip', { item_name: 'iron_sword' })
    expect(driver.executeAction).toHaveBeenNthCalledWith(2, 'consume', { item_name: 'cooked_beef' })
    expect(driver.executeAction).toHaveBeenNthCalledWith(3, 'goToBed', {})
    expect(driver.executeAction).toHaveBeenNthCalledWith(4, 'recipePlan', {
      item_name: 'stone_pickaxe',
      amount: 1,
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(5, 'smeltItem', {
      item_name: 'iron_ore',
      num: 2,
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(6, 'clearFurnace', {})
    expect(driver.executeAction).toHaveBeenNthCalledWith(7, 'placeHere', { type: 'torch' })
    expect(driver.executeAction).toHaveBeenNthCalledWith(8, 'putInChest', {
      item_name: 'cobblestone',
      num: 16,
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(9, 'takeFromChest', {
      item_name: 'coal',
      num: 4,
    })
    expect(driver.executeAction).toHaveBeenNthCalledWith(10, 'discard', {
      item_name: 'dirt',
      num: 8,
    })
    expect(events.filter(event => event.state === 'succeeded')).toHaveLength(10)
  })

  it('declares companion risk levels for MCP projection', async () => {
    const adapter = new MinecraftGameAdapter({ driver: createTaskDriver() })
    const capabilities = await adapter.getCapabilities('session-1')
    const byId = Object.fromEntries(
      capabilities.map(item => [item.capabilityId, item]),
    )

    expect(byId['minecraft.come']?.risk).toBe('low')
    expect(byId['minecraft.give']?.risk).toBe('low')
    expect(byId['minecraft.recipe']?.risk).toBe('low')
    expect(byId['minecraft.collect']?.risk).toBe('medium')
    expect(byId['minecraft.craft']?.risk).toBe('medium')
    expect(byId['minecraft.attack']?.risk).toBe('medium')
    expect(byId['minecraft.chest_put']?.cancellable).toBe(true)
    expect(byId['minecraft.place']?.cancellable).toBe(false)
    expect(capabilities.some(item => item.capabilityId === 'minecraft.attack_player')).toBe(false)
  })

  it('rejects invalid companion task inputs without calling TaskExecutor', async () => {
    const driver = createTaskDriver()
    const adapter = new MinecraftGameAdapter({ driver })
    const events = observe(adapter)

    await adapter.execute(command('minecraft.come', 'come-bad', { playerName: '' }))
    await adapter.execute(command('minecraft.move', 'move-bad', { target: 'not-a-coord' }))
    await adapter.execute(command('minecraft.give', 'give-bad', {
      playerName: 'Steve',
      // itemName missing
    }))
    await adapter.execute(command('minecraft.craft', 'craft-bad', {
      itemName: 'stick',
      count: 0,
    }))

    expect(driver.executeAction).not.toHaveBeenCalled()
    expect(events.filter(event => event.state === 'failed')).toHaveLength(4)
    expect(events.filter(event => event.state === 'failed').every(event =>
      event.state === 'failed' && event.error.startsWith('Invalid input'),
    )).toBe(true)
  })

  it('returns a correlated failed lifecycle for an unsupported capability', async () => {
    const driver = createDriver()
    const adapter = new MinecraftGameAdapter({ driver })
    const events = observe(adapter)

    await adapter.execute(command('minecraft.missing', 'missing-1'))

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        turnId: 'turn-missing-1',
        actionId: 'missing-1',
        capabilityId: 'minecraft.missing',
        state: 'queued',
      }),
      expect.objectContaining({
        sessionId: 'session-1',
        turnId: 'turn-missing-1',
        actionId: 'missing-1',
        capabilityId: 'minecraft.missing',
        state: 'failed',
        error: 'Unsupported Minecraft capability "minecraft.missing"',
      }),
    ])
    expect(driver.follow).not.toHaveBeenCalled()
    expect(driver.stopFollow).not.toHaveBeenCalled()
  })
})
