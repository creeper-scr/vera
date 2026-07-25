import type {
  GameAdapter,
  GameCapability,
  GameCapabilityInputSchema,
  GameCommand,
  JsonValue,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

import { ActionEvents } from '../actionEvents'
import {
  arrayValue,
  numberValue,
  objectValue,
  parseJsonObject,
  stringValue,
} from '../json'

const capabilityIds = {
  status: 'stardew.status',
  follow: 'stardew.follow',
  move: 'stardew.move',
  stop: 'stardew.stop',
  interact: 'stardew.interact',
  collect: 'stardew.collect',
  useTool: 'stardew.use_tool',
  say: 'stardew.say',
} as const

const emptyInputSchema: GameCapabilityInputSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

const tileInputSchema: GameCapabilityInputSchema = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description: 'Tile coordinate formatted as "x,y"',
    },
  },
  required: ['target'],
  additionalProperties: false,
}

const capabilities: GameCapability[] = [
  { capabilityId: capabilityIds.status, description: 'Read Stardew Valley player, companion, world, and inventory state', inputSchema: emptyInputSchema, risk: 'low', cancellable: false },
  { capabilityId: capabilityIds.follow, description: 'Continuously follow the player with the configured companion', inputSchema: emptyInputSchema, risk: 'low', cancellable: true },
  { capabilityId: capabilityIds.move, description: 'Move the configured companion to a tile', inputSchema: tileInputSchema, risk: 'low', cancellable: true },
  { capabilityId: capabilityIds.stop, description: 'Stop the configured companion movement', inputSchema: emptyInputSchema, risk: 'low', cancellable: false },
  { capabilityId: capabilityIds.interact, description: 'Interact with an object, crop, chest, or ladder at a tile', inputSchema: tileInputSchema, risk: 'low', cancellable: false },
  { capabilityId: capabilityIds.collect, description: 'Harvest or collect at a tile', inputSchema: tileInputSchema, risk: 'low', cancellable: false },
  {
    capabilityId: capabilityIds.useTool,
    description: 'Use a Stardew Valley tool at a tile',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          enum: ['pickaxe', 'axe', 'hoe', 'watering_can', 'sword'],
        },
        target: {
          type: 'string',
          description: 'Tile coordinate formatted as "x,y"',
        },
      },
      required: ['tool', 'target'],
      additionalProperties: false,
    },
    risk: 'medium',
    cancellable: false,
  },
  {
    capabilityId: capabilityIds.say,
    description: 'Post a message to Stardew Valley chat',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    risk: 'low',
    cancellable: false,
  },
]

const tools = new Set(['pickaxe', 'axe', 'hoe', 'watering_can', 'sword'])

interface PendingMove {
  command: GameCommand
  deadline: number
  timer: ReturnType<typeof setInterval>
  x: number
  y: number
}

/**
 * Filesystem locations and timing policy for the Stardew SMAPI bridge.
 */
export interface StardewGameAdapterOptions {
  /** `bridge_data.json` written by the SMAPI mod. */
  bridgePath: string
  /** Directory where atomic action JSON files are queued for the mod. */
  actionDir: string
  /** Companion name controlled by this adapter. @default 'Companion1' */
  companion?: string
  /** Snapshot polling interval used by continuous actions. @default 500 */
  pollIntervalMs?: number
  /** Maximum time to wait for movement arrival. @default 20_000 */
  moveTimeoutMs?: number
  /** Clock used for event timestamps and action deadlines. @default Date.now */
  now?: () => number
}

/**
 * Adapts the Stardew Valley SMAPI file bridge to Vera's game-neutral contract.
 *
 * The adapter owns action correlation and timers. SMAPI-specific JSON and
 * filesystem details do not cross the {@link GameAdapter} boundary.
 */
export class StardewGameAdapter implements GameAdapter {
  private readonly actionEvents: ActionEvents
  private readonly companion: string
  private readonly moveTimeoutMs: number
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private actionSequence = 0
  private activeFollow: { command: GameCommand, timer: ReturnType<typeof setInterval> } | null = null
  private pendingMove: PendingMove | null = null

  constructor(private readonly options: StardewGameAdapterOptions) {
    this.companion = options.companion ?? 'Companion1'
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    this.moveTimeoutMs = options.moveTimeoutMs ?? 20_000
    this.now = options.now ?? Date.now
    this.actionEvents = new ActionEvents(this.now)
  }

  public async getCapabilities(_sessionId: string): Promise<GameCapability[]> {
    return [...capabilities]
  }

  public observe(sessionId: string, listener: Parameters<GameAdapter['observe']>[1]): Unsubscribe {
    return this.actionEvents.observe(sessionId, listener)
  }

