import process from 'node:process'

/**
 * Local Doubao realtime voice relay for `pnpm dev:play`.
 *
 * Browser speaks the Vera JSON control protocol; this process opens the
 * upstream Volcengine WebSocket with credential headers (browsers cannot).
 * No Vera hosted auth required — App ID / Access Key come from the start event.
 */
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

import { createRealtimeVoiceSession } from '../src/routes/realtime-voice-ws/session'

/** Bind all interfaces so LAN phones can reach the relay during hackathon demos. */
const HOST = process.env.DOUBAO_REALTIME_WS_HOST || '0.0.0.0'
const PATH = '/api/v1/audio/realtime/ws'
const PORT = Number(process.env.DOUBAO_REALTIME_WS_PORT || 6122)

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('dev doubao realtime voice relay\n')
})

const wss = new WebSocketServer({ server, path: PATH })

wss.on('connection', (socket) => {
  const session = createRealtimeVoiceSession()
  const client = {
    send: (data: string | Uint8Array) => {
      if (socket.readyState === socket.OPEN)
        socket.send(data)
    },
    close: (code?: number, reason?: string) => {
      try {
        socket.close(code, reason)
      }
      catch {}
    },
  }

  session.attachClient(client)

  socket.on('message', (data, isBinary) => {
    const payload = isBinary
      ? (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer))
      : data.toString()
    session.handleClientMessage({ data: payload }, client)
  })

  socket.on('close', () => {
    session.close()
  })

  socket.on('error', () => {
    session.close()
  })
})

server.listen(PORT, HOST, () => {
  console.info(`[dev:doubao-ws] ws://${HOST}:${PORT}${PATH}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    wss.close()
    server.close(() => process.exit(0))
  })
}
