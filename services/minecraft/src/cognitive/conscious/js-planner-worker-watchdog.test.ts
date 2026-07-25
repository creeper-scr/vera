import type { SandboxWorkerRequest } from './js-planner-sandbox-protocol'

import { fork } from 'node:child_process'
import { realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

/**
 * Regression: sandbox workers orphaned as CPU-spinning zombies when the parent
 * dies mid-evaluation while the host event loop is wedged.
 *
 * process.on('disconnect') only runs when the main loop is free. A busy
 * `while (true) {}` on the host thread prevents disconnect from firing, so a
 * worker_threads parent-liveness watchdog must SIGKILL the worker process.
 *
 * Two layers:
 * 1. Mechanism — synthetic busy-loop child mirrors the watchdog (proves SIGKILL-self
 *    works when the main loop is wedged; isolate alone does not wedge the host).
 * 2. Real path — forks the actual js-planner-worker.ts with the same execArgv as
 *    js-planner-sandbox-runner, sends evaluate(while(true){}), SIGKILLs the
 *    intermediate parent, asserts the real worker exits.
 */

const require = createRequire(import.meta.url)

const SANDBOX_WORKER_ENTRY_PATH = realpathSync(fileURLToPath(new URL('./js-planner-worker.ts', import.meta.url)))
const ISOLATED_VM_ENTRY_PATH = realpathSync(require.resolve('isolated-vm'))
const SANDBOX_SOURCE_DIRECTORY = realpathSync(dirname(SANDBOX_WORKER_ENTRY_PATH))

function ancestorPath(path: string, levels: number): string {
  let current = path
  for (let index = 0; index < levels; index++)
    current = dirname(current)
  return current
}

const PNPM_MODULE_STORE_PATH = realpathSync(ancestorPath(ISOLATED_VM_ENTRY_PATH, 4))

/** Same permission surface as js-planner-sandbox-runner. */
const SANDBOX_EXEC_ARGV = [
  '--permission',
  '--allow-worker',
  '--allow-addons',
  `--allow-fs-read=${SANDBOX_SOURCE_DIRECTORY}`,
  `--allow-fs-read=${PNPM_MODULE_STORE_PATH}`,
  // NOTICE: node-gyp-build probes /etc/alpine-release during isolated-vm load.
  '--allow-fs-read=/etc',
  '--disable-proto=throw',
  '--frozen-intrinsics',
  '--experimental-transform-types',
  '--no-warnings',
]

const mechanismChildPath = join(tmpdir(), `js-planner-watchdog-mechanism-child-${process.pid}.mjs`)
const intermediateParentPath = join(tmpdir(), `js-planner-watchdog-intermediate-${process.pid}.mjs`)

const aliveChildren = new Set<number>()

afterEach(() => {
  for (const pid of aliveChildren) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {
      // already gone
    }
  }
  aliveChildren.clear()
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate())
      return true
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  return predicate()
}

function writeMechanismChild(intervalMs: number): void {
  // Mirrors js-planner-worker.ts parent-liveness watchdog (shorter interval for tests).
  writeFileSync(mechanismChildPath, `
import process from 'node:process'
import { Worker as WatchdogWorker } from 'node:worker_threads'

const parentPid = process.ppid
const parentWatchdog = new WatchdogWorker(\`
  const { workerData } = require('node:worker_threads')
  setInterval(() => {
    try {
      process.kill(workerData.parentPid, 0)
    }
    catch (error) {
      if (!error || error.code !== 'ESRCH')
        return
      try { process.kill(workerData.selfPid, 'SIGKILL') } catch {}
    }
  }, ${intervalMs})
\`, {
  eval: true,
  workerData: { parentPid, selfPid: process.pid },
})
parentWatchdog.unref()

process.stderr.write('ready\\n')

setTimeout(() => {
  while (true) {}
}, 50)
`, 'utf8')
}

/**
 * Intermediate parent: forks a child with given entry/args/execArgv, publishes
 * child pid + ready, optional auto-evaluate payload, then stays alive until
 * the harness SIGKILLs it (simulating the host process dying mid-evaluation).
 */
function writeIntermediateParent(): void {
  writeFileSync(intermediateParentPath, `
import { fork } from 'node:child_process'
import process from 'node:process'

const config = JSON.parse(process.argv[2])
const child = fork(config.entry, config.args ?? [], {
  cwd: config.cwd,
  env: config.env ?? {},
  execArgv: config.execArgv,
  serialization: config.serialization,
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
})

process.stdout.write(JSON.stringify({ childPid: child.pid }) + '\\n')

child.stderr?.on('data', (chunk) => {
  // Mechanism child signals ready on stderr; real worker uses IPC 'ready'.
  process.stderr.write(chunk)
})

child.on('message', (message) => {
  if (message && message.type === 'ready') {
    process.stdout.write(JSON.stringify({ ready: true }) + '\\n')
    if (config.evaluatePayload)
      child.send({ type: 'evaluate', payload: config.evaluatePayload })
  }
})

// Keep parent alive until the harness SIGKILLs it.
setInterval(() => {}, 1000)
`, 'utf8')
}

