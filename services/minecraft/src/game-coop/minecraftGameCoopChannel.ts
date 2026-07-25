import type { GameAdapter } from '@proj-vera/game-coop-core'
import type { Client } from '@proj-vera/server-sdk'

import { GameCoopChannel } from '@proj-vera/server-sdk'

export interface MinecraftGameCoopChannelOptions {
  client: Pick<Client, 'onEvent' | 'send'>
  adapter: GameAdapter
  /**
   * Stable adapter registration ID shared with its remote proxy.
   * @default 'minecraft'
   */
  adapterId?: string
}

/**
 * Binds a Minecraft GameAdapter to typed server-channel events.
 *
 * Each action remembers the requesting Stage route. Lifecycle events return
 * only to that route, preserving session, turn, and action isolation.
 */
export class MinecraftGameCoopChannel extends GameCoopChannel {
  constructor(options: MinecraftGameCoopChannelOptions) {
    super({
      ...options,
      adapterId: options.adapterId ?? 'minecraft',
    })
  }
}
