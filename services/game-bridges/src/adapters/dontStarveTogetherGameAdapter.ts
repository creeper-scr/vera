import type {
  GameAdapter,
  GameCapability,
  GameCapabilityInputSchema,
  GameCommand,
  JsonValue,
  Unsubscribe,
} from '@proj-vera/game-coop-core'

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

import { ActionEvents } from '../actionEvents'
import {
  numberValue,
  objectValue,
  parseJsonObject,
  stringValue,
} from '../json'

const capabilityIds = {
  status: 'dst.status',
  follow: 'dst.follow',
  move: 'dst.move',
  stop: 'dst.stop',
  collect: 'dst.collect',
  interact: 'dst.interact',
  say: 'dst.say',
} as const

const emptyInputSchema: GameCapabilityInputSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

const entityInputSchema: GameCapabilityInputSchema = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description: 'Entity id from the latest DST snapshot',
    },
  },
  required: ['target'],
  additionalProperties: false,
}

const capabilities: GameCapability[] = [
  { capabilityId: capabilityIds.status, description: 'Read DST world, character, inventory, and nearby entity state', inputSchema: emptyInputSchema, risk: 'low', cancellable: false },
  { capabilityId: capabilityIds.follow, description: 'Continuously follow the human player in DST', inputSchema: emptyInputSchema, risk: 'low', cancellable: true },
  {
    capabilityId: capabilityIds.move,
    description: 'Move to DST world coordinates',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'World coordinate formatted as "x,z"',
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
    risk: 'low',
    cancellable: true,
  },
  { capabilityId: capabilityIds.stop, description: 'Stop DST movement and following', inputSchema: emptyInputSchema, risk: 'low', cancellable: false },
  { capabilityId: capabilityIds.collect, description: 'Collect a nearby DST entity by id', inputSchema: entityInputSchema, risk: 'low', cancellable: false },
  { capabilityId: capabilityIds.interact, description: 'Interact with a nearby DST entity by id', inputSchema: entityInputSchema, risk: 'low', cancellable: false },
  {
    capabilityId: capabilityIds.say,
    description: 'Speak in DST world chat',
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

const kleiPersistentStringHeader = 'KLEI     1 '

interface PendingMove {
  command: GameCommand
  deadline: number
  timer: ReturnType<typeof setInterval>
  x: number
  z: number
}

/**
 * Filesystem locations and timing policy for the DST Lua bridge.
 */
export interface DontStarveTogetherGameAdapterOptions {
  /** JSON snapshot written to DST persistent string `aigame_state`. */
  bridgePath: string
  /** Command slot read from DST persistent string `aigame_command`. */
  commandPath: string
  /** Snapshot polling interval used by move completion checks. @default 500 */
  pollIntervalMs?: number
  /** Maximum time to wait for movement arrival. @default 20_000 */
  moveTimeoutMs?: number
  /** Clock used for event timestamps and action deadlines. @default Date.now */
  now?: () => number
}

/**
 * Adapts the Don't Starve Together Lua file bridge to Vera's game contract.
 *
 * Commands use one atomic persistent-string slot because DST's Lua sandbox
 * cannot enumerate an action directory.
 */
export class DontStarveTogetherGameAdapter implements GameAdapter {
  private readonly actionEvents: ActionEvents
  private readonly moveTimeoutMs: number
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private actionSequence = 0
  private activeFollow: GameCommand | null = null
  private pendingMove: PendingMove | null = null

  constructor(private readonly options: DontStarveTogetherGameAdapterOptions) {
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
        case capabilityIds.collect:
        case capabilityIds.interact:
          this.executeEntityAction(command)
          return
        case capabilityIds.say:
          this.executeSay(command)
          return
        default:
          this.actionEvents.failed(command, `Unsupported Don't Starve Together capability "${command.capabilityId}"`)
      }
    }
    catch (error) {
      this.actionEvents.failed(command, errorMessageFrom(error) ?? 'Don\'t Starve Together bridge command failed')
    }
  }

  public async cancel(actionId: string, reason?: string): Promise<void> {
    if (this.activeFollow?.actionId === actionId) {
      const command = this.activeFollow
      this.activeFollow = null
      this.send({ action: 'stop' })
      this.actionEvents.cancelled(command, reason)
      return
    }

    if (this.pendingMove?.command.actionId === actionId) {
      const command = this.pendingMove.command
      this.clearMove()
      this.send({ action: 'stop' })
      this.actionEvents.cancelled(command, reason)
    }
  }

  /** Stops timers owned by this adapter. Call during service shutdown. */
  public destroy(): void {
    this.clearMove()
    this.activeFollow = null
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

    this.send({ action: 'follow' })
    this.activeFollow = command
    this.actionEvents.running(command)
  }

  private executeMove(command: GameCommand): void {
    const target = parsePoint(command.input.target)
    if (target == null) {
      this.actionEvents.failed(command, 'target must be formatted as "x,z"')
      return
    }
    if (!this.acquireControl(command))
      return

    this.send({ action: 'move', ...target })
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
      this.send({ action: 'stop' })
    this.actionEvents.succeeded(command, { stoppedActionIds })
  }

  private executeEntityAction(command: GameCommand): void {
    const target = stringValue(command.input.target)
    if (target == null || target.length === 0) {
      this.actionEvents.failed(command, 'target must be a non-empty DST entity id')
      return
    }

    this.actionEvents.running(command)
    this.send({
      action: command.capabilityId === capabilityIds.collect ? 'collect' : 'interact',
      target,
    })
    this.actionEvents.succeeded(command, { target })
  }

  private executeSay(command: GameCommand): void {
    const text = stringValue(command.input.text)
    if (text == null || text.length === 0) {
      this.actionEvents.failed(command, 'text must be a non-empty string')
      return
    }

    this.actionEvents.running(command)
    this.send({ action: 'say', text })
    this.actionEvents.succeeded(command, { said: text })
  }

  private acquireControl(command: GameCommand): boolean {
    const active = this.activeFollow ?? this.pendingMove?.command
    if (active != null && active.sessionId !== command.sessionId) {
      this.actionEvents.failed(command, 'Don\'t Starve Together agent is controlled by another session')
      return false
    }

    const stopped = this.stopSessionActions(command.sessionId, `Replaced by action "${command.actionId}"`)
    if (stopped.length > 0)
      this.send({ action: 'stop' })
    return true
  }

  private stopSessionActions(sessionId: string, reason: string): string[] {
    const stopped: string[] = []

    if (this.activeFollow?.sessionId === sessionId) {
      const command = this.activeFollow
      stopped.push(command.actionId)
      this.activeFollow = null
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
      const current = controlledCharacterPosition(this.readSnapshot())
      if (current != null && Math.hypot(current.x - pending.x, current.z - pending.z) <= 2) {
        this.clearMove()
        this.actionEvents.succeeded(pending.command, { position: { x: pending.x, z: pending.z } })
      }
      else if (this.now() > pending.deadline) {
        this.clearMove()
        this.actionEvents.failed(pending.command, 'Don\'t Starve Together move timed out before arrival')
      }
    }
    catch (error) {
      this.clearMove()
      this.actionEvents.failed(pending.command, errorMessageFrom(error) ?? 'Failed to poll Don\'t Starve Together movement')
    }
  }

  private clearMove(): void {
    if (this.pendingMove != null)
      clearInterval(this.pendingMove.timer)
    this.pendingMove = null
  }

  private readSnapshot() {
    const raw = readFileSync(this.options.bridgePath, 'utf8')
    const objectStart = raw.indexOf('{')
    return parseJsonObject(objectStart === -1 ? raw : raw.slice(objectStart))
  }

  private send(payload: Record<string, JsonValue>): void {
    mkdirSync(dirname(this.options.commandPath), { recursive: true })
    const command = {
      seq: ++this.actionSequence,
      ...payload,
    }
    const temporaryPath = `${this.options.commandPath}.tmp`
    writeFileSync(temporaryPath, `${kleiPersistentStringHeader}${JSON.stringify(command)}`)
    renameSync(temporaryPath, this.options.commandPath)
  }
}

function hasNoInput(command: GameCommand) {
  return Object.keys(command.input).length === 0
}

function parsePoint(value: JsonValue | undefined): { x: number, z: number } | null {
  if (typeof value !== 'string')
    return null
  const [x, z, extra] = value.split(',').map(part => Number(part.trim()))
  if (extra != null || !Number.isFinite(x) || !Number.isFinite(z))
    return null
  return { x, z }
}

function controlledCharacterPosition(snapshot: Record<string, JsonValue>) {
  const character = objectValue(snapshot.agent) ?? objectValue(snapshot.player)
  const position = objectValue(character?.position)
  const x = numberValue(position?.x)
  const z = numberValue(position?.z)
  return x == null || z == null ? null : { x, z }
}