function buildInfiniteLoopRequest(timeoutMs: number): SandboxWorkerRequest {
  return {
    bootstrapScript: 'void 0',
    bridgeAvailability: {
      botCall: false,
      forgetConversation: false,
      getNoActionBudget: false,
      notifyVera: false,
      patternFind: false,
      patternGet: false,
      patternIds: false,
      patternList: false,
      queryBlockAt: false,
      queryMap: false,
      setNoActionBudget: false,
      updateVeraContext: false,
    },
    memoryLimitMb: 32,
    runtime: {
      actionQueue: null,
      currentInput: null,
      errorBurstGuard: null,
      event: {
        type: 'perception',
        payload: { type: 'chat_message' },
        source: { type: 'minecraft', id: 'watchdog-e2e' },
        timestamp: Date.now(),
      },
      historySeed: {
        conversationHistory: [],
        currentTurn: 0,
        llmLogEntries: [],
      },
      lastAction: null,
      llmInput: null,
      llmLogEntries: [],
      mem: {},
      noActionBudget: null,
      prevRun: null,
      querySeed: null,
      snapshot: {
        self: { location: { x: 0, y: 64, z: 0 } },
      },
    },
    // Long isolate timeout so parent death is the exit reason, not script timeout.
    script: 'while (true) {}',
    timeoutMs,
    toolNames: [],
  }
}

describe('js-planner sandbox parent-liveness watchdog', () => {
  it('mechanism: exits within ~1s after parent SIGKILL when host is busy-looping', async () => {
    // ROOT CAUSE:
    //
    // If the sandbox worker's parent dies while user code blocks the host event
    // loop, process.on('disconnect') never fires and the worker becomes a
    // permanent CPU-spinning orphan (observed: dozens of zombies at 60-95% CPU).
    //
    // disconnect handler previously only rejected pending bridge promises.
    //
    // We fixed this by:
    // 1. process.exit(1) on disconnect when the loop is free
    // 2. worker_threads parent-liveness watchdog that SIGKILLs self on ESRCH
    //    for process.kill(parentPid, 0) — works even when main is wedged
    // 3. --allow-worker on the sandbox fork so Worker construction is permitted
    //    under --permission
    writeMechanismChild(200)
    writeIntermediateParent()

    const intermediate = fork(intermediateParentPath, [JSON.stringify({
      entry: mechanismChildPath,
      args: [],
      cwd: tmpdir(),
      env: {},
      execArgv: [
        '--permission',
        '--allow-worker',
        '--allow-addons',
        `--allow-fs-read=${tmpdir()}`,
        '--no-warnings',
      ],
    })], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    aliveChildren.add(intermediate.pid!)

    let childPid = 0
    let ready = false
    intermediate.stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim())
          continue
        try {
          const msg = JSON.parse(line) as { childPid?: number, ready?: boolean }
          if (typeof msg.childPid === 'number')
            childPid = msg.childPid
          if (msg.ready)
            ready = true
        }
        catch {
          // ignore non-JSON
        }
      }
    })
    intermediate.stderr?.on('data', (chunk) => {
      if (String(chunk).includes('ready'))
        ready = true
    })

    const started = await waitFor(() => childPid > 0 && ready, 5_000)
    expect(started).toBe(true)
    aliveChildren.add(childPid)

    process.kill(intermediate.pid!, 'SIGKILL')
    aliveChildren.delete(intermediate.pid!)

    const exited = await waitFor(() => !isAlive(childPid), 3_000)
    if (exited)
      aliveChildren.delete(childPid)

    expect(exited, `orphan mechanism child pid=${childPid} still alive after parent death`).toBe(true)
  }, 15_000)

  it('real path: js-planner-worker.ts exits after parent SIGKILL mid-evaluate(while(true){})', async () => {
    // Real entry + same execArgv as production runner. Parent dies while the
    // isolate is spinning; worker must not remain as a CPU orphan.
    //
    // Exit may come from either:
    // - process.on('disconnect') → process.exit(1) when the host loop is free
    // - parent-liveness watchdog SIGKILL when the host loop is wedged
    // Both are correct. Failure mode is the worker still alive after ~watchdog period.
    writeIntermediateParent()

    const evaluatePayload = buildInfiniteLoopRequest(30_000)

    const intermediate = fork(intermediateParentPath, [JSON.stringify({
      entry: SANDBOX_WORKER_ENTRY_PATH,
      args: [ISOLATED_VM_ENTRY_PATH],
      cwd: SANDBOX_SOURCE_DIRECTORY,
      env: {},
      execArgv: SANDBOX_EXEC_ARGV,
      serialization: 'advanced',
      evaluatePayload,
    })], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    aliveChildren.add(intermediate.pid!)

    let childPid = 0
    let ready = false
    const stderrChunks: string[] = []

    intermediate.stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim())
          continue
        try {
          const msg = JSON.parse(line) as { childPid?: number, ready?: boolean }
          if (typeof msg.childPid === 'number')
            childPid = msg.childPid
          if (msg.ready)
            ready = true
        }
        catch {
          // ignore
        }
      }
    })
    intermediate.stderr?.on('data', (chunk) => {
      stderrChunks.push(String(chunk))
    })

    const started = await waitFor(() => childPid > 0 && ready, 10_000)
    expect(started, `real worker failed to start. stderr=${stderrChunks.join('')}`).toBe(true)
    aliveChildren.add(childPid)

    // Give evaluate a moment to enter the isolate busy loop before killing parent.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(isAlive(childPid), 'worker died before parent kill — evaluate never entered').toBe(true)

    process.kill(intermediate.pid!, 'SIGKILL')
    aliveChildren.delete(intermediate.pid!)

    // Production watchdog interval is 2000ms; allow one full tick + margin.
    const exited = await waitFor(() => !isAlive(childPid), 5_000)
    if (exited)
      aliveChildren.delete(childPid)

    expect(
      exited,
      `orphan real worker pid=${childPid} still alive after parent death. stderr=${stderrChunks.join('')}`,
    ).toBe(true)
  }, 20_000)
})
