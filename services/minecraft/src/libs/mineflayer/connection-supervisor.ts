import type { Logg } from '@guiiai/logg'

export interface ReconnectOptions {
  enabled?: boolean
  /**
   * Max reconnect attempts after disconnect.
   * Use `Infinity` (default) for never give up.
   * Finite values give up after that many failed attempts.
   */
  maxRetries?: number
  /** Delay before first reconnect attempt (ms). Default 1000. */
  baseDelayMs?: number
  /** Cap for exponential backoff (ms). Default 30000. */
  maxDelayMs?: number
}

export interface ReconnectContext {
  reason: string
  attempt: number
  maxRetries: number
}

export interface ConnectionSupervisorDeps {
  logger: Logg
  reconnect?: ReconnectOptions
  spawnTimeoutMs?: number
  replaceBot: (context: ReconnectContext) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}

export type ConnectionState = 'idle' | 'awaiting_spawn'

export interface ConnectionSupervisor {
  onDisconnect: (reason: string) => Promise<void> | void
  onSpawn: () => void
  stop: () => void
}

const DEFAULT_RECONNECT_MAX_RETRIES = Number.POSITIVE_INFINITY
const DEFAULT_SPAWN_TIMEOUT_MS = 15_000
const DEFAULT_BASE_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function reconnectDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(attempt - 1, 16)
  return Math.min(maxDelayMs, baseDelayMs * (2 ** exp))
}

export function createConnectionSupervisor(deps: ConnectionSupervisorDeps): ConnectionSupervisor {
  let state: ConnectionState = 'idle'
  let attempts = 0
  let stopping = false
  let spawnWatchdogTimer: ReturnType<typeof setTimeout> | null = null
  let transitionQueue: Promise<void> = Promise.resolve()
  const sleep = deps.sleep ?? defaultSleep

  function clearSpawnWatchdog(): void {
    if (!spawnWatchdogTimer)
      return

    clearTimeout(spawnWatchdogTimer)
    spawnWatchdogTimer = null
  }

  async function enqueue(task: () => Promise<void>): Promise<void> {
    const nextTask = transitionQueue.then(task)

    transitionQueue = nextTask
      .then(() => undefined)
      .catch(() => undefined)

    return nextTask
  }

  function transitionState(nextState: ConnectionState, reason: string): void {
    if (state === nextState)
      return

    const previousState = state
    state = nextState

    if (nextState !== 'awaiting_spawn') {
      clearSpawnWatchdog()
    }
    else {
      clearSpawnWatchdog()

      const timeoutMs = deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
      spawnWatchdogTimer = setTimeout(() => {
        void enqueue(async () => {
          if (stopping || state !== 'awaiting_spawn')
            return

          deps.logger.withFields({
            attempt: attempts,
            timeoutMs,
          }).error('Reconnect attempt timed out before spawn')

          transitionState('idle', 'spawn-timeout')
          await handleDisconnect('spawn-timeout')
        })
      }, timeoutMs)
    }

    deps.logger.withFields({
      from: previousState,
      to: nextState,
      reason,
    }).log('Reconnect state transition')
  }

  async function handleDisconnect(reason: string): Promise<void> {
    if (stopping)
      return

    if (!deps.reconnect?.enabled)
      return

    if (state === 'awaiting_spawn') {
      deps.logger.withFields({ reason }).error('Reconnect interrupted before spawn; retrying')
      transitionState('idle', 'interrupted-before-spawn')
    }

    const maxRetries = deps.reconnect.maxRetries ?? DEFAULT_RECONNECT_MAX_RETRIES
    if (Number.isFinite(maxRetries) && attempts >= maxRetries) {
      deps.logger.error(`Max reconnect attempts (${maxRetries}) reached. Giving up.`)
      return
    }

    attempts += 1
    const baseDelayMs = deps.reconnect.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    const maxDelayMs = deps.reconnect.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    const delayMs = reconnectDelayMs(attempts, baseDelayMs, maxDelayMs)

    transitionState('awaiting_spawn', reason)

    deps.logger.withFields({
      reason,
      attempt: attempts,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : 'unlimited',
      delayMs,
    }).log('Reconnecting...')

    if (delayMs > 0)
      await sleep(delayMs)

    if (stopping) {
      transitionState('idle', 'stop-during-backoff')
      return
    }

    try {
      await deps.replaceBot({
        reason,
        attempt: attempts,
        maxRetries: Number.isFinite(maxRetries) ? maxRetries : Number.POSITIVE_INFINITY,
      })

      deps.logger.log('Reconnect initiated, waiting for spawn...')
    }
    catch (error) {
      deps.logger.errorWithError('Reconnect failed', error as Error)
      transitionState('idle', 'reconnect-error')
      throw error
    }
  }

  const onDisconnect = (reason: string): Promise<void> => {
    return enqueue(async () => {
      await handleDisconnect(reason)
    })
  }

  const onSpawn = (): void => {
    void enqueue(async () => {
      attempts = 0
      transitionState('idle', 'spawn')
    })
  }

  const stop = (): void => {
    if (stopping)
      return

    stopping = true
    attempts = 0
    clearSpawnWatchdog()

    if (state !== 'idle') {
      const previousState = state
      state = 'idle'
      deps.logger.withFields({
        from: previousState,
        to: state,
        reason: 'stop',
      }).log('Reconnect state transition')
    }
  }

  return {
    onDisconnect,
    onSpawn,
    stop,
  }
}

export { reconnectDelayMs }
