import type { Action } from '../../libs/mineflayer'

import { Vec3 } from 'vec3'
import { z } from 'zod'

import { matchesBlockAlias } from '../../skills/actions/block-type-normalizer'
import { collectBlock } from '../../skills/actions/collect-block'
import { discard, equip, putInChest, takeFromChest } from '../../skills/actions/inventory'
import { activateNearestBlock, breakBlockAt, placeBlock } from '../../skills/actions/world-interactions'
import { ActionError } from '../../utils/errors'
import { describeRecipePlan } from '../../utils/recipe-planner'

import * as skills from '../../skills'

// Utils
const pad = (str: string): string => `\n${str}\n`

function toCoord(pos: { x: number, y: number, z: number }) {
  return { x: pos.x, y: pos.y, z: pos.z }
}

function cloneVec3(pos: { x: number, y: number, z: number }): Vec3 {
  return new Vec3(pos.x, pos.y, pos.z)
}

export const actionsList: Action[] = [
  {
    name: 'chat',
    description: 'Send a chat message to players in the game. Use this to communicate, respond to questions, or announce what you are doing.',
    execution: 'sync',
    schema: z.object({
      message: z.string().describe('The message to send in chat.'),
      feedback: z.boolean().default(false).describe('Whether to emit FEEDBACK for this chat action. Keep false for normal conversation to avoid feedback loops.'),
    }),
    perform: mineflayer => (message: string): string => {
      mineflayer.bot.chat(message)
      return `Sent message: "${message}"`
    },
  },
  {
    name: 'giveUp',
    description: 'Admit you are currently stuck and halt all autonomous processing until a player speaks to you again.',
    execution: 'sync',
    schema: z.object({
      reason: z.string().min(1).describe('Short explanation of why you are stuck.'),
    }),
    perform: () => (reason: string): string => `Gave up: ${reason}. Halted until player input.`,
  },
  {
    name: 'skip',
    description: 'Skip this turn without performing any world action.',
    execution: 'sync',
    schema: z.object({}),
    perform: () => (): string => 'Skipped turn',
  },
  {
    name: 'stop',
    description: 'Force stop all actions', // TODO: include name of the current action in description?
    execution: 'async',
    schema: z.object({}),
    perform: mineflayer => async () => {
      mineflayer.interrupt('stop tool called')

      return 'all actions stopped'
    },
  },
  {
    name: 'goToPlayer',
    description: 'Go to the given player.',
    execution: 'async',
    schema: z.object({
      player_name: z.string().describe('The name of the player to go to.'),
      closeness: z.number().describe('How close to get to the player in blocks.').min(0),
    }),
    perform: mineflayer => async (player_name: string, closeness: number) => {
      const getPlayerPos = () => {
        const entity = mineflayer.bot.players[player_name]?.entity
        return entity ? cloneVec3(entity.position) : null
      }

      const selfStart = cloneVec3(mineflayer.bot.entity.position)
      const targetStart = getPlayerPos()
      const distanceToTargetBefore = targetStart ? selfStart.distanceTo(targetStart) : null

      const result = await skills.goToPlayer(mineflayer, player_name, closeness)

      const selfEnd = cloneVec3(mineflayer.bot.entity.position)
      const targetEnd = getPlayerPos()
      const distanceToTargetAfter = targetEnd ? selfEnd.distanceTo(targetEnd) : null

      return {
        ok: result.ok,
        reason: result.reason,
        target: { player_name, closeness },
        startPos: toCoord(selfStart),
        endPos: toCoord(selfEnd),
        movedDistance: selfStart.distanceTo(selfEnd),
        distanceToTargetBefore,
        distanceToTargetAfter,
        elapsedMs: result.elapsedMs,
        estimatedTimeMs: result.estimatedTimeMs,
        message: result.message,
      }
    },
  },
  {
    name: 'followPlayer',
    description: 'Set idle auto-follow target handled by reflex runtime. While idle, the bot will keep following this player until cleared.',
    execution: 'sync',
    readonly: true,
    schema: z.object({
      player_name: z.string().describe('name of the player to follow.'),
      follow_dist: z.number().describe('The distance to follow from.').min(0),
    }),
    perform: mineflayer => (player_name: string, follow_dist: number) => {
      const reflexManager = (mineflayer as any).reflexManager
      if (!reflexManager || typeof reflexManager.setFollowTarget !== 'function')
        throw new Error('Reflex follow manager is unavailable')

      reflexManager.setFollowTarget(player_name, follow_dist)
      return `Auto-follow enabled for player [${player_name}] at distance ${follow_dist}`
    },
  },
  {
    name: 'clearFollowTarget',
    description: 'Disable idle auto-follow. Use this before independent exploration or when you no longer want to shadow a player.',
    execution: 'sync',
    readonly: true,
    schema: z.object({}),
    perform: mineflayer => () => {
      const reflexManager = (mineflayer as any).reflexManager
      if (!reflexManager || typeof reflexManager.clearFollowTarget !== 'function')
        throw new Error('Reflex follow manager is unavailable')

      reflexManager.clearFollowTarget()
      return 'Auto-follow disabled'
    },
  },
  {
    name: 'goToCoordinate',
    description: 'Go to the given x, y, z location. Uses full A* pathfinding that automatically breaks/digs blocks in the way. Do NOT manually mine-then-move block by block; just call this with the destination.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      x: z.number().describe('The x coordinate.'),
      y: z.number().describe('The y coordinate.').min(-64).max(320),
      z: z.number().describe('The z coordinate.'),
      closeness: z.number().describe('0 If want to be exactly at the position, otherwise a positive number in blocks for leniency.').min(0),
    }),
    perform: mineflayer => async (x: number, y: number, z: number, closeness: number) => {
      const selfStart = cloneVec3(mineflayer.bot.entity.position)
      const targetVec = new Vec3(x, y, z)
      const distanceToTargetBefore = selfStart.distanceTo(targetVec)

      const result = await skills.goToPosition(mineflayer, x, y, z, closeness)

      const selfEnd = cloneVec3(mineflayer.bot.entity.position)
      const distanceToTargetAfter = selfEnd.distanceTo(targetVec)

      return {
        ok: result.ok,
        reason: result.reason,
        target: { x, y, z, closeness },
        startPos: toCoord(selfStart),
        endPos: toCoord(selfEnd),
        movedDistance: selfStart.distanceTo(selfEnd),
        distanceToTargetBefore,
        distanceToTargetAfter,
        withinCloseness: distanceToTargetAfter <= closeness,
        elapsedMs: result.elapsedMs,
        estimatedTimeMs: result.estimatedTimeMs,
        message: result.message,
      }
    },
  },
  {
    name: 'givePlayer',
    description: 'Give the specified item to the given player.',
    execution: 'async',
    schema: z.object({
      player_name: z.string().describe('The name of the player to give the item to.'),
      item_name: z.string().describe('The name of the item to give.'),
      num: z.number().int().describe('The number of items to give.').min(1),
    }),
    perform: mineflayer => async (player_name: string, item_name: string, num: number) => {
      await skills.giveToPlayer(mineflayer, item_name, player_name, num)
      return `Gave [${item_name}]x${num} to player [${player_name}]`
    },
  },
  {
    name: 'consume',
    description: 'Eat/drink the given item.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to consume.'),
    }),
    perform: mineflayer => async (item_name: string) => {
      await skills.consume(mineflayer, item_name)
      return `Consumed [${item_name}]`
    },
  },
  {
    name: 'equip',
    description: 'Equip the given item.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to equip.'),
    }),
    perform: mineflayer => async (item_name: string) => {
      await equip(mineflayer, item_name)
      return `Equipped [${item_name}]`
    },
  },
  {
    name: 'putInChest',
    description: 'Put the given item in the nearest chest. Prefer the unified chest action when available.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to put in the chest.'),
      num: z.number().int().describe('The number of items to put in the chest.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await putInChest(mineflayer, item_name, num)
      return `Put [${item_name}]x${num} in chest`
    },
  },
  {
    name: 'takeFromChest',
    description: 'Take the given items from the nearest chest. Prefer the unified chest action when available.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to take.'),
      num: z.number().int().describe('The number of items to take.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await takeFromChest(mineflayer, item_name, num)
      return `Took [${item_name}]x${num} from chest`
    },
  },
  {
    name: 'chest',
    description: 'Nearest chest: action put|take|view. view lists contents only. put/take need item_name. Do NOT use activate/interact for chest inventory.',
    execution: 'async',
    schema: z.object({
      action: z.enum(['put', 'take', 'view']).describe('put items in, take items out, or view contents.'),
      item_name: z.string().optional().describe('Item id for put/take.'),
      num: z.number().int().min(1).optional().describe('Count for put/take. Default 1.'),
    }),
    perform: mineflayer => async (action: 'put' | 'take' | 'view', item_name?: string, num?: number) => {
      if (action === 'view') {
        const ok = await skills.viewChest(mineflayer)
        if (!ok)
          throw new ActionError('TARGET_NOT_FOUND', 'Could not find or open a nearby chest')
        return 'Viewed nearest chest'
      }
      if (!item_name?.trim())
        throw new ActionError('UNKNOWN', `chest ${action} requires item_name`)
      const count = num ?? 1
      if (action === 'put') {
        await putInChest(mineflayer, item_name, count)
        return `Put [${item_name}]x${count} in chest`
      }
      await takeFromChest(mineflayer, item_name, count)
      return `Took [${item_name}]x${count} from chest`
    },
  },
  {
    name: 'discard',
    description: 'Discard the given item from the inventory.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to discard.'),
      num: z.number().int().describe('The number of items to discard.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await discard(mineflayer, item_name, num)
      return `Discarded [${item_name}]x${num}`
    },
  },
  {
    name: 'collectBlocks',
    description: 'Find and collect nearby blocks of one type (search + dig + pickup). For a known coordinate use mineBlockAt. To only walk to a block without digging use goToNearestBlock.',
    execution: 'async',
    // NOTICE: detach auto-follow before mining. The idle auto-follow reflex drives the same
    // mineflayer pathfinder as digging; if left attached it periodically re-points the bot at the
    // followed player, which both cancels navigation to the ore ("Path was stopped") and aborts the
    // in-progress bot.dig ("Digging aborted"), producing the stutter of repeated half-digs.
    followControl: 'detach',
    schema: z.object({
      type: z.string().describe('The block type to collect.'),
      num: z.number().int().describe('The number of blocks to collect.').min(1),
    }),
    perform: mineflayer => async (type: string, num: number) => {
      const collected = await collectBlock(mineflayer, type, num)
      if (collected <= 0) {
        throw new ActionError('RESOURCE_MISSING', `Failed to collect any ${type}`, { type, requested: num, collected })
      }
      return `Collected [${type}] x${collected}`
    },
  },
  {
    name: 'mineBlockAt',
    description: 'Break one block at an exact x,y,z. Do NOT use for searching nearby resources — use collectBlocks. Do NOT use just to walk near a block — use goToNearestBlock.',
    execution: 'async',
    // NOTICE: detach auto-follow before mining (same reason as collectBlocks) so the follow reflex
    // cannot interrupt bot.dig mid-break.
    followControl: 'detach',
    schema: z.object({
      x: z.number().describe('The x coordinate.'),
      y: z.number().describe('The y coordinate.'),
      z: z.number().describe('The z coordinate.'),
      expected_block_type: z.string().optional().describe('Optional: expected block type at the position (e.g. oak_log). If provided and mismatched, the action fails.'),
    }),
    perform: mineflayer => async (x: number, y: number, z: number, expected_block_type?: string) => {
      const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
      if (expected_block_type) {
        const block = mineflayer.bot.blockAt(pos)
        if (!block) {
          throw new ActionError('TARGET_NOT_FOUND', `No block found at ${pos}`, { position: pos })
        }

        if (!matchesBlockAlias(expected_block_type, block.name)) {
          throw new ActionError('UNKNOWN', `Block type mismatch at ${pos}: expected ${expected_block_type}, got ${block.name}`, {
            position: pos,
            expected: expected_block_type,
            actual: block.name,
          })
        }
      }

      await breakBlockAt(mineflayer, pos.x, pos.y, pos.z)
      return `Mined block at (${pos.x}, ${pos.y}, ${pos.z})`
    },
  },
  {
    name: 'craftRecipe',
    description: 'Craft or plan crafting. mode=plan only explains materials (no craft). mode=execute crafts (finds/places table as needed). Do not call a separate recipe tool.',
    execution: 'async',
    schema: z.object({
      recipe_name: z.string().describe('The name of the output item to craft.'),
      num: z.number().int().describe('Craft count (recipe runs), NOT always output item count. Ignored for mode=plan except as desired amount.').min(1).default(1),
      mode: z.enum(['plan', 'execute']).default('execute').describe('plan = material plan only; execute = actually craft.'),
    }),
    perform: mineflayer => async (recipe_name: string, num: number = 1, mode: 'plan' | 'execute' = 'execute') => {
      if (mode === 'plan')
        return pad(describeRecipePlan(mineflayer.bot, recipe_name, num))
      await skills.craftRecipe(mineflayer, recipe_name, num)
      return `Crafted [${recipe_name}] ${num} time(s)`
    },
  },
  {
    name: 'smeltItem',
    description: 'Smelt the given item the given number of times.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the input item to smelt.'),
      num: z.number().int().describe('The number of times to smelt the item.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await skills.smeltItem(mineflayer, item_name, num)
      return `Smelted [${item_name}] ${num} time(s)`
    },
  },
  {
    name: 'clearFurnace',
    description: 'Take all items out of the nearest furnace.',
    execution: 'async',
    schema: z.object({}),
    perform: mineflayer => async () => {
      await skills.clearNearestFurnace(mineflayer)
      return 'Cleared furnace'
    },
  },
  {
    name: 'placeAt',
    description: 'Place a single block/torch at x,y,z (omit coords = under feet). Not for multi-block builds. For farming dirt use farm/tillAndSow.',
    execution: 'async',
    schema: z.object({
      type: z.string().describe('The block type to place.'),
      x: z.number().optional().describe('Optional x. Omit with y/z to place at feet.'),
      y: z.number().optional().describe('Optional y.'),
      z: z.number().optional().describe('Optional z.'),
    }),
    perform: mineflayer => async (type: string, x?: number, y?: number, z?: number) => {
      const feet = mineflayer.bot.entity.position
      const px = x ?? feet.x
      const py = y ?? feet.y
      const pz = z ?? feet.z
      await placeBlock(mineflayer, type, px, py, pz)
      return `Placed [${type}] at (${Math.floor(px)}, ${Math.floor(py)}, ${Math.floor(pz)})`
    },
  },
  {
    name: 'placeHere',
    description: 'Alias of placeAt at the bot feet. Prefer placeAt.',
    execution: 'async',
    schema: z.object({
      type: z.string().describe('The block type to place.'),
    }),
    perform: mineflayer => async (type: string) => {
      const pos = mineflayer.bot.entity.position
      await placeBlock(mineflayer, type, pos.x, pos.y, pos.z)
      return `Placed [${type}] here`
    },
  },
  {
    name: 'attack',
    description: 'Attack and kill the nearest entity of a given type. To only walk near a mob without fighting use goToNearestEntity. For players use goToPlayer/follow, not this.',
    execution: 'async',
    schema: z.object({
      type: z.string().describe('The type of entity to attack.'),
    }),
    perform: mineflayer => async (type: string) => {
      await skills.attackNearest(mineflayer, type, true)
      return `Attacked nearest [${type}]`
    },
  },
  {
    name: 'lookAt',
    description: 'Look at a player by name OR at x,y,z. Provide exactly one target style.',
    execution: 'async',
    schema: z.object({
      player_name: z.string().optional().describe('Player to look at.'),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
    }),
    perform: mineflayer => async (player_name?: string, x?: number, y?: number, z?: number) => {
      if (player_name?.trim()) {
        const entity = mineflayer.bot.players[player_name]?.entity
        if (!entity)
          throw new ActionError('TARGET_NOT_FOUND', `Could not find player ${player_name}`, { playerName: player_name })
        await mineflayer.bot.lookAt(entity.position.offset(0, entity.height, 0))
        return `Looked at player [${player_name}]`
      }
      if (x == null || y == null || z == null)
        throw new ActionError('UNKNOWN', 'lookAt requires player_name or x,y,z')
      await mineflayer.bot.lookAt(new Vec3(x, y, z))
      return `Looked at (${x}, ${y}, ${z})`
    },
  },
  {
    name: 'goToNearestBlock',
    description: 'Pathfind to the nearest block of a type without mining it. To collect/dig that type use collectBlocks. For a known coordinate use goToCoordinate.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      type: z.string().describe('Block type to find.'),
      closeness: z.number().min(0).default(2).describe('Stop this many blocks away.'),
      range: z.number().min(1).default(64).describe('Search radius.'),
    }),
    perform: mineflayer => async (type: string, closeness: number = 2, range: number = 64) => {
      const block = await skills.goToNearestBlock(mineflayer, type, closeness, range)
      return `Reached ${type} at (${block.position.x}, ${block.position.y}, ${block.position.z})`
    },
  },
  {
    name: 'goToNearestEntity',
    description: 'Pathfind next to the nearest entity of a type without attacking. To fight use attack. For a player by name use goToPlayer.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      type: z.string().describe('Entity type, e.g. cow or zombie.'),
      closeness: z.number().min(0).default(2),
      range: z.number().min(1).default(64),
    }),
    perform: mineflayer => async (type: string, closeness: number = 2, range: number = 64) => {
      const ok = await skills.goToNearestEntity(mineflayer, type, closeness, range)
      if (!ok)
        throw new ActionError('TARGET_NOT_FOUND', `Could not find or reach entity ${type}`, { type })
      return `Reached nearest [${type}]`
    },
  },
  {
    name: 'moveAway',
    description: 'Move roughly this many blocks away from the current spot. For a specific coordinate use goToCoordinate.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      distance: z.number().min(1).default(16).describe('Approximate distance to move away.'),
    }),
    perform: mineflayer => async (distance: number = 16) => {
      const ok = await skills.moveAway(mineflayer, distance)
      if (!ok)
        throw new ActionError('UNKNOWN', 'Failed to move away')
      return `Moved away by about ${distance} blocks`
    },
  },
  {
    name: 'digDown',
    description: 'Dig straight down under the bot for depth blocks. For one known block use mineBlockAt. For gathering a resource type use collectBlocks.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      depth: z.number().int().min(1).max(64).default(1).describe('How many blocks down to dig.'),
    }),
    perform: mineflayer => async (depth: number = 1) => {
      let dug = 0
      for (let i = 0; i < depth; i++) {
        const feet = mineflayer.bot.entity.position.floored()
        const below = mineflayer.bot.blockAt(feet.offset(0, -1, 0))
        if (!below || below.name === 'air' || below.name === 'bedrock' || below.name === 'void_air')
          break
        await breakBlockAt(mineflayer, below.position.x, below.position.y, below.position.z)
        dug += 1
      }
      if (dug === 0)
        throw new ActionError('UNKNOWN', 'Nothing to dig under the bot')
      return `Dug down ${dug} block(s)`
    },
  },
  {
    name: 'goToSurface',
    description: 'Pathfind up to open sky / surface at the current x,z. For an arbitrary coordinate use goToCoordinate.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({}),
    perform: mineflayer => async () => {
      const pos = mineflayer.bot.entity.position.floored()
      const x = pos.x
      const z = pos.z
      for (let y = Math.min(319, pos.y + 96); y >= -64; y--) {
        const ground = mineflayer.bot.blockAt(new Vec3(x, y, z))
        const above = mineflayer.bot.blockAt(new Vec3(x, y + 1, z))
        if (
          ground
          && ground.boundingBox === 'block'
          && above
          && (above.name === 'air' || above.name === 'cave_air' || above.boundingBox === 'empty')
        ) {
          const result = await skills.goToPosition(mineflayer, x, y + 1, z, 1)
          if (!result.ok)
            throw new ActionError('UNKNOWN', result.message || 'Failed to reach surface')
          return `Reached surface near (${x}, ${y + 1}, ${z})`
        }
      }
      throw new ActionError('TARGET_NOT_FOUND', 'Could not find a surface column at current x,z')
    },
  },
  {
    name: 'tillAndSow',
    description: 'Till dirt/grass at x,y,z and optionally plant seed_type. Not for placing torches/blocks (use placeAt) or collecting crops (use collectBlocks).',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      seed_type: z.string().optional().describe('Optional seed item id, e.g. wheat_seeds.'),
    }),
    perform: mineflayer => async (x: number, y: number, z: number, seed_type?: string) => {
      const ok = await skills.tillAndSow(mineflayer, x, y, z, seed_type ?? null)
      if (!ok)
        throw new ActionError('UNKNOWN', `Failed to till/sow at (${x}, ${y}, ${z})`)
      return seed_type
        ? `Tilled and planted ${seed_type} at (${x}, ${y}, ${z})`
        : `Tilled at (${x}, ${y}, ${z})`
    },
  },
  {
    name: 'attackPlayer',
    description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
    execution: 'async',
    schema: z.object({
      player_name: z.string().describe('The name of the player to attack.'),
    }),
    perform: mineflayer => async (player_name: string) => {
      const player = mineflayer.bot.players[player_name]?.entity
      if (!player) {
        throw new ActionError('TARGET_NOT_FOUND', `Could not find player ${player_name}`, { playerName: player_name })
      }
      await skills.attackEntity(mineflayer, player, true)
      return `Attacked player [${player_name}]`
    },
  },
  {
    name: 'goToBed',
    description: 'Go to the nearest bed and sleep.',
    execution: 'async',
    schema: z.object({}),
    perform: mineflayer => async () => {
      await skills.goToBed(mineflayer)
      return 'Slept in a bed'
    },
  },
  {
    name: 'activate',
    description: 'Activate the nearest object of a given type.',
    execution: 'async',
    schema: z.object({
      type: z.string().describe('The type of object to activate.'),
    }),
    perform: mineflayer => async (type: string) => {
      await activateNearestBlock(mineflayer, type)
      return `Activated nearest [${type}]`
    },
  },
  {
    name: 'recipePlan',
    description: 'Plan how to craft an item without crafting. Prefer craftRecipe with mode=plan when using the companion craft capability.',
    execution: 'sync',
    schema: z.object({
      item_name: z.string().describe('The name of the item you want to craft (e.g., "diamond_pickaxe", "oak_planks").'),
      amount: z.number().int().min(1).default(1).describe('How many of the item you want to craft.'),
    }),
    perform: mineflayer => (item_name: string, amount: number = 1): string => {
      return pad(describeRecipePlan(mineflayer.bot, item_name, amount))
    },
  },
]
