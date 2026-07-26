import type {
  GameActionEvent,
  GameActionEventListener,
  GameAdapter,
  GameCapability,
  GameCommand,
  GameObservation,
  GameObservationListener,
  JsonValue,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import type { TaskExecutor } from '../cognitive/action/task-executor'
import type { ReflexManager } from '../cognitive/reflex/reflex-manager'
import type { MineflayerWithAgents } from '../cognitive/types'

import { errorMessageFrom } from '@moeru/std'

import * as v from 'valibot'

const capabilityIds = {
  status: 'minecraft.status',
  follow: 'minecraft.follow',
  move: 'minecraft.move',
  collect: 'minecraft.collect',
  interact: 'minecraft.interact',
  say: 'minecraft.say',
  stop: 'minecraft.stop',
  come: 'minecraft.come',
  give: 'minecraft.give',
  equip: 'minecraft.equip',
  eat: 'minecraft.eat',
  sleep: 'minecraft.sleep',
  craft: 'minecraft.craft',
  smelt: 'minecraft.smelt',
  clearFurnace: 'minecraft.clear_furnace',
  place: 'minecraft.place',
  attack: 'minecraft.attack',
  chest: 'minecraft.chest',
  discard: 'minecraft.discard',
  mineAt: 'minecraft.mine_at',
  look: 'minecraft.look',
  gotoBlock: 'minecraft.goto_block',
  gotoEntity: 'minecraft.goto_entity',
  moveAway: 'minecraft.move_away',
  digDown: 'minecraft.dig_down',
  gotoSurface: 'minecraft.goto_surface',
  farm: 'minecraft.farm',
  waypoint: 'minecraft.waypoint',
} as const

const emptyInputSchema = v.strictObject({})
const followInputSchema = v.strictObject({
  playerName: v.pipe(v.string(), v.trim(), v.minLength(1)),
  distance: v.optional(v.pipe(v.number(), v.minValue(0)), 2),
})

/**
 * One TaskExecutor-backed capability: catalog metadata + input mapping.
 *
 * Inspired by Voyager control primitives / MineDojo harvest-craft-combat
 * taxonomy, but kept as thin GameAdapter capabilities (no planner in L3).
 */
interface MinecraftTaskBinding {
  capability: GameCapability
  /** Registered TaskExecutor tool name from `llm-actions`. */
  tool: string
  /**
   * Validate command.input and map to TaskExecutor params.
   * Return null when schema or semantic validation fails.
   */
  toParams: (input: GameCommand['input']) => Record<string, unknown> | null
}

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1))
const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1))

function taskCapability(
  capability: GameCapability,
  tool: string,
  schema: v.GenericSchema<Record<string, unknown>>,
  toParams: (output: Record<string, unknown>) => Record<string, unknown> | null,
): MinecraftTaskBinding {
  return {
    capability,
    tool,
    toParams: (input) => {
      const parsed = v.safeParse(schema, input)
      if (!parsed.success)
        return null
      return toParams(parsed.output)
    },
  }
}

const capabilities: GameCapability[] = [
  {
    capabilityId: capabilityIds.status,
    description: 'Get current Minecraft bot status and follow state.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    risk: 'low',
    cancellable: false,
  },
  {
    capabilityId: capabilityIds.follow,
    description: 'Continuously follow a visible Minecraft player.',
    inputSchema: {
      type: 'object',
      properties: {
        playerName: {
          type: 'string',
          minLength: 1,
          description: 'Exact Minecraft player name.',
        },
        distance: {
          type: 'number',
          minimum: 0,
          default: 2,
          description: 'Desired follow distance in blocks.',
        },
      },
      required: ['playerName'],
      additionalProperties: false,
    },
    risk: 'low',
    cancellable: true,
    waitForTerminal: false,
  },
  {
    capabilityId: capabilityIds.stop,
    description: 'Stop the active Minecraft follow or task action for this session.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    risk: 'low',
    cancellable: false,
  },
]

/**
 * Companion-oriented TaskExecutor bindings.
 *
 * Risk policy: cooperative social/survival helpers stay `low`; world-changing
 * gather/craft/combat/chest ops are `medium` (Companion MCP must allow medium).
 * Player-vs-player attack stays out of the catalog (high / out of MVP scope).
 */
