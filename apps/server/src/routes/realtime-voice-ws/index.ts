import type { WSEvents } from 'hono/ws'

import { useLogger } from '@guiiai/logg'

import { createRealtimeVoiceSession } from './session'

const log = useLogger('realtime-voice-ws').useGlobalConfig()

/** Creates one authenticated client-to-Doubao realtime voice bridge. */
export function createRealtimeVoiceWsHandlers() {
  return function setupPeer(userId: string): WSEvents {
    const session = createRealtimeVoiceSession()

    return {
      onOpen(_event, ws) {
        session.attachClient(ws)
      },
      onMessage(message, ws) {
        session.handleClientMessage(message, ws)
      },
      onClose() {
        session.close()
      },
      onError(event, ws) {
        log.withFields({ userId, event: String(event) }).warn('client ws error')
        session.close()
        try {
          ws.close(1011, 'internal_error')
        }
        catch {}
      },
    }
  }
}
