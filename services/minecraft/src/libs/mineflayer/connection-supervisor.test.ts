import type { Logg } from '@guiiai/logg'

import { describe, expect, it, vi } from 'vitest'

import {
  createConnectionSupervisor,
  reconnectDelayMs,
} from './connection-supervisor'

function createLogger(): Logg {
  return {
    log: vi.fn(),
    error: vi.fn(),
    errorWithError: vi.fn(),
    withFields: vi.fn(function (this: Logg) {
      return this
    }),
  } as unknown as Logg
}

describe('reconnectDelayMs', () => {
  it('uses exponential backoff capped by maxDelayMs', () => {
    expect(reconnectDelayMs(1, 1_000, 30_000)).toBe(1_000)
    expect(reconnectDelayMs(2, 1_000, 30_000)).toBe(2_000)
    expect(reconnectDelayMs(3, 1_000, 30_000)).toBe(4_000)
    expect(reconnectDelayMs(10, 1_000, 30_000)).toBe(30_000)
  })
})

describe('createConnectionSupervisor', () => {
  it('backs off before replaceBot and keeps retrying when maxRetries is Infinity', async () => {
    const sleep = vi.fn(async () => {})
    const replaceBot = vi.fn(async () => {})
    const supervisor = createConnectionSupervisor({
      logger: createLogger(),
      reconnect: {
        enabled: true,
        maxRetries: Number.POSITIVE_INFINITY,
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
      },
      sleep,
      replaceBot,
    })

    await supervisor.onDisconnect('socketClosed')
    expect(sleep).toHaveBeenCalledWith(1_000)
    expect(replaceBot).toHaveBeenCalledTimes(1)

    await supervisor.onDisconnect('socketClosed')
    expect(sleep).toHaveBeenLastCalledWith(2_000)
    expect(replaceBot).toHaveBeenCalledTimes(2)
  })

  it('gives up after a finite maxRetries budget', async () => {
    const replaceBot = vi.fn(async () => {})
    const logger = createLogger()
    const supervisor = createConnectionSupervisor({
      logger,
      reconnect: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 0,
      },
      sleep: async () => {},
      replaceBot,
    })

    await supervisor.onDisconnect('socketClosed')
    await supervisor.onDisconnect('socketClosed')

    expect(replaceBot).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Max reconnect attempts (1) reached. Giving up.')
  })

  it('resets attempt counter after spawn', async () => {
    const sleep = vi.fn(async () => {})
    const replaceBot = vi.fn(async () => {})
    const supervisor = createConnectionSupervisor({
      logger: createLogger(),
      reconnect: {
        enabled: true,
        maxRetries: Number.POSITIVE_INFINITY,
        baseDelayMs: 1_000,
      },
      sleep,
      replaceBot,
    })

    await supervisor.onDisconnect('socketClosed')
    supervisor.onSpawn()
    await supervisor.onDisconnect('socketClosed')

    expect(sleep.mock.calls.map(call => call[0])).toEqual([1_000, 1_000])
  })
})
