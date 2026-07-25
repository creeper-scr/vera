import type { GameCoopServerChannel } from '../services/game-coop/serverGameAdapter'

import { watch } from 'vue'

import { useModsServerChannelStore } from '../stores/mods/api/channel-server'

/**
 * Projects the root-owned authenticated server channel into the game adapter
 * boundary without opening a second renderer connection.
 */
export function useGameCoopServerChannel(): GameCoopServerChannel {
  const serverChannelStore = useModsServerChannelStore()

  return {
    isConnected: () => serverChannelStore.connected,
    send: event => serverChannelStore.send(event),
    // Root App initializes this route. Event registration must not race it by
    // opening an unauthenticated connection.
    onEvent: (type, listener) => serverChannelStore.onEvent(type, listener, { autoInitialize: false }),
    onDisconnected(listener) {
      let wasConnected = serverChannelStore.connected
      return watch(
        () => serverChannelStore.connected,
        (connected) => {
          if (wasConnected && !connected)
            listener('Server channel disconnected')
          wasConnected = connected
        },
      )
    },
  }
}
