import { beforeEach, describe, expect, it, vi } from 'vitest'

import { putInChest, takeFromChest } from '../../skills/actions/inventory'
import { breakBlockAt, placeBlock } from '../../skills/actions/world-interactions'
import { actionsList } from './llm-actions'

vi.mock('../../skills/actions/world-interactions', () => ({
  activateNearestBlock: vi.fn(),
  breakBlockAt: vi.fn(async () => true),
  placeBlock: vi.fn(async () => true),
}))

vi.mock('../../skills/actions/inventory', () => ({
  discard: vi.fn(),
  equip: vi.fn(),
  putInChest: vi.fn(async () => true),
  takeFromChest: vi.fn(async () => true),
}))

vi.mock('../../skills', async () => {
  const actual = await vi.importActual<typeof import('../../skills')>('../../skills')
  return {
    ...actual,
    viewChest: vi.fn(async () => true),
    craftRecipe: vi.fn(async () => undefined),
    goToNearestBlock: vi.fn(async () => ({ position: { x: 1, y: 64, z: 2 } })),
    goToNearestEntity: vi.fn(async () => true),
    moveAway: vi.fn(async () => true),
    goToPosition: vi.fn(async () => ({ ok: true, message: 'ok' })),
    tillAndSow: vi.fn(async () => true),
  }
})

vi.mock('../../utils/recipe-planner', () => ({
  describeRecipePlan: vi.fn(() => 'NEED: stick x2'),
}))

function getAction(name: string) {
  const action = actionsList.find(item => item.name === name)
  if (!action)
    throw new Error(`${name} action missing`)
  return action
}

describe('llm-actions mineBlockAt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows expected torch when actual block is wall_torch', async () => {
    const mineBlockAtAction = getAction('mineBlockAt')
    const mineflayer = {
      bot: {
        blockAt: vi.fn(() => ({ name: 'wall_torch' })),
      },
    } as any

    const perform = mineBlockAtAction.perform(mineflayer)
    const result = await perform(1, 2, 3, 'torch')

    expect(result).toContain('Mined block at (1, 2, 3)')
    expect(breakBlockAt).toHaveBeenCalledWith(mineflayer, 1, 2, 3)
  })

  it('rejects unrelated expected block types', async () => {
    const mineBlockAtAction = getAction('mineBlockAt')
    const mineflayer = {
      bot: {
        blockAt: vi.fn(() => ({ name: 'oak_log' })),
      },
    } as any

    const perform = mineBlockAtAction.perform(mineflayer)
    await expect(perform(1, 2, 3, 'torch')).rejects.toThrow(/Block type mismatch/i)
    expect(breakBlockAt).not.toHaveBeenCalled()
  })

  it('rejects collection-only aliases for exact block validation', async () => {
    const mineBlockAtAction = getAction('mineBlockAt')
    const mineflayer = {
      bot: {
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const perform = mineBlockAtAction.perform(mineflayer)
    await expect(perform(1, 2, 3, 'dirt')).rejects.toThrow(/Block type mismatch/i)
    expect(breakBlockAt).not.toHaveBeenCalled()
  })

  it('exposes skip tool with stable return value', async () => {
    const skipAction = getAction('skip')
    const perform = skipAction.perform({} as any)
    expect(perform()).toBe('Skipped turn')
  })
})

