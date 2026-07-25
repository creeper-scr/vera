import type { WebSocketEvent } from '@proj-vera/server-sdk'

import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { ref, shallowReactive } from 'vue'

export interface WebSocketHistoryItem {
  id: string
  timestamp: number
  direction: 'incoming' | 'outgoing'
  event: WebSocketEvent
}

export const useWebSocketInspectorStore = defineStore('devtools:websocket-inspector', () => {
  // WebSocketEvent is a large discriminated union. Keep payloads opaque to
  // Vue so adding protocol events does not trigger recursive type unwrapping.
  const history = shallowReactive<WebSocketHistoryItem[]>([])
  const isEnabled = ref(true)
  const maxHistory = ref(1000)

  function add(direction: 'incoming' | 'outgoing', event: WebSocketEvent) {
    if (!isEnabled.value)
      return

    history.unshift({
      id: nanoid(),
      timestamp: Date.now(),
      direction,
      event,
    })

    if (history.length > maxHistory.value) {
      history.pop()
    }
  }

  function clear() {
    history.splice(0)
  }

  return {
    history,
    isEnabled,
    maxHistory,
    add,
    clear,
  }
})
