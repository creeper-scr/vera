import process, { env, exit } from 'node:process'

import { Client, GameCoopChannel } from '@proj-vera/server-sdk'

import {
  DontStarveTogetherGameAdapter,
  StardewGameAdapter,
} from './adapters'

interface ManagedAdapter {
  adapter: StardewGameAdapter | DontStarveTogetherGameAdapter
  adapterId: 'stardew' | 'dst'
}

interface ManagedRuntime {
  adapterId: 'stardew' | 'dst'
  adapter: ManagedAdapter['adapter']
  client: Client
  channel: GameCoopChannel
}

const GAME_COOP_EVENTS = [
  'game:coop:capabilities:request',
  'game:coop:capabilities',
  'game:coop:command',
  'game:coop:cancel',
  'game:coop:action',
] as const

/**
 * Runs configured file-bridge adapters and exposes each as
 * `module:${adapterId}-bot` over the Vera server channel.
 *
 * Call stack:
 *
 * main
 *   -> one {@link Client} per adapter (`stardew-bot` / `dst-bot`)
 *     -> {@link GameCoopChannel}
 *       -> {@link StardewGameAdapter} / {@link DontStarveTogetherGameAdapter}
 */
async function main() {
  const adapters = configuredAdapters()
  if (adapters.length === 0) {
    throw new Error(
      'No game bridge configured. Set STARDEW_BRIDGE_PATH + STARDEW_ACTION_DIR and/or DST_BRIDGE_PATH + DST_COMMAND_PATH.',
    )
  }

  const runtimes = adapters.map(adapter => createRuntime(adapter))
  runtimes.forEach(({ channel }) => channel.init())
  await Promise.all(runtimes.map(({ client }) => client.connect()))

  console.warn(`[game-bridges] connected with modules: ${runtimes.map(({ adapterId }) => `${adapterId}-bot`).join(', ')}`)

  let stopping = false
  const shutdown = () => {
    if (stopping)
      return
    stopping = true

    runtimes.forEach(({ channel, adapter, client }) => {
      channel.destroy()
      adapter.destroy()
      client.close()
    })
    exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * Builds one Vera client + GameCoopChannel for a configured adapter.
 */
function createRuntime(managed: ManagedAdapter): ManagedRuntime {
  const client = new Client({
    name: `${managed.adapterId}-bot`,
    url: env.VERA_URL,
    token: env.VERA_TOKEN || undefined,
    possibleEvents: [...GAME_COOP_EVENTS],
    autoConnect: false,
    onError: error => console.error(`[game-bridges:${managed.adapterId}] Vera client error:`, error),
    onClose: () => console.warn(`[game-bridges:${managed.adapterId}] Vera connection closed; reconnecting`),
  })

  return {
    adapterId: managed.adapterId,
    adapter: managed.adapter,
    client,
    channel: new GameCoopChannel({
      adapterId: managed.adapterId,
      adapter: managed.adapter,
      client,
    }),
  }
}

/**
 * Collects adapters that have the required env vars set.
 */
function configuredAdapters(): ManagedAdapter[] {
  const adapters: ManagedAdapter[] = []

  if (env.STARDEW_BRIDGE_PATH && env.STARDEW_ACTION_DIR) {
    adapters.push({
      adapterId: 'stardew',
      adapter: new StardewGameAdapter({
        bridgePath: env.STARDEW_BRIDGE_PATH,
        actionDir: env.STARDEW_ACTION_DIR,
        companion: env.STARDEW_COMPANION,
      }),
    })
  }

  if (env.DST_BRIDGE_PATH && env.DST_COMMAND_PATH) {
    adapters.push({
      adapterId: 'dst',
      adapter: new DontStarveTogetherGameAdapter({
        bridgePath: env.DST_BRIDGE_PATH,
        commandPath: env.DST_COMMAND_PATH,
      }),
    })
  }

  return adapters
}

void main().catch((error) => {
  console.error('[game-bridges] fatal error:', error)
  exit(1)
})
