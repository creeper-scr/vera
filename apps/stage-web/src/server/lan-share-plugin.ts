import type { Plugin } from 'vite'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

const OBFUSCATE_KEY = 0x5A

export interface LanShareState {
  exportJson: string | null
  updatedAt: number | null
}

/**
 * XOR + base64 — demo-grade obfuscation, not real secret storage.
 */
export function obfuscateSecret(plain: string, key = OBFUSCATE_KEY): string {
  const input = Buffer.from(plain, 'utf8')
  const out = Buffer.alloc(input.length)
  for (let i = 0; i < input.length; i++)
    out[i] = input[i]! ^ key
  return out.toString('base64')
}

/**
 * Lists non-internal IPv4 addresses for LAN QR links.
 */
export function listLanIpv4Addresses(): string[] {
  const nets = networkInterfaces()
  const ips: string[] = []
  for (const entries of Object.values(nets)) {
    if (!entries)
      continue
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal)
        ips.push(entry.address)
    }
  }
  return ips
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (chunks.reduce((n, c) => n + c.length, 0) > 32 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}

function sendText(res: import('node:http').ServerResponse, status: number, body: string, contentType: string) {
  res.statusCode = status
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/**
 * Dev-only LAN share: chat export JSON + mobile.html over the Vite HTTP server.
 */
export function lanSharePlugin(options: {
  /** Absolute path to `lan/mobile.html` template. */
  mobileHtmlPath: string
  /** Doubao realtime relay port (JSON protocol). @default 6122 */
  doubaoRelayPort?: number
}): Plugin {
  const state: LanShareState = {
    exportJson: null,
    updatedAt: null,
  }
  const doubaoRelayPort = options.doubaoRelayPort
    ?? Number(process.env.DOUBAO_REALTIME_WS_PORT || 6122)

  return {
    name: 'vera-lan-share',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const rawUrl = req.url ?? '/'
          const pathname = rawUrl.split('?')[0] ?? '/'

          if (pathname === '/lan/info' && req.method === 'GET') {
            const port = server.config.server.port ?? 5173
            const httpsEnabled = Boolean(server.config.server.https)
            const scheme = httpsEnabled ? 'https' : 'http'
            const ips = listLanIpv4Addresses()
            const origins = ips.map(ip => `${scheme}://${ip}:${port}`)
            sendJson(res, 200, {
              port,
              ips,
              https: httpsEnabled,
              hasExport: state.exportJson != null,
              updatedAt: state.updatedAt,
              mobilePaths: origins.map(origin => `${origin}/lan/mobile.html`),
              exportPaths: origins.map(origin => `${origin}/lan/export.json`),
              doubaoRelayPort,
              /** Same-origin WS path (proxied by Vite → local Doubao relay). */
              doubaoWsPath: '/api/v1/audio/realtime/ws',
            })
            return
          }

          if (pathname === '/lan/export' && req.method === 'POST') {
            const body = await readBody(req)
            const parsed = JSON.parse(body) as { format?: string }
            if (parsed.format !== 'chat-sessions-index:v1') {
              sendJson(res, 400, { error: 'expected chat-sessions-index:v1' })
              return
            }
            state.exportJson = JSON.stringify(parsed)
            state.updatedAt = Date.now()
            sendJson(res, 200, { ok: true, updatedAt: state.updatedAt, bytes: state.exportJson.length })
            return
          }

          if (pathname === '/lan/export.json' && req.method === 'GET') {
            if (state.exportJson == null) {
              sendJson(res, 404, { error: 'no export published yet — click Share on PC first' })
              return
            }
            sendText(res, 200, state.exportJson, 'application/json; charset=utf-8')
            return
          }

          if (pathname === '/lan/mobile.html' && req.method === 'GET') {
            if (!existsSync(options.mobileHtmlPath)) {
              sendText(res, 500, 'mobile.html template missing', 'text/plain; charset=utf-8')
              return
            }
            const appId = String(process.env.VITE_VOLCENGINE_APP_ID ?? '').trim()
            const accessKey = String(process.env.VITE_VOLCENGINE_ACCESS_KEY ?? '').trim()
            const config = {
              exportUrl: '/lan/export.json',
              /**
               * Same-origin path; mobile page picks ws:/wss: from location.protocol
               * so HTTPS demos are not blocked by mixed content.
               */
              wsPath: '/api/v1/audio/realtime/ws',
              /** @deprecated kept for older cached HTML; prefer wsPath */
              wsUrl: '',
              /** Obfuscated `appId\\naccessKey` */
              cred: obfuscateSecret(`${appId}\n${accessKey}`),
              botName: 'Vera',
              hasCred: Boolean(appId && accessKey),
            }
            let html = readFileSync(options.mobileHtmlPath, 'utf8')
            html = html.replace(
              '/*__LAN_CONFIG__*/',
              `window.__LAN__=${JSON.stringify(config)};`,
            )
            sendText(res, 200, html, 'text/html; charset=utf-8')
            return
          }

          next()
        }
        catch (error) {
          sendJson(res, 500, {
            error: errorMessageFrom(error) ?? 'lan share error',
          })
        }
      })
    },
  }
}

/**
 * Resolves default `lan/mobile.html` next to the stage-web package root.
 */
export function defaultMobileHtmlPath(stageWebRoot: string): string {
  return join(stageWebRoot, 'lan', 'mobile.html')
}