  public async execute(command: GameCommand): Promise<void> {
    this.actionEvents.queued(command)

    try {
      switch (command.capabilityId) {
        case capabilityIds.status:
          this.executeStatus(command)
          return
        case capabilityIds.follow:
          this.executeFollow(command)
          return
        case capabilityIds.move:
          this.executeMove(command)
          return
        case capabilityIds.stop:
          this.executeStop(command)
          return
        case capabilityIds.interact:
        case capabilityIds.collect:
          this.executeTileAction(command, 'interact')
          return
        case capabilityIds.useTool:
          this.executeUseTool(command)
          return
        case capabilityIds.say:
          this.executeSay(command)
          return
        default:
          this.actionEvents.failed(command, `Unsupported Stardew Valley capability "${command.capabilityId}"`)
      }
    }
    catch (error) {
      this.actionEvents.failed(command, errorMessageFrom(error) ?? 'Stardew Valley bridge command failed')
    }
  }

  public async cancel(actionId: string, reason?: string): Promise<void> {
    if (this.activeFollow?.command.actionId === actionId) {
      const command = this.activeFollow.command
      this.clearFollow()
      this.stopAtCurrentTile()
      this.actionEvents.cancelled(command, reason)
      return
    }

    if (this.pendingMove?.command.actionId === actionId) {
      const command = this.pendingMove.command
      this.clearMove()
      this.stopAtCurrentTile()
      this.actionEvents.cancelled(command, reason)
    }
  }

  /** Stops timers owned by this adapter. Call during service shutdown. */
  public destroy(): void {
    this.clearFollow()
    this.clearMove()
  }

  private executeStatus(command: GameCommand): void {
    if (!hasNoInput(command)) {
      this.actionEvents.failed(command, `Invalid input for "${command.capabilityId}"`)
      return
    }

    this.actionEvents.running(command)
    const snapshot = this.readSnapshot()
    this.actionEvents.snapshot(command, snapshot)
    this.actionEvents.succeeded(command, snapshot)
  }

  private executeFollow(command: GameCommand): void {
    if (!hasNoInput(command)) {
      this.actionEvents.failed(command, `Invalid input for "${command.capabilityId}"`)
      return
    }
    if (!this.acquireControl(command))
      return

    const step = () => {
      try {
        const snapshot = this.readSnapshot()
        const player = playerTile(snapshot)
        const companion = companionTile(snapshot, this.companion)
        if (player == null || companion == null)
          return
        if (Math.hypot(player.x - companion.x, player.y - companion.y) <= 3)
          return
        this.send({
          actionType: 'move_to',
          companion: this.companion,
          x: player.x,
          y: player.y,
        })
      }
      catch (error) {
        const active = this.activeFollow
        if (active == null)
          return
        this.clearFollow()
        this.actionEvents.failed(active.command, errorMessageFrom(error) ?? 'Failed to follow Stardew Valley player')
      }
    }

    const timer = setInterval(step, this.pollIntervalMs)
    this.activeFollow = { command, timer }
    this.actionEvents.running(command)
    step()
  }

  private executeMove(command: GameCommand): void {
    const target = parsePoint(command.input.target)
    if (target == null) {
      this.actionEvents.failed(command, 'target must be formatted as "x,y"')
      return
    }
    if (!this.acquireControl(command))
      return

    this.send({
      actionType: 'move_to',
      companion: this.companion,
      x: target.x,
      y: target.y,
    })
    this.actionEvents.running(command)

    const timer = setInterval(() => this.pollMove(), this.pollIntervalMs)
    this.pendingMove = {
      command,
      deadline: this.now() + this.moveTimeoutMs,
      timer,
      ...target,
    }
  }

  private executeStop(command: GameCommand): void {
    if (!hasNoInput(command)) {
      this.actionEvents.failed(command, `Invalid input for "${command.capabilityId}"`)
      return
    }

    this.actionEvents.running(command)
    const stoppedActionIds = this.stopSessionActions(command.sessionId, `Stopped by action "${command.actionId}"`)
    if (stoppedActionIds.length > 0)
      this.stopAtCurrentTile()
    this.actionEvents.succeeded(command, { stoppedActionIds })
  }

  private executeTileAction(command: GameCommand, actionType: 'interact'): void {
    const target = parsePoint(command.input.target)
    if (target == null) {
      this.actionEvents.failed(command, 'target must be formatted as "x,y"')
      return
    }

    this.actionEvents.running(command)
    this.send({ actionType, companion: this.companion, ...target })
    this.actionEvents.succeeded(command, { tile: target })
  }

