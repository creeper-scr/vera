#!/usr/bin/env node
import process from 'node:process'

/**
 * One-shot game companion loop:
 * stage-web + server-runtime + minecraft-bot + local Doubao realtime relay.
 *
 * Config (first hit wins):
 * 1. `.env.play.local` (repo root)
 * 2. `services/minecraft/.env.local`  ← add VITE_VOLCENGINE_* here if you already use this file
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const playExample = join(root, '.env.play.example')
const playLocal = join(root, '.env.play.local')
const mcExample = join(root, 'services', 'minecraft', '.env.example')
const mcLocal = join(root, 'services', 'minecraft', '.env.local')
const doubaoPort = Number(process.env.DOUBAO_REALTIME_WS_PORT || 6122)
const doubaoWsUrl = `ws://127.0.0.1:${doubaoPort}/api/v1/audio/realtime/ws`

/**
 * @param {string} text
 * @returns {Record<string, string>} Parsed key-value env entries.
 */
function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0)
      continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** @returns {{ path: string, env: Record<string, string> } | undefined} Play config file path and parsed env, if present. */
function resolvePlayConfig() {
  if (existsSync(playLocal))
    return { path: playLocal, env: parseEnv(readFileSync(playLocal, 'utf8')) }
  if (existsSync(mcLocal))
    return { path: mcLocal, env: parseEnv(readFileSync(mcLocal, 'utf8')) }
  return undefined
}

const config = resolvePlayConfig()
if (!config) {
  const bootstrap = existsSync(playExample) ? playExample : mcExample
  const target = existsSync(playExample) ? playLocal : mcLocal
  if (!existsSync(bootstrap)) {
    console.error('[dev:play] missing .env.play.example (or services/minecraft/.env.example)')
    process.exit(1)
  }
  copyFileSync(bootstrap, target)
  console.error(`[dev:play] created ${target.replace(`${root}/`, '')} from example`)
  console.error('[dev:play] fill OPENAI_API_KEY + VITE_VOLCENGINE_APP_ID + VITE_VOLCENGINE_ACCESS_KEY, then re-run: pnpm dev:play')
  process.exit(1)
}

const missing = [
  'OPENAI_API_KEY',
  'VITE_VOLCENGINE_APP_ID',
  'VITE_VOLCENGINE_ACCESS_KEY',
].filter(key => !config.env[key]?.trim())

if (missing.length > 0) {
  console.error(`[dev:play] config: ${config.path.replace(`${root}/`, '')}`)
  console.error(`[dev:play] missing: ${missing.join(', ')}`)
  if (config.path === mcLocal) {
    console.error('[dev:play] add to services/minecraft/.env.local:')
    console.error('  VITE_VOLCENGINE_APP_ID=...')
    console.error('  VITE_VOLCENGINE_ACCESS_KEY=...')
  }
  process.exit(1)
}

for (const [key, value] of Object.entries(config.env)) {
  if (process.env[key] == null || process.env[key] === '')
    process.env[key] = value
}

process.env.DOUBAO_REALTIME_WS_PORT = String(doubaoPort)
if (process.env.VITE_DOUBAO_REALTIME_WS_URL == null || process.env.VITE_DOUBAO_REALTIME_WS_URL === '')
  process.env.VITE_DOUBAO_REALTIME_WS_URL = doubaoWsUrl

console.info(`[dev:play] config: ${config.path.replace(`${root}/`, '')}`)
console.info('[dev:play] starting stage-web + server-runtime(:6121) + minecraft-bot + doubao-ws')
console.info(`[dev:play] doubao relay: ${process.env.VITE_DOUBAO_REALTIME_WS_URL}`)
console.info('[dev:play] open Vite URL → Minecraft → attach. World at BOT_HOSTNAME:BOT_PORT')

/** @type {import('node:child_process').ChildProcess[]} */
const children = []

let shuttingDown = false

function spawnChild(command, args, label) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  })
  children.push(child)
  child.on('exit', (code, signal) => {
    if (shuttingDown)
      return
    console.error(`[dev:play] ${label} exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    shutdown(code ?? 1)
  })
  return child
}

/**
 * @param {number | null} code
 */
function shutdown(code) {
  if (shuttingDown)
    return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed)
      child.kill('SIGTERM')
  }
  process.exit(code ?? 1)
}

spawnChild(
  'pnpm',
  ['--filter', '@proj-vera/server', 'exec', 'tsx', './scripts/dev-doubao-realtime-ws.ts'],
  'doubao-ws',
)

spawnChild(
  'pnpm',
  [
    '--parallel',
    '--filter',
    '@proj-vera/stage-web',
    '--filter',
    '@proj-vera/server-runtime',
    '--filter',
    '@proj-vera/minecraft-bot',
    'run',
    'dev',
  ],
  'play-stack',
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true
    for (const child of children) {
      if (!child.killed)
        child.kill(signal)
    }
  })
}
