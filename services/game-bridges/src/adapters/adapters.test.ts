import type {
  GameActionEvent,
  GameCommand,
} from '@proj-vera/game-coop-core'

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DontStarveTogetherGameAdapter } from './dontStarveTogetherGameAdapter'
import { StardewGameAdapter } from './stardewGameAdapter'

describe('game bridge adapters', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vera-game-bridges-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('exposes Stardew capabilities and correlated status lifecycle', async () => {
    const bridgePath = join(root, 'bridge_data.json')
    const actionDir = join(root, 'actions')
    writeStardewSnapshot(bridgePath)

    const adapter = new StardewGameAdapter({ bridgePath, actionDir })
    const events: GameActionEvent[] = []
    adapter.observe('session-1', event => events.push(event))

    const capabilities = await adapter.getCapabilities('session-1')
    expect(capabilities.map(capability => capability.capabilityId)).toEqual([
      'stardew.status',
      'stardew.follow',
      'stardew.move',
      'stardew.stop',
      'stardew.interact',
      'stardew.collect',
      'stardew.use_tool',
      'stardew.say',
    ])

    await adapter.execute(command('stardew.status', {}, 'status-1'))

    expect(events.map(event => event.state)).toEqual([
      'queued',
      'running',
      'snapshot',
      'succeeded',
    ])
    expect(events.every(event => event.sessionId === 'session-1')).toBe(true)
    expect(events.every(event => event.turnId === 'turn-1')).toBe(true)
    expect(events.every(event => event.actionId === 'status-1')).toBe(true)
    expect(events.every(event => event.capabilityId === 'stardew.status')).toBe(true)
  })

  it('queues Stardew actions atomically and cancels follow', async () => {
    const bridgePath = join(root, 'bridge_data.json')
    const actionDir = join(root, 'actions')
    writeStardewSnapshot(bridgePath)

    const adapter = new StardewGameAdapter({
      bridgePath,
      actionDir,
      pollIntervalMs: 60_000,
    })
    const events: GameActionEvent[] = []
    adapter.observe('session-1', event => events.push(event))

    await adapter.execute(command('stardew.follow', {}, 'follow-1'))
    await adapter.cancel('follow-1', 'test complete')
    adapter.destroy()

    const actionFiles = readdirSync(actionDir)
    expect(actionFiles.length).toBe(2)
    expect(actionFiles.every(file => file.endsWith('.json'))).toBe(true)
    expect(actionFiles.some(file => file.endsWith('.tmp'))).toBe(false)
    expect(events.map(event => event.state)).toEqual([
      'queued',
      'running',
      'cancelled',
    ])
    expect(events.at(-1)).toMatchObject({
      state: 'cancelled',
      reason: 'test complete',
    })
  })

  it('writes DST persistent-string commands and preserves action lifecycle', async () => {
    const bridgePath = join(root, 'aigame_state')
    const commandPath = join(root, 'commands', 'aigame_command')
    writeFileSync(bridgePath, `KLEI     1 ${JSON.stringify({
      updated_at: 42,
      player: {
        name: 'Wilson',
        position: { x: 0, y: 0, z: 0 },
        health: 150,
        hunger: 150,
        sanity: 200,
        inventory: [],
      },
      agent: {
        name: 'Vera',
        position: { x: 1, y: 0, z: 1 },
        health: 150,
        hunger: 150,
        sanity: 200,
        inventory: [],
      },
      entities: [],
    })}`)

    const adapter = new DontStarveTogetherGameAdapter({
      bridgePath,
      commandPath,
      pollIntervalMs: 60_000,
    })
    const events: GameActionEvent[] = []
    adapter.observe('session-1', event => events.push(event))

    await adapter.execute(command('dst.follow', {}, 'follow-1'))
    await adapter.cancel('follow-1', 'test complete')
    adapter.destroy()

    const rawCommand = readFileSync(commandPath, 'utf8')
    expect(rawCommand.startsWith('KLEI     1 ')).toBe(true)
    expect(JSON.parse(rawCommand.slice('KLEI     1 '.length))).toEqual({
      seq: 2,
      action: 'stop',
    })
    expect(events.map(event => event.state)).toEqual([
      'queued',
      'running',
      'cancelled',
    ])
  })

  it('rejects cross-session control without disturbing active DST action', async () => {
    const bridgePath = join(root, 'aigame_state')
    const commandPath = join(root, 'aigame_command')
    writeFileSync(bridgePath, 'KLEI     1 {}')

    const adapter = new DontStarveTogetherGameAdapter({ bridgePath, commandPath })
    const firstSessionEvents: GameActionEvent[] = []
    const secondSessionEvents: GameActionEvent[] = []
    adapter.observe('session-1', event => firstSessionEvents.push(event))
    adapter.observe('session-2', event => secondSessionEvents.push(event))

    await adapter.execute(command('dst.follow', {}, 'follow-1'))
    await adapter.execute({
      ...command('dst.follow', {}, 'follow-2'),
      sessionId: 'session-2',
    })

    expect(firstSessionEvents.map(event => event.state)).toEqual(['queued', 'running'])
    expect(secondSessionEvents.map(event => event.state)).toEqual(['queued', 'failed'])
    expect(secondSessionEvents.at(-1)).toMatchObject({
      state: 'failed',
      error: 'Don\'t Starve Together agent is controlled by another session',
    })

    await adapter.cancel('follow-1')
    adapter.destroy()
  })
})

function command(
  capabilityId: string,
  input: GameCommand['input'],
  actionId: string,
): GameCommand {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    actionId,
    capabilityId,
    input,
  }
}

function writeStardewSnapshot(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({
    time: 600,
    day: 1,
    season: 'spring',
    weather: 'sunny',
    location: 'Farm',
    player: {
      name: 'Farmer',
      health: 100,
      stamina: 270,
      money: 500,
      position: { x: 640, y: 640 },
    },
    companions: [{
      name: 'Companion1',
      tile: { x: 1, y: 1 },
      location: 'Farm',
      status: 'idle',
      mode: 'player',
      stamina: 270,
      health: 100,
      maxHealth: 100,
      autoCombat: false,
      inventory: [],
    }],
    syncedAt: '2026-07-24T00:00:00.000Z',
  }))
}