  private executeUseTool(command: GameCommand): void {
    const target = parsePoint(command.input.target)
    const tool = stringValue(command.input.tool)
    if (target == null || tool == null || !tools.has(tool)) {
      this.actionEvents.failed(command, 'tool and target must match the declared Stardew Valley schema')
      return
    }

    this.actionEvents.running(command)
    this.send({ actionType: 'use_tool', companion: this.companion, tool, ...target })
    this.actionEvents.succeeded(command, { tool, tile: target })
  }

  private executeSay(command: GameCommand): void {
    const text = stringValue(command.input.text)
    if (text == null || text.length === 0) {
      this.actionEvents.failed(command, 'text must be a non-empty string')
      return
    }

    this.actionEvents.running(command)
    this.send({ actionType: 'chat', metadata: { message: text } })
    this.actionEvents.succeeded(command, { said: text })
  }

  private acquireControl(command: GameCommand): boolean {
    const active = this.activeFollow?.command ?? this.pendingMove?.command
    if (active != null && active.sessionId !== command.sessionId) {
      this.actionEvents.failed(command, 'Stardew Valley companion is controlled by another session')
      return false
    }

    this.stopSessionActions(command.sessionId, `Replaced by action "${command.actionId}"`)
    return true
  }

  private stopSessionActions(sessionId: string, reason: string): string[] {
    const stopped: string[] = []

    if (this.activeFollow?.command.sessionId === sessionId) {
      const command = this.activeFollow.command
      stopped.push(command.actionId)
      this.clearFollow()
      this.actionEvents.cancelled(command, reason)
    }
    if (this.pendingMove?.command.sessionId === sessionId) {
      const command = this.pendingMove.command
      stopped.push(command.actionId)
      this.clearMove()
      this.actionEvents.cancelled(command, reason)
    }

    return stopped
  }

  private pollMove(): void {
    const pending = this.pendingMove
    if (pending == null)
      return

    try {
      const current = companionTile(this.readSnapshot(), this.companion)
      if (current != null && Math.hypot(current.x - pending.x, current.y - pending.y) <= 1) {
        this.clearMove()
        this.actionEvents.succeeded(pending.command, { tile: { x: pending.x, y: pending.y } })
      }
      else if (this.now() > pending.deadline) {
        this.clearMove()
        this.actionEvents.failed(pending.command, 'Stardew Valley move timed out before arrival')
      }
    }
    catch (error) {
      this.clearMove()
      this.actionEvents.failed(pending.command, errorMessageFrom(error) ?? 'Failed to poll Stardew Valley movement')
    }
  }

  private stopAtCurrentTile(): void {
    const current = companionTile(this.readSnapshot(), this.companion)
    if (current == null)
      return

    // SMAPI bridge has no stop command. Re-targeting current tile terminates its
    // path without inventing a second transport protocol.
    this.send({
      actionType: 'move_to',
      companion: this.companion,
      ...current,
    })
  }

  private clearFollow(): void {
    if (this.activeFollow != null)
      clearInterval(this.activeFollow.timer)
    this.activeFollow = null
  }

  private clearMove(): void {
    if (this.pendingMove != null)
      clearInterval(this.pendingMove.timer)
    this.pendingMove = null
  }

  private readSnapshot() {
    return parseJsonObject(readFileSync(this.options.bridgePath, 'utf8'))
  }

  private send(payload: Record<string, JsonValue>): void {
    mkdirSync(this.options.actionDir, { recursive: true })
    const name = `${this.now()}-${String(this.actionSequence++).padStart(6, '0')}.json`
    const finalPath = join(this.options.actionDir, name)
    const temporaryPath = `${finalPath}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(payload))
    renameSync(temporaryPath, finalPath)
  }
}

function hasNoInput(command: GameCommand) {
  return Object.keys(command.input).length === 0
}

function parsePoint(value: JsonValue | undefined): { x: number, y: number } | null {
  if (typeof value !== 'string')
    return null
  const [x, y, extra] = value.split(',').map(part => Number(part.trim()))
  if (extra != null || !Number.isFinite(x) || !Number.isFinite(y))
    return null
  return { x, y }
}

function companionTile(snapshot: Record<string, JsonValue>, name: string) {
  for (const value of arrayValue(snapshot.companions)) {
    const companion = objectValue(value)
    if (stringValue(companion?.name) !== name)
      continue
    const tile = objectValue(companion?.tile)
    const x = numberValue(tile?.x)
    const y = numberValue(tile?.y)
    if (x != null && y != null)
      return { x, y }
  }
  return null
}

function playerTile(snapshot: Record<string, JsonValue>) {
  const position = objectValue(objectValue(snapshot.player)?.position)
  const x = numberValue(position?.x)
  const y = numberValue(position?.y)
  if (x == null || y == null)
    return null

  // Stardew bridge reports player pixels while companion positions use tiles.
  return { x: Math.round(x / 64), y: Math.round(y / 64) }
}