const taskBindings: MinecraftTaskBinding[] = [
  taskCapability(
    {
      capabilityId: capabilityIds.move,
      description: 'Move the Minecraft bot to an x,y,z coordinate.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Coordinate formatted as "x,y,z".' },
          closeness: {
            type: 'number',
            minimum: 0,
            default: 1,
            description: 'Allowed distance from the target in blocks.',
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
    },
    'goToCoordinate',
    v.strictObject({
      target: nonEmptyString,
      closeness: v.optional(v.pipe(v.number(), v.minValue(0)), 1),
    }),
    (output) => {
      const target = parseCoordinate(String(output.target))
      if (target == null)
        return null
      return { ...target, closeness: output.closeness }
    },
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.come,
      description: 'Walk once to a visible Minecraft player (does not keep following). For mobs use goto_entity. To keep following use follow.',
      inputSchema: {
        type: 'object',
        properties: {
          playerName: {
            type: 'string',
            minLength: 1,
            description: 'Exact Minecraft player name to approach.',
          },
          closeness: {
            type: 'number',
            minimum: 0,
            default: 2,
            description: 'How close to stop near the player, in blocks.',
          },
        },
        required: ['playerName'],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
    },
    'goToPlayer',
    v.strictObject({
      playerName: nonEmptyString,
      closeness: v.optional(v.pipe(v.number(), v.minValue(0)), 2),
    }),
    output => ({
      player_name: output.playerName,
      closeness: output.closeness,
    }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.collect,
      description: 'Collect nearby blocks of one type (search+dig+pickup). For a known coordinate use mine_at. To only walk to a block without digging use goto_block.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Block id (e.g. "oak_log") or wood alias ("wood" / "log" / "tree"). Prefer environment.nearestLog when chopping trees.',
          },
          count: { type: 'integer', minimum: 1, default: 1 },
        },
        required: ['target'],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: true,
    },
    'collectBlocks',
    v.strictObject({
      target: nonEmptyString,
      count: v.optional(positiveInt, 1),
    }),
    output => ({ type: output.target, num: output.count }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.interact,
      description: 'Activate the nearest Minecraft object of one type.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Minecraft object or block type.',
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: false,
    },
    'activate',
    v.strictObject({ target: nonEmptyString }),
    output => ({ type: output.target }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.say,
      description: 'Send a Minecraft chat message.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1 },
        },
        required: ['text'],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: false,
    },
    'chat',
    v.strictObject({ text: nonEmptyString }),
    output => ({ message: output.text }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.give,
      description: 'Give items from the bot inventory to a nearby player.',
      inputSchema: {
        type: 'object',
        properties: {
          playerName: {
            type: 'string',
            minLength: 1,
            description: 'Exact Minecraft player name.',
          },
          itemName: {
            type: 'string',
            minLength: 1,
            description: 'Item id to give, for example "cooked_beef".',
          },
          count: { type: 'integer', minimum: 1, default: 1 },
        },
        required: ['playerName', 'itemName'],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
    },
    'givePlayer',
    v.strictObject({
      playerName: nonEmptyString,
      itemName: nonEmptyString,
      count: v.optional(positiveInt, 1),
    }),
    output => ({
      player_name: output.playerName,
      item_name: output.itemName,
      num: output.count,
    }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.equip,
      description: 'Equip an item from inventory (tool, weapon, or armor).',
      inputSchema: {
        type: 'object',
        properties: {
          itemName: {
            type: 'string',
            minLength: 1,
            description: 'Item id to equip.',
          },
        },
        required: ['itemName'],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: false,
    },
    'equip',
    v.strictObject({ itemName: nonEmptyString }),
    output => ({ item_name: output.itemName }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.eat,
      description: 'Eat or drink an item from inventory.',
      inputSchema: {
        type: 'object',
        properties: {
          itemName: {
            type: 'string',
            minLength: 1,
            description: 'Consumable item id.',
          },
        },
        required: ['itemName'],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: false,
    },
    'consume',
    v.strictObject({ itemName: nonEmptyString }),
    output => ({ item_name: output.itemName }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.sleep,
      description: 'Go to the nearest bed and sleep when night allows.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
    },
    'goToBed',
    emptyInputSchema,
    () => ({}),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.craft,
      description: 'Craft an item or plan materials. mode=plan lists requirements without crafting; mode=execute crafts (finds/places table as needed). Do not use a separate recipe tool.',
      inputSchema: {
        type: 'object',
        properties: {
          itemName: {
            type: 'string',
            minLength: 1,
            description: 'Output item id to craft or plan.',
          },
          count: {
            type: 'integer',
            minimum: 1,
            default: 1,
            description: 'Recipe runs for execute, or desired amount for plan.',
          },
          mode: {
            type: 'string',
            enum: ['plan', 'execute'],
            default: 'execute',
            description: 'plan = material plan only; execute = craft.',
          },
        },
        required: ['itemName'],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: true,
    },
    'craftRecipe',
    v.strictObject({
      itemName: nonEmptyString,
      count: v.optional(positiveInt, 1),
      mode: v.optional(v.picklist(['plan', 'execute'] as const), 'execute'),
    }),
    output => ({
      recipe_name: output.itemName,
      num: output.count,
      mode: output.mode,
    }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.smelt,
      description: 'Smelt an input item in the nearest furnace.',
      inputSchema: {
        type: 'object',
        properties: {
          itemName: {
            type: 'string',
            minLength: 1,
            description: 'Input item id to smelt.',
          },
          count: { type: 'integer', minimum: 1, default: 1 },
        },
        required: ['itemName'],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: true,
    },
    'smeltItem',
    v.strictObject({
      itemName: nonEmptyString,
      count: v.optional(positiveInt, 1),
    }),
    output => ({ item_name: output.itemName, num: output.count }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.clearFurnace,
      description: 'Take all items out of the nearest furnace.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
    },
    'clearFurnace',
    emptyInputSchema,
    () => ({}),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.place,
      description: 'Place a single block/torch at optional x,y,z (omit target = under feet). Not for multi-block builds. For farming use farm.',
      inputSchema: {
        type: 'object',
        properties: {
          blockType: {
            type: 'string',
            minLength: 1,
            description: 'Block id to place, for example "torch".',
          },
          target: {
            type: 'string',
            description: 'Optional coordinate "x,y,z". Omit to place at feet.',
          },
        },
        required: ['blockType'],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: false,
    },
    'placeAt',
    v.strictObject({
      blockType: nonEmptyString,
      target: v.optional(nonEmptyString),
    }),
    (output) => {
      if (output.target == null || String(output.target).trim() === '')
        return { type: output.blockType }
      const coords = parseCoordinate(String(output.target))
      if (coords == null)
        return null
      return { type: output.blockType, ...coords }
    },
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.attack,
      description: 'Attack and try to kill the nearest entity of one mob type. To only approach a mob use goto_entity. For players use come/follow.',
      inputSchema: {
        type: 'object',
        properties: {
          entityType: {
            type: 'string',
            minLength: 1,
            description: 'Entity type, for example "zombie" or "cow".',
          },
        },
        required: ['entityType'],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: true,
    },
    'attack',
    v.strictObject({ entityType: nonEmptyString }),
    output => ({ type: output.entityType }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.chest,
      description: 'Nearest chest: action put|take|view. view lists contents. put/take need itemName. Do not use interact for chest inventory.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['put', 'take', 'view'],
            description: 'put items in, take items out, or view contents.',
          },
          itemName: {
            type: 'string',
            minLength: 1,
            description: 'Required for put/take.',
          },
          count: { type: 'integer', minimum: 1, default: 1 },
        },
        required: ['action'],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: true,
    },
    'chest',
    v.strictObject({
      action: v.picklist(['put', 'take', 'view'] as const),
      itemName: v.optional(nonEmptyString),
      count: v.optional(positiveInt, 1),
    }),
    (output) => {
      if (output.action === 'view')
        return { action: 'view' }
      if (output.itemName == null || String(output.itemName).trim() === '')
        return null
      return {
        action: output.action,
        item_name: output.itemName,
        num: output.count,
      }
    },
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.discard,
      description: 'Discard items from the bot inventory onto the ground.',
      inputSchema: {
        type: 'object',
        properties: {
          itemName: { type: 'string', minLength: 1 },
          count: { type: 'integer', minimum: 1, default: 1 },
        },
        required: ['itemName'],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: false,
    },
    'discard',
    v.strictObject({
      itemName: nonEmptyString,
      count: v.optional(positiveInt, 1),
    }),
    output => ({ item_name: output.itemName, num: output.count }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.mineAt,
      description: 'Break one block at exact coordinates. For searching nearby resources use collect. To only walk to a block type use goto_block.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Coordinate "x,y,z".' },
          expectedBlockType: {
            type: 'string',
            description: 'Optional expected block id; fails on mismatch.',
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: true,
    },
    'mineBlockAt',
    v.strictObject({
      target: nonEmptyString,
      expectedBlockType: v.optional(nonEmptyString),
    }),
    (output) => {
      const coords = parseCoordinate(String(output.target))
      if (coords == null)
        return null
      return {
        ...coords,
        ...(output.expectedBlockType != null
          ? { expected_block_type: output.expectedBlockType }
          : {}),
      }
    },
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.look,
      description: 'Look at a player by name OR at coordinates. Provide playerName or target, not both.',
      inputSchema: {
        type: 'object',
        properties: {
          playerName: { type: 'string', minLength: 1 },
          target: { type: 'string', description: 'Coordinate "x,y,z".' },
        },
        required: [],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: false,
    },
    'lookAt',
    v.strictObject({
      playerName: v.optional(nonEmptyString),
      target: v.optional(nonEmptyString),
    }),
    (output) => {
      const hasPlayer = output.playerName != null && String(output.playerName).trim() !== ''
      const hasTarget = output.target != null && String(output.target).trim() !== ''
      if (hasPlayer === hasTarget)
        return null
      if (hasPlayer)
        return { player_name: output.playerName }
      const coords = parseCoordinate(String(output.target))
      if (coords == null)
        return null
      return coords
    },
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.gotoBlock,
      description: 'Walk to the nearest block of a type without mining. To dig/collect that type use collect.',
      inputSchema: {
        type: 'object',
        properties: {
          blockType: { type: 'string', minLength: 1 },
          closeness: { type: 'number', minimum: 0, default: 2 },
          range: { type: 'number', minimum: 1, default: 64 },
        },
        required: ['blockType'],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
    },
    'goToNearestBlock',
    v.strictObject({
      blockType: nonEmptyString,
      closeness: v.optional(v.pipe(v.number(), v.minValue(0)), 2),
      range: v.optional(v.pipe(v.number(), v.minValue(1)), 64),
    }),
    output => ({
      type: output.blockType,
      closeness: output.closeness,
      range: output.range,
    }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.gotoEntity,
      description: 'Walk next to the nearest entity of a type without attacking. To fight use attack. For a named player use come.',
      inputSchema: {
        type: 'object',
        properties: {
          entityType: { type: 'string', minLength: 1 },
          closeness: { type: 'number', minimum: 0, default: 2 },
          range: { type: 'number', minimum: 1, default: 64 },
        },
        required: ['entityType'],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
    },
    'goToNearestEntity',
    v.strictObject({
      entityType: nonEmptyString,
      closeness: v.optional(v.pipe(v.number(), v.minValue(0)), 2),
      range: v.optional(v.pipe(v.number(), v.minValue(1)), 64),
    }),
    output => ({
      type: output.entityType,
      closeness: output.closeness,
      range: output.range,
    }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.moveAway,
      description: 'Move roughly away from the current spot. For a specific coordinate use move.',
      inputSchema: {
        type: 'object',
        properties: {
          distance: { type: 'number', minimum: 1, default: 16 },
        },
        required: [],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
    },
    'moveAway',
    v.strictObject({
      distance: v.optional(v.pipe(v.number(), v.minValue(1)), 16),
    }),
    output => ({ distance: output.distance }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.digDown,
      description: 'Dig straight down under the bot. For one known block use mine_at. For gathering a resource type use collect.',
      inputSchema: {
        type: 'object',
        properties: {
          depth: { type: 'integer', minimum: 1, maximum: 64, default: 1 },
        },
        required: [],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: true,
    },
    'digDown',
    v.strictObject({
      depth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)), 1),
    }),
    output => ({ depth: output.depth }),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.gotoSurface,
      description: 'Pathfind to the surface above the current x,z. For arbitrary coordinates use move.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      risk: 'low',
      cancellable: true,
    },
    'goToSurface',
    emptyInputSchema,
    () => ({}),
  ),
  taskCapability(
    {
      capabilityId: capabilityIds.farm,
      description: 'Till dirt/grass at a coordinate and optionally plant seeds. Not for placing torches (use place) or collecting crops (use collect).',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Coordinate "x,y,z" of the dirt/grass block.' },
          seedType: {
            type: 'string',
            description: 'Optional seed item id, e.g. wheat_seeds.',
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
      risk: 'medium',
      cancellable: true,
    },
    'tillAndSow',
    v.strictObject({
      target: nonEmptyString,
      seedType: v.optional(nonEmptyString),
    }),
    (output) => {
      const coords = parseCoordinate(String(output.target))
      if (coords == null)
        return null
      return {
        ...coords,
        ...(output.seedType != null ? { seed_type: output.seedType } : {}),
      }
    },
  ),
]