describe('llm-actions expanded companion tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('placeAt uses feet when coords omitted and placeAt when coords given', async () => {
    const action = getAction('placeAt')
    const mineflayer = {
      bot: { entity: { position: { x: 5.2, y: 64.1, z: -1.8 } } },
    } as any
    const perform = action.perform(mineflayer)

    await expect(perform('torch')).resolves.toContain('Placed [torch]')
    expect(placeBlock).toHaveBeenCalledWith(mineflayer, 'torch', 5.2, 64.1, -1.8)

    await expect(perform('oak_planks', 1, 70, 2)).resolves.toContain('(1, 70, 2)')
    expect(placeBlock).toHaveBeenLastCalledWith(mineflayer, 'oak_planks', 1, 70, 2)
  })

  it('craftRecipe mode=plan does not craft; mode=execute crafts', async () => {
    const skills = await import('../../skills')
    const { describeRecipePlan } = await import('../../utils/recipe-planner')
    const action = getAction('craftRecipe')
    const mineflayer = { bot: {} } as any
    const perform = action.perform(mineflayer)

    const plan = await perform('stone_pickaxe', 1, 'plan')
    expect(plan).toContain('NEED: stick x2')
    expect(describeRecipePlan).toHaveBeenCalled()
    expect(skills.craftRecipe).not.toHaveBeenCalled()

    await expect(perform('stick', 2, 'execute')).resolves.toContain('Crafted [stick] 2 time(s)')
    expect(skills.craftRecipe).toHaveBeenCalledWith(mineflayer, 'stick', 2)
  })

  it('chest put/take/view routes correctly', async () => {
    const skills = await import('../../skills')
    const action = getAction('chest')
    const mineflayer = {} as any
    const perform = action.perform(mineflayer)

    await expect(perform('view')).resolves.toBe('Viewed nearest chest')
    expect(skills.viewChest).toHaveBeenCalledWith(mineflayer)

    await expect(perform('put', 'cobblestone', 3)).resolves.toContain('Put [cobblestone]x3')
    expect(putInChest).toHaveBeenCalledWith(mineflayer, 'cobblestone', 3)

    await expect(perform('take', 'coal', 1)).resolves.toContain('Took [coal]x1')
    expect(takeFromChest).toHaveBeenCalledWith(mineflayer, 'coal', 1)

    await expect(perform('put')).rejects.toThrow(/item_name/)
  })

  it('lookAt accepts player or coordinates exclusively', async () => {
    const lookAt = vi.fn(async () => undefined)
    const action = getAction('lookAt')
    const mineflayer = {
      bot: {
        players: { Steve: { entity: { position: { offset: () => ({ x: 1, y: 2, z: 3 }) }, height: 1.6 } } },
        lookAt,
      },
    } as any
    const perform = action.perform(mineflayer)

    await expect(perform('Steve')).resolves.toContain('Steve')
    expect(lookAt).toHaveBeenCalled()

    await expect(perform(undefined, 1, 2, 3)).resolves.toContain('(1, 2, 3)')
    await expect(perform()).rejects.toThrow(/player_name or x,y,z/)
  })

  it('digDown breaks blocks under feet until depth or bedrock', async () => {
    const action = getAction('digDown')
    const blockAt = vi.fn()
      .mockReturnValueOnce({ name: 'dirt', position: { x: 0, y: 63, z: 0 } })
      .mockReturnValueOnce({ name: 'bedrock', position: { x: 0, y: 62, z: 0 } })
    const mineflayer = {
      bot: {
        entity: { position: { floored: () => ({ x: 0, y: 64, z: 0, offset: (dx: number, dy: number, dz: number) => ({ x: dx, y: 64 + dy, z: dz }) }) } },
        blockAt,
      },
    } as any

    // Fix floored().offset for digDown implementation
    const feet = { x: 0, y: 64, z: 0 }
    mineflayer.bot.entity.position.floored = () => ({
      ...feet,
      offset: (dx: number, dy: number, dz: number) => ({ x: feet.x + dx, y: feet.y + dy, z: feet.z + dz }),
    })

    const perform = action.perform(mineflayer)
    await expect(perform(3)).resolves.toContain('Dug down 1 block')
    expect(breakBlockAt).toHaveBeenCalledTimes(1)
  })

  it('registers navigation and farm helpers', async () => {
    const skills = await import('../../skills')
    await expect(getAction('goToNearestBlock').perform({} as any)('oak_log', 2, 32))
      .resolves
      .toContain('Reached oak_log')
    expect(skills.goToNearestBlock).toHaveBeenCalled()

    await expect(getAction('goToNearestEntity').perform({} as any)('cow'))
      .resolves
      .toContain('cow')
    await expect(getAction('moveAway').perform({} as any)(8))
      .resolves
      .toContain('Moved away')
    await expect(getAction('tillAndSow').perform({} as any)(1, 64, 2, 'wheat_seeds'))
      .resolves
      .toContain('wheat_seeds')
  })
})
