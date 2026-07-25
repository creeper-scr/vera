import { describe, expect, it } from 'vitest'

/**
 * Pure helpers mirroring the web companion attach rules in index.vue.
 * Kept free of Pinia / WS so unit tests stay fast and auth-free.
 */

/** Builds a fresh local session id for a selected adapter. */
export function createCompanionSessionId(adapterId: string, nonce: string): string {
  return `web-${adapterId}-${nonce}`
}

/** Decides whether connect may start world observations. */
export function canStartWorldObservations(channelConnected: boolean): boolean {
  return channelConnected
}

/** Static catalog exposed by the web companion console. */
export const WEB_GAME_CATALOG = [
  { adapterId: 'minecraft', displayName: 'Minecraft' },
  { adapterId: 'stardew', displayName: 'Stardew Valley' },
  { adapterId: 'dst', displayName: 'Don\'t Starve Together' },
] as const

describe('web companion attach (no auth)', () => {
  it('builds session ids without hosted user identity', () => {
    expect(createCompanionSessionId('minecraft', 'abc123')).toBe('web-minecraft-abc123')
    expect(createCompanionSessionId('stardew', 'x')).toBe('web-stardew-x')
  })

  it('requires only the local server-runtime channel, not login', () => {
    expect(canStartWorldObservations(false)).toBe(false)
    expect(canStartWorldObservations(true)).toBe(true)
  })

  it('exposes minecraft + stardew + dst adapters', () => {
    expect(WEB_GAME_CATALOG.map(entry => entry.adapterId)).toEqual([
      'minecraft',
      'stardew',
      'dst',
    ])
  })
})