const waypointCapability: GameCapability = {
  capabilityId: capabilityIds.waypoint,
  description: 'Named landmarks for this session. action=set stores current position as name; action=goto pathfinds to a saved name. For raw coordinates use move.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'goto'],
      },
      name: {
        type: 'string',
        minLength: 1,
        description: 'Waypoint name.',
      },
    },
    required: ['action', 'name'],
    additionalProperties: false,
  },
  risk: 'low',
  cancellable: true,
}

const taskBindingsById = new Map(
  taskBindings.map(binding => [binding.capability.capabilityId, binding]),
)
const taskCapabilities = [...taskBindings.map(binding => binding.capability), waypointCapability]

/** Game-specific state exposed through status and lifecycle snapshots. */
export interface MinecraftSnapshot extends Record<string, JsonValue> {
  connected: boolean
  username: string
  position: { x: number, y: number, z: number } | null
  health: number | null
  food: number | null
  weather: string
  time: string
  follow: {
    playerName: string | null
    distance: number
    active: boolean
    error: string | null
  }
}

/** One nearby collectible/resource block sample for upper intelligence. */
export interface MinecraftNearbyBlock extends Record<string, JsonValue> {
  name: string
  distance: number
}

/**
 * Read-only environment content exposed through `getEnvironment`.
 *
 * Superset of the status capability payload: adds the light level and nearby
 * hostile count so upper intelligence can reason about danger without an
 * action round-trip. Absent numeric senses stay `null`, never fabricated.
 */
