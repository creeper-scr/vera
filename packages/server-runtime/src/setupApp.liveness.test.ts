import type { WebSocketEvent } from '@proj-vera/server-shared/types'

import type { Peer } from './types'

import { parse, stringify } from 'superjson'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setupApp } from './index'

interface TestWebSocketHandler {
  open?: (peer: Peer) => void
  message?: (peer: Peer, message: { text: () => string }) => void
  close?: (peer: Peer, details?: { code?: number, reason?: string, wasClean?: unknown }) => void
}

interface TestWsServer {
  accept: (
    adapter: { id: string, send: (message: { text: () => string }) => void | number, close?: () => void },
    options: { state: { rawPeer: Peer } },
  ) => void
  peers: {
    get: (peerId: string) => { receive: (message: { text: () => string }) => void } | undefined
  }
  remove: (peerId: string, details?: { code?: number, reason?: string, wasClean?: unknown }) => void
}

const h3Mocks = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
}))

vi.mock('h3', () => ({
  H3: class {
    get(path: string, handler: unknown) {
      h3Mocks.handlers.set(path, handler)
    }
  },
}))

vi.mock('@proj-vera/better-ws/server/h3', () => ({
  toH3Handler: vi.fn((server: TestWsServer, options: { state: (peer: Peer) => { rawPeer: Peer } }) => ({
    open(peer: Peer) {
      server.accept({
        id: peer.id,
        send: message => peer.send(message.text()),
        close: () => peer.close?.(),
      }, {
        state: options.state(peer),
      })
    },
    message(peer: Peer, message: { text: () => string }) {
      server.peers.get(peer.id)?.receive(message)
    },
    close(peer: Peer, details?: { code?: number, reason?: string, wasClean?: unknown }) {
      server.remove(peer.id, details)
    },
  })),
}))

function createPeer(id: string) {
  const sent: string[] = []
  const send: Peer['send'] = (data) => {
    sent.push(String(data))
  }

  return {
    peer: {
      id,
      send: vi.fn(send),
      close: vi.fn(),
      request: { url: `/ws?id=${id}` },
      remoteAddress: '127.0.0.1',
    } satisfies Peer,
    sent,
  }
}

function wsHandler() {
  const handler = h3Mocks.handlers.get('/ws') as TestWebSocketHandler | undefined
  if (!handler) {
    throw new Error('Expected setupApp to register a /ws websocket handler.')
  }

  return handler
}

function sendEvent(
  handler: TestWebSocketHandler,
  peer: Peer,
  event: WebSocketEvent,
) {
  handler.message?.(peer, { text: () => stringify(event) })
}

function decodeEvents(sent: string[]) {
  return sent.map(message => parse<WebSocketEvent>(message))
}

function createExtensionModuleAnnounceEvent(options: {
  extensionId?: string
  identityId?: string
  name?: string
} = {}): WebSocketEvent {
  const extensionId = options.extensionId ?? 'extension-1'
  const identityId = options.identityId ?? 'memory-module-1'

  return {
    type: 'extension:module:announce',
    data: {
      name: options.name ?? 'memory',
      possibleEvents: [],
      identity: {
        id: identityId,
        extension: {
          id: extensionId,
        },
      },
    },
    metadata: {
      source: {
        kind: 'plugin',
        id: identityId,
        extension: {
          id: extensionId,
        },
        plugin: {
          id: extensionId,
        },
      },
      event: {
        id: 'announce-1',
      },
    },
  }
}