export interface MinecraftEnvironment extends Record<string, JsonValue> {
  connected: boolean
  username: string
  /** Configured owner identity used to resolve player references such as "我" or "主人". */
  masterUsername: string | null
  /** Current server player names excluding the bot itself. */
  playersOnline: string[]
  position: { x: number, y: number, z: number } | null
  health: number | null
  food: number | null
  weather: string
  time: string
  lightLevel: number | null
  nearbyHostiles: number | null
  /**
   * Nearby resource blocks (logs, ores, workstations), nearest first.
   * Empty means none sampled in range — never invent ids from this absence.
   */
  nearbyBlocks: MinecraftNearbyBlock[]
  /** Nearest log/stem block id within the sample radius, or null when none. */
  nearestLog: string | null
}

/** One raw damage/death tick produced by the driver's world listener. */
export interface MinecraftWorldEvent {
  kind: 'hurt' | 'death'
  health: number | null
  damage?: number
  /** Exact attacker from Mineflayer's `entityHurt` damage packet, when the server reports one. */
  attacker?: MinecraftWorldAttacker
}

/** Attacker identity carried by the 1.20+ `damage_event` packet. */
export interface MinecraftWorldAttacker {
  /** Entity category reported by Mineflayer, e.g. `'player'` or `'hostile'`. */
  type?: string
  /** Entity type name, e.g. `'zombie'`. Present for mobs, absent for players. */
  name?: string
  /** Player username. Present only when the attacker is a player. */
  username?: string
}

/** Built-in world observation kinds emitted by this adapter. */
export const minecraftObservationKinds = {
  botHurt: 'minecraft.bot.hurt',
  botDeath: 'minecraft.bot.death',
  playerAttack: 'minecraft.player.attack',
  mobAttack: 'minecraft.mob.attack',
} as const

/**
 * How built-in world observation kinds map to GameObservation urgency.
 * Death is the only critical event; a direct player attack outranks mob and
 * ambient damage because it usually signals user intent.
 */
const observationUrgency: Record<string, GameObservation['urgency']> = {
  [minecraftObservationKinds.botHurt]: 'high',
  [minecraftObservationKinds.botDeath]: 'critical',
  [minecraftObservationKinds.playerAttack]: 'high',
  [minecraftObservationKinds.mobAttack]: 'normal',
}

/**
 * Native Minecraft operations consumed by the adapter.
 *
 * This boundary keeps Mineflayer and reflex runtime types out of adapter tests
 * while preserving their existing execution behavior in production.
 */
export interface MinecraftGameDriver {
  getSnapshot: () => MinecraftSnapshot
  follow: (playerName: string, distance: number) => void
  stopFollow: () => void
  /** Executes one registered TaskExecutor action when that runtime is available. */
  executeAction?: (tool: string, params: Record<string, unknown>) => Promise<JsonValue | undefined>
  /** Interrupts a cancellable TaskExecutor action. */
  stopAction?: () => Promise<void>
  /**
   * Read-only environment sample for `getEnvironment`. Missing method means
   * the adapter exposes no environment snapshot (contract-optional).
   */
  getEnvironment?: () => MinecraftEnvironment
  /**
   * Subscribe to native damage/death ticks and periodic environment revisions.
   * Returns one unsubscribe that must detach every listener it registered.
   */
  observeEnvironment?: (listener: MinecraftEnvironmentListener) => Unsubscribe
}

/**
 * Driver-side environment listener. `kind: 'tick'` carries no event payload;
 * it only signals that the environment revision may have advanced.
 */
export type MinecraftEnvironmentListener
  = (event: { kind: 'tick' } | { kind: 'event', event: MinecraftWorldEvent }) => void

/** Stable adapter ID shared with the remote registry proxy. */
export const minecraftAdapterId = 'minecraft'

/**
 * Max age upper intelligence should accept from one environment snapshot.
 * Matches the Mineflayer tick cadence: anything older means the driver stopped sampling.
 */
const environmentFreshnessMs = 1_000

/**
 * Minimum gap between two observations of the same kind. Damage ticks can
 * arrive in bursts (multiple hearts in one tick); world-level flood policy
 * stays with the Companion Agent, but identical sub-tick duplicates are noise.
 */
const worldObservationThrottleMs = 1_000

export interface MinecraftGameAdapterOptions {
  driver: MinecraftGameDriver
  /**
   * Clock used for lifecycle event timestamps.
   * @default Date.now
   */
  now?: () => number
}

interface ActiveFollow {
  command: GameCommand
}

interface ActiveTask {
  command: GameCommand
}

/**
 * Adapts one Mineflayer bot to the game-neutral execution contract.
 *
 * Follow is a long-running action. It remains `running` until a matching
 * cancel, stop command, or replacement follow reaches the adapter.
 *
 * `observeWorld` and `getEnvironment` are contract-optional: when the driver
 * cannot sample the world (tests, replay transports) the methods stay absent
 * so callers can feature-detect them per the GameAdapter contract.
 */
export class MinecraftGameAdapter implements GameAdapter {
  private readonly listenersBySession = new Map<string, Set<GameActionEventListener>>()
  private readonly observationListenersBySession = new Map<string, Set<GameObservationListener>>()
  private readonly now: () => number
  private activeFollow: ActiveFollow | null = null
  private activeTask: ActiveTask | null = null
  /** Session-scoped named landmarks for minecraft.waypoint. */
  private readonly waypointsBySession = new Map<string, Map<string, { x: number, y: number, z: number }>>()
  private unsubscribeEnvironment: Unsubscribe | null = null
  private worldSequence = 0
  private environmentRevision = 0
  // NOTICE: -Infinity, not 0 — with a fixed test clock (`now: () => 0`) a
  // first event at t=0 must not be swallowed by the throttle window.
  private lastHurtObservedAt = Number.NEGATIVE_INFINITY
  private lastPlayerAttackObservedAt = Number.NEGATIVE_INFINITY

  public readonly observeWorld?: GameAdapter['observeWorld']
  public readonly getEnvironment?: GameAdapter['getEnvironment']

  constructor(private readonly options: MinecraftGameAdapterOptions) {
    this.now = options.now ?? Date.now

    if (options.driver.observeEnvironment != null) {
      this.observeWorld = (sessionId, listener) => this.subscribeWorld(sessionId, listener)
    }
    if (options.driver.getEnvironment != null) {
      this.getEnvironment = async sessionId => ({
        sessionId,
        adapterId: minecraftAdapterId,
        observedAt: this.now(),
        freshnessMs: environmentFreshnessMs,
        revision: String(this.environmentRevision),
        content: options.driver.getEnvironment!(),
      })
    }
  }

  public async getCapabilities(_sessionId: string): Promise<GameCapability[]> {
    return this.options.driver.executeAction == null
      ? [...capabilities]
      : [...capabilities, ...taskCapabilities]
  }