describe('setupApp websocket liveness', () => {
  beforeEach(() => {
    h3Mocks.handlers.clear()
    vi.useFakeTimers({ now: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('broadcasts extension module unhealthy events from better-ws liveness checks', () => {
    const runtime = setupApp({ heartbeat: { readTimeout: 20_000 } })
    const handler = wsHandler()
    const observer = createPeer('observer')
    const modulePeer = createPeer('module-peer')

    handler.open?.(observer.peer)
    handler.open?.(modulePeer.peer)
    sendEvent(handler, modulePeer.peer, createExtensionModuleAnnounceEvent())
    observer.sent.length = 0

    vi.advanceTimersByTime(25_000)

    expect(decodeEvents(observer.sent)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'registry:modules:health:unhealthy',
        data: {
          name: 'memory',
          identity: {
            id: 'memory-module-1',
            extension: {
              id: 'extension-1',
            },
          },
          reason: 'heartbeat late',
        },
      }),
    ]))

    runtime.dispose()
  })

  it('de-announces expired extension modules when better-ws removes stale peers', () => {
    const runtime = setupApp({ heartbeat: { readTimeout: 20_000 } })
    const handler = wsHandler()
    const observer = createPeer('observer')
    const modulePeer = createPeer('module-peer')

    handler.open?.(observer.peer)
    handler.open?.(modulePeer.peer)
    sendEvent(handler, modulePeer.peer, createExtensionModuleAnnounceEvent())
    observer.sent.length = 0

    vi.advanceTimersByTime(25_000)
    handler.message?.(observer.peer, { text: () => 'pong' })
    observer.sent.length = 0
    vi.advanceTimersByTime(25_000)

    expect(modulePeer.peer.close).toHaveBeenCalledOnce()
    expect(decodeEvents(observer.sent)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'extension:module:de-announced',
        data: expect.objectContaining({
          name: 'memory',
          reason: 'heartbeat expired',
        }),
      }),
    ]))

    runtime.dispose()
  })

  it('de-announces extension modules before accepting a same-id reconnect', () => {
    const runtime = setupApp({ heartbeat: { readTimeout: 20_000 } })
    const handler = wsHandler()
    const observer = createPeer('observer')
    const firstModulePeer = createPeer('module-peer')
    const secondModulePeer = createPeer('module-peer')

    handler.open?.(observer.peer)
    handler.open?.(firstModulePeer.peer)
    sendEvent(handler, firstModulePeer.peer, createExtensionModuleAnnounceEvent())
    observer.sent.length = 0

    handler.open?.(secondModulePeer.peer)

    expect(decodeEvents(observer.sent)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'extension:module:de-announced',
        data: expect.objectContaining({
          name: 'memory',
          reason: 'connection closed',
        }),
      }),
    ]))

    runtime.dispose()
  })

  it('routes game commands to only the selected same-name module instance', () => {
    const runtime = setupApp({ heartbeat: { readTimeout: 20_000 } })
    const handler = wsHandler()
    const stagePeer = createPeer('stage-peer')
    const firstModulePeer = createPeer('minecraft-peer-1')
    const secondModulePeer = createPeer('minecraft-peer-2')

    handler.open?.(stagePeer.peer)
    handler.open?.(firstModulePeer.peer)
    handler.open?.(secondModulePeer.peer)
    sendEvent(handler, firstModulePeer.peer, createExtensionModuleAnnounceEvent({
      extensionId: 'minecraft-extension-1',
      identityId: 'minecraft-module-1',
      name: 'minecraft-bot',
    }))
    sendEvent(handler, secondModulePeer.peer, createExtensionModuleAnnounceEvent({
      extensionId: 'minecraft-extension-2',
      identityId: 'minecraft-module-2',
      name: 'minecraft-bot',
    }))
    firstModulePeer.sent.length = 0
    secondModulePeer.sent.length = 0

    sendEvent(handler, stagePeer.peer, {
      type: 'game:coop:command',
      data: {
        adapterId: 'minecraft',
        command: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          actionId: 'action-1',
          capabilityId: 'minecraft.status',
          input: {},
        },
        replyTo: 'instance:stage-instance',
        destinations: ['instance:minecraft-module-1'],
      },
      metadata: {
        source: {
          kind: 'plugin',
          id: 'stage-instance',
          plugin: { id: 'stage-tamagotchi' },
        },
        event: { id: 'command-1' },
      },
    })

    expect(decodeEvents(firstModulePeer.sent)).toEqual([
      expect.objectContaining({
        type: 'game:coop:command',
      }),
    ])
    expect(decodeEvents(secondModulePeer.sent)).toEqual([])

    runtime.dispose()
  })

  it('closes each raw peer once during runtime disposal', () => {
    const runtime = setupApp({ heartbeat: { readTimeout: 20_000 } })
    const handler = wsHandler()
    const peer = createPeer('peer-1')

    handler.open?.(peer.peer)
    runtime.dispose()

    expect(peer.peer.close).toHaveBeenCalledOnce()
  })
})