  public observe(sessionId: string, listener: GameActionEventListener): Unsubscribe {
    const listeners = this.listenersBySession.get(sessionId) ?? new Set<GameActionEventListener>()
    listeners.add(listener)
    this.listenersBySession.set(sessionId, listeners)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0)
        this.listenersBySession.delete(sessionId)
    }
  }

  private subscribeWorld(sessionId: string, listener: GameObservationListener): Unsubscribe {
    this.ensureEnvironmentListener()
    const listeners = this.observationListenersBySession.get(sessionId) ?? new Set<GameObservationListener>()
    listeners.add(listener)
    this.observationListenersBySession.set(sessionId, listeners)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0)
        this.observationListenersBySession.delete(sessionId)
      this.releaseEnvironmentListenerIfIdle()
    }
  }

  public async execute(command: GameCommand): Promise<void> {
    this.emit({ ...this.eventBase(command), state: 'queued' })

    if (command.capabilityId === capabilityIds.status) {
      this.executeStatus(command)
      return
    }
    if (command.capabilityId === capabilityIds.follow) {
      this.executeFollow(command)
      return
    }
    if (command.capabilityId === capabilityIds.stop) {
      await this.executeStop(command)
      return
    }
    if (command.capabilityId === capabilityIds.waypoint) {
      await this.executeWaypoint(command)
      return
    }

    const binding = taskBindingsById.get(command.capabilityId)
    if (binding != null) {
      const params = binding.toParams(command.input)
      if (params == null) {
        this.emitInvalidInput(command)
        return
      }
      await this.executeTask(
        command,
        binding.tool,
        params,
        binding.capability.cancellable,
      )
      return
    }

    this.emit({
      ...this.eventBase(command),
      state: 'failed',
      error: `Unsupported Minecraft capability "${command.capabilityId}"`,
    })
  }

  public async cancel(actionId: string, reason?: string): Promise<void> {
    if (this.activeTask?.command.actionId === actionId) {
      const task = this.activeTask
      this.activeTask = null
      try {
        await this.options.driver.stopAction?.()
      }
      catch (error) {
        this.emit({
          ...this.eventBase(task.command),
          state: 'failed',
          error: errorMessageFrom(error) ?? 'Failed to stop Minecraft task action',
        })
        throw error
      }
      this.emit({
        ...this.eventBase(task.command),
        state: 'cancelled',
        reason,
      })
      return
    }

    if (this.activeFollow?.command.actionId !== actionId)
      return

    const follow = this.activeFollow
    try {
      this.options.driver.stopFollow()
    }
    catch (error) {
      this.activeFollow = null
      this.emit({
        ...this.eventBase(follow.command),
        state: 'failed',
        error: errorMessageFrom(error) ?? 'Failed to stop Minecraft follow action',
      })
      throw error
    }

    this.activeFollow = null
    this.emit({
      ...this.eventBase(follow.command),
      state: 'cancelled',
      reason,
    })
  }

  private executeStatus(command: GameCommand): void {
    const parsed = v.safeParse(emptyInputSchema, command.input)
    if (!parsed.success) {
      this.emitInvalidInput(command)
      return
    }

    this.emit({ ...this.eventBase(command), state: 'running' })
    let snapshot: MinecraftSnapshot
    try {
      snapshot = this.options.driver.getSnapshot()
    }
    catch (error) {
      this.emitFailure(command, error, 'Failed to read Minecraft status')
      return
    }

    this.emit({
      ...this.eventBase(command),
      state: 'snapshot',
      snapshot,
    })
    this.emit({
      ...this.eventBase(command),
      state: 'succeeded',
      result: snapshot,
    })
  }

  private executeFollow(command: GameCommand): void {
    const parsed = v.safeParse(followInputSchema, command.input)
    if (!parsed.success) {
      this.emitInvalidInput(command)
      return
    }

    const activeCommand = this.activeFollow?.command ?? this.activeTask?.command
    if (activeCommand != null && activeCommand.sessionId !== command.sessionId) {
      this.emit({
        ...this.eventBase(command),
        state: 'failed',
        error: 'Minecraft bot is controlled by another session',
      })
      return
    }
    if (this.activeTask != null) {
      this.emit({
        ...this.eventBase(command),
        state: 'failed',
        error: 'Minecraft task must finish or be cancelled before follow can start',
      })
      return
    }

    if (this.activeFollow != null) {
      const replaced = this.activeFollow
      try {
        this.options.driver.stopFollow()
      }
      catch (error) {
        this.emitFailure(command, error, 'Failed to replace Minecraft follow action')
        return
      }
      this.activeFollow = null
      this.emit({
        ...this.eventBase(replaced.command),
        state: 'cancelled',
        reason: 'Replaced by a newer follow action',
      })
    }

    try {
      this.options.driver.follow(parsed.output.playerName, parsed.output.distance)
    }
    catch (error) {
      this.emitFailure(command, error, 'Failed to start Minecraft follow action')
      return
    }

    this.activeFollow = { command }
    this.emit({ ...this.eventBase(command), state: 'running' })
  }

  private async executeTask(
    command: GameCommand,
    tool: string,
    params: Record<string, unknown>,
    cancellable: boolean,
  ): Promise<void> {
    const executeAction = this.options.driver.executeAction
    if (executeAction == null) {
      this.emitFailure(command, new Error('Minecraft TaskExecutor is unavailable'), 'Minecraft TaskExecutor is unavailable')
      return
    }

    if (cancellable) {
      const activeCommand = this.activeFollow?.command ?? this.activeTask?.command
      if (activeCommand != null && activeCommand.sessionId !== command.sessionId) {
        this.emit({
          ...this.eventBase(command),
          state: 'failed',
          error: 'Minecraft bot is controlled by another session',
        })
        return
      }
      if (this.activeTask != null) {
        this.emit({
          ...this.eventBase(command),
          state: 'failed',
          error: 'Another Minecraft task is already running',
        })
        return
      }

      if (this.activeFollow != null) {
        const follow = this.activeFollow
        try {
          this.options.driver.stopFollow()
        }
        catch (error) {
          this.emitFailure(command, error, 'Failed to stop Minecraft follow before task execution')
          return
        }
        this.activeFollow = null
        this.emit({
          ...this.eventBase(follow.command),
          state: 'cancelled',
          reason: `Replaced by action "${command.actionId}"`,
        })
      }
    }

    if (cancellable)
      this.activeTask = { command }
    this.emit({ ...this.eventBase(command), state: 'running' })

    try {
      const result = await executeAction(tool, params)
      if (cancellable && this.activeTask?.command.actionId !== command.actionId)
        return
      if (cancellable)
        this.activeTask = null
      this.emit({
        ...this.eventBase(command),
        state: 'succeeded',
        result,
      })
    }
    catch (error) {
      if (cancellable && this.activeTask?.command.actionId !== command.actionId)
        return
      if (cancellable)
        this.activeTask = null
      this.emitFailure(command, error, `Minecraft action "${tool}" failed`)
    }
  }

  private async executeWaypoint(command: GameCommand): Promise<void> {
    const parsed = v.safeParse(
      v.strictObject({
        action: v.picklist(['set', 'goto'] as const),
        name: nonEmptyString,
      }),
      command.input,
    )
    if (!parsed.success) {
      this.emitInvalidInput(command)
      return
    }

    const { action, name } = parsed.output
    const sessionWaypoints = this.waypointsBySession.get(command.sessionId)
      ?? new Map<string, { x: number, y: number, z: number }>()

    if (action === 'set') {
      const snapshot = this.options.driver.getSnapshot()
      const position = snapshot.position
      if (position == null) {
        this.emit({
          ...this.eventBase(command),
          state: 'failed',
          error: 'Cannot set waypoint without a known bot position',
        })
        return
      }
      sessionWaypoints.set(name, {
        x: position.x,
        y: position.y,
        z: position.z,
      })
      this.waypointsBySession.set(command.sessionId, sessionWaypoints)
      this.emit({ ...this.eventBase(command), state: 'running' })
      this.emit({
        ...this.eventBase(command),
        state: 'succeeded',
        result: {
          action: 'set',
          name,
          position: { x: position.x, y: position.y, z: position.z },
        },
      })
      return
    }

    const saved = sessionWaypoints.get(name)
    if (saved == null) {
      this.emit({
        ...this.eventBase(command),
        state: 'failed',
        error: `Unknown waypoint "${name}"`,
      })
      return
    }

    await this.executeTask(
      command,
      'goToCoordinate',
      { ...saved, closeness: 1 },
      true,
    )
  }

  private async executeStop(command: GameCommand): Promise<void> {
    const parsed = v.safeParse(emptyInputSchema, command.input)
    if (!parsed.success) {
      this.emitInvalidInput(command)
      return
    }

    this.emit({ ...this.eventBase(command), state: 'running' })
    const follow = this.activeFollow?.command.sessionId === command.sessionId
      ? this.activeFollow
      : null
    const task = this.activeTask?.command.sessionId === command.sessionId
      ? this.activeTask
      : null
    if (task != null)
      this.activeTask = null

    try {
      // No tracked action can still mean legacy Reflex/Brain follow is active.
      // A follow owned by another Coop session remains isolated.
      if (this.activeFollow == null || follow != null)
        this.options.driver.stopFollow()
      if (task != null)
        await this.options.driver.stopAction?.()
    }
    catch (error) {
      if (task != null)
        this.emitFailure(task.command, error, 'Failed to stop Minecraft task action')
      this.emitFailure(command, error, 'Failed to stop Minecraft action')
      return
    }

    if (follow != null) {
      this.activeFollow = null
      this.emit({
        ...this.eventBase(follow.command),
        state: 'cancelled',
        reason: `Stopped by action "${command.actionId}"`,
      })
    }
    if (task != null) {
      this.emit({
        ...this.eventBase(task.command),
        state: 'cancelled',
        reason: `Stopped by action "${command.actionId}"`,
      })
    }

    this.emit({
      ...this.eventBase(command),
      state: 'succeeded',
      result: {
        stoppedActionIds: [
          follow?.command.actionId,
          task?.command.actionId,
        ].filter((actionId): actionId is string => actionId != null),
      },
    })
  }

  private emitInvalidInput(command: GameCommand): void {
    this.emit({
      ...this.eventBase(command),
      state: 'failed',
      error: `Invalid input for "${command.capabilityId}"`,
    })
  }

  private emitFailure(command: GameCommand, error: unknown, fallback: string): void {
    this.emit({
      ...this.eventBase(command),
      state: 'failed',
      error: errorMessageFrom(error) ?? fallback,
    })
  }

  private eventBase(command: GameCommand) {
    return {
      sessionId: command.sessionId,
      turnId: command.turnId,
      actionId: command.actionId,
      capabilityId: command.capabilityId,
      timestamp: this.now(),
    }
  }

  private emit(event: GameActionEvent): void {
    for (const listener of this.listenersBySession.get(event.sessionId) ?? [])
      listener(event)
  }

  /**
   * Attaches the driver's native listeners on the first world subscriber and
   * detaches once the last one leaves. Bot health events keep flowing even
   * when nobody listens, so skipping attachment avoids unbounded revision churn.
   */
  private ensureEnvironmentListener(): void {
    if (this.unsubscribeEnvironment != null || this.options.driver.observeEnvironment == null)
      return
    this.unsubscribeEnvironment = this.options.driver.observeEnvironment((event) => {
      this.environmentRevision += 1
      if (event.kind === 'event')
        this.handleWorldEvent(event.event)
    })
  }

  private releaseEnvironmentListenerIfIdle(): void {
    if (this.observationListenersBySession.size > 0)
      return
    this.unsubscribeEnvironment?.()
    this.unsubscribeEnvironment = null
  }

  /**
   * Normalizes one raw driver tick into observation kinds. Attribution comes
   * from the server's damage packet (entityHurt source), never from a
   * nearest-entity guess: a player standing nearby while a skeleton shoots
   * must not be blamed for the arrow.
   */
  private handleWorldEvent(event: MinecraftWorldEvent): void {
    if (event.kind === 'death') {
      this.emitObservation({
        kind: minecraftObservationKinds.botDeath,
        text: 'Bot died.',
        dedupeKey: `death:${this.worldSequence++}`,
        data: { health: event.health },
      })
      return
    }

    const observedAt = this.now()
    const attacker = event.attacker
    if (attacker?.type === 'player' && attacker.username != null) {
      if (observedAt - this.lastPlayerAttackObservedAt < worldObservationThrottleMs)
        return
      this.lastPlayerAttackObservedAt = observedAt
      this.emitObservation({
        kind: minecraftObservationKinds.playerAttack,
        text: `Player ${attacker.username} attacked the bot (${event.damage ?? '?'} damage, health ${event.health ?? '?'}).`,
        dedupeKey: `player-attack:${attacker.username}:${this.worldSequence++}`,
        data: { attacker: attacker.username, health: event.health, damage: event.damage ?? null },
      })
      return
    }

    if (attacker != null && attacker.type !== 'player') {
      if (observedAt - this.lastHurtObservedAt < worldObservationThrottleMs)
        return
      this.lastHurtObservedAt = observedAt
      const source = attacker.name ?? attacker.type ?? 'unknown'
      this.emitObservation({
        kind: minecraftObservationKinds.mobAttack,
        text: `A ${source} attacked the bot (${event.damage ?? '?'} damage, health ${event.health ?? '?'}).`,
        dedupeKey: `mob-attack:${source}:${this.worldSequence++}`,
        data: { attacker: source, health: event.health, damage: event.damage ?? null },
      })
      return
    }

    if (observedAt - this.lastHurtObservedAt < worldObservationThrottleMs)
      return
    this.lastHurtObservedAt = observedAt
    this.emitObservation({
      kind: minecraftObservationKinds.botHurt,
      text: `Bot took ${event.damage ?? '?'} damage (health ${event.health ?? '?'}).`,
      dedupeKey: `hurt:${this.worldSequence++}`,
      data: { health: event.health, damage: event.damage ?? null },
    })
  }

  private emitObservation(
    observation: Pick<GameObservation, 'kind' | 'text' | 'dedupeKey' | 'data'>,
  ): void {
    const full: GameObservation = {
      sessionId: '',
      eventId: `${minecraftAdapterId}:${this.worldSequence}`,
      adapterId: minecraftAdapterId,
      observedAt: this.now(),
      urgency: observationUrgency[observation.kind] ?? 'normal',
      stateRevision: String(this.environmentRevision),
      ...observation,
    }
    for (const [sessionId, listeners] of this.observationListenersBySession) {
      for (const listener of listeners)
        listener({ ...full, sessionId })
    }
  }
}

/**
 * Connects the adapter to the existing Mineflayer and reflex follow runtime.
 *
 * Stop deliberately clears only reflex-owned auto-follow. It does not call the
 * legacy global interrupt path, so unrelated Brain actions remain untouched.
 */
export function createMinecraftGameDriver(
  mineflayer: MineflayerWithAgents,
  reflexManager: ReflexManager,
  taskExecutor: TaskExecutor,
  masterUsername?: string,
): MinecraftGameDriver {
  return {
    getSnapshot() {
      const entity = mineflayer.bot.entity
      const context = reflexManager.getContextSnapshot()
      return {
        connected: mineflayer.ready && entity != null,
        username: mineflayer.bot.username,
        position: entity == null
          ? null
          : {
              x: entity.position.x,
              y: entity.position.y,
              z: entity.position.z,
            },
        health: mineflayer.ready ? mineflayer.bot.health : null,
        food: mineflayer.ready ? mineflayer.bot.food : null,
        weather: context.environment.weather,
        time: context.environment.time,
        follow: {
          playerName: context.autonomy.followPlayer,
          distance: context.autonomy.followDistance,
          active: context.autonomy.followActive,
          error: context.autonomy.followLastError,
        },
      }
    },
    getEnvironment() {
      const entity = mineflayer.bot.entity
      const context = reflexManager.getContextSnapshot()
      const nearbyBlocks = mineflayer.ready && entity != null
        ? sampleNearbyResourceBlocks(mineflayer.bot, 24, 8)
        : []
      return {
        connected: mineflayer.ready && entity != null,
        username: mineflayer.bot.username,
        masterUsername: masterUsername ?? null,
        playersOnline: Object.keys(mineflayer.bot.players)
          .filter(playerName => playerName !== mineflayer.bot.username)
          .sort((left, right) => left.localeCompare(right)),
        position: entity == null
          ? null
          : {
              x: entity.position.x,
              y: entity.position.y,
              z: entity.position.z,
            },
        health: mineflayer.ready ? mineflayer.bot.health : null,
        food: mineflayer.ready ? mineflayer.bot.food : null,
        weather: context.environment.weather,
        time: context.environment.time,
        lightLevel: context.environment.lightLevel,
        // NOTICE: no cheap hostile-count sense exists below the perception
        // pipeline; wiring one is Wave 2 work. Null means "not sampled", never "none".
        nearbyHostiles: null,
        nearbyBlocks,
        nearestLog: nearbyBlocks.find(block => isLogOrStemBlockName(block.name))?.name ?? null,
      }
    },
    observeEnvironment(listener) {
      // Mineflayer's own 'health' handler runs first (registered in
      // setupBotEventHandlers before plugins load), so `health.lastDamage*`
      // already describe this exact health change when our listener runs.
      //
      // Attribution comes from mineflayer's `entityHurt(victim, source)` off
      // the 1.20+ `damage_event` packet: `source` is the entity that dealt
      // the damage. The packet and the health update arrive within a few
      // ticks of each other; 600ms covers the gap without bleeding into the
      // next hit (mirrors perception's attacker-tracker).
      const attackerRecencyMs = 600
      let lastHealth = mineflayer.health.value
      let lastAttacker: { attacker: MinecraftWorldAttacker, at: number } | null = null

      const selfId = () => mineflayer.bot.entity?.id
      const onEntityHurt = (victim: { id?: number } | undefined, source: MinecraftWorldAttacker | undefined) => {
        if (victim?.id == null || victim.id !== selfId() || source == null)
          return
        lastAttacker = { attacker: source, at: Date.now() }
      }
      const recentAttacker = (): MinecraftWorldAttacker | undefined => {
        if (lastAttacker == null || Date.now() - lastAttacker.at > attackerRecencyMs)
          return undefined
        return lastAttacker.attacker
      }

      const onHealth = () => {
        const health = mineflayer.ready ? mineflayer.bot.health : null
        if (health == null || health >= lastHealth) {
          if (health != null)
            lastHealth = health
          listener({ kind: 'tick' })
          return
        }
        const event: MinecraftWorldEvent = {
          kind: 'hurt',
          health,
          damage: mineflayer.health.lastDamageTaken ?? lastHealth - health,
          attacker: recentAttacker(),
        }
        lastHealth = health
        lastAttacker = null
        listener({ kind: 'event', event })
      }
      const onDeath = () => {
        listener({ kind: 'event', event: { kind: 'death', health: 0 } })
      }
      const onTick = () => listener({ kind: 'tick' })

      mineflayer.bot.on('entityHurt', onEntityHurt)
      mineflayer.bot.on('health', onHealth)
      mineflayer.bot.on('death', onDeath)
      mineflayer.onTick('tick', onTick)
      return () => {
        mineflayer.bot.off('entityHurt', onEntityHurt)
        mineflayer.bot.off('health', onHealth)
        mineflayer.bot.off('death', onDeath)
        mineflayer.offTick('tick', onTick)
      }
    },
    follow(playerName, distance) {
      reflexManager.setFollowTarget(playerName, distance)
    },
    stopFollow() {
      reflexManager.clearFollowTarget()
    },
    async executeAction(tool, params) {
      return jsonValueFrom(await taskExecutor.executeActionWithResult({ tool, params }))
    },
    async stopAction() {
      await taskExecutor.executeActionWithResult({ tool: 'stop', params: {} })
    },
  }
}

/**
 * Brain-free construction path for the companion product slice.
 *
 * The adapter depends only on the Mineflayer bot and low-level reflex/task
 * executors — never on the LLM Brain or voice runtime. CognitiveEngine keeps
 * its own inline wiring for now; new hosts (Electron main game bridge) use
 * this factory so the CognitiveEngine plugin is no longer a hard dependency.
 */
export function createMinecraftGameAdapter(
  mineflayer: MineflayerWithAgents,
  reflexManager: ReflexManager,
  taskExecutor: TaskExecutor,
  masterUsername?: string,
): MinecraftGameAdapter {
  return new MinecraftGameAdapter({
    driver: createMinecraftGameDriver(mineflayer, reflexManager, taskExecutor, masterUsername),
  })
}

function parseCoordinate(target: string): { x: number, y: number, z: number } | null {
  const [x, y, z, extra] = target.split(',').map(part => Number(part.trim()))
  if (extra != null || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
    return null
  return { x, y, z }
}

/** True when a block id is a tree trunk the companion should treat as wood. */
function isLogOrStemBlockName(name: string): boolean {
  return name.includes('log') || name.endsWith('_stem')
}

/**
 * Cheap nearby resource sample for Layer 1/2 prompts.
 *
 * Keeps one nearest distance per block name so models can pick real ids
 * (e.g. spruce_log) instead of guessing oak_log.
 */
function sampleNearbyResourceBlocks(
  bot: MineflayerWithAgents['bot'],
  maxDistance: number,
  limit: number,
): MinecraftNearbyBlock[] {
  const entity = bot.entity
  if (entity == null || typeof bot.findBlocks !== 'function')
    return []

  const positions = bot.findBlocks({
    matching: (block) => {
      if (block == null)
        return false
      const name = block.name
      return isLogOrStemBlockName(name)
        || name.includes('_ore')
        || name === 'crafting_table'
        || name === 'furnace'
        || name === 'chest'
    },
    maxDistance,
    count: Math.max(limit * 4, limit),
  })

  const nearestByName = new Map<string, number>()
  for (const position of positions) {
    const block = bot.blockAt(position)
    if (block == null)
      continue
    const distance = Math.round(position.distanceTo(entity.position) * 10) / 10
    const previous = nearestByName.get(block.name)
    if (previous == null || distance < previous)
      nearestByName.set(block.name, distance)
  }

  return [...nearestByName.entries()]
    .map(([name, distance]) => ({ name, distance }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit)
}

function jsonValueFrom(value: unknown): JsonValue | undefined {
  if (value === undefined)
    return undefined
  if (value == null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : String(value)
  if (Array.isArray(value))
    return value.map(jsonValueFrom).filter((item): item is JsonValue => item !== undefined)
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const jsonItem = jsonValueFrom(item)
      if (jsonItem !== undefined)
        result[key] = jsonItem
    }
    return result
  }
  return String(value)
}
