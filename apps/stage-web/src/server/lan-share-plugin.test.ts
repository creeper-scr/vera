import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { listLanIpv4Addresses, obfuscateSecret } from './lan-share-plugin'

describe('lan-share-plugin helpers', () => {
  it('round-trips obfuscated secrets with XOR key', () => {
    const plain = 'app-id\naccess-key'
    const encoded = obfuscateSecret(plain)
    expect(encoded).not.toContain('app-id')
    const raw = Buffer.from(encoded, 'base64')
    const decoded = Buffer.alloc(raw.length)
    for (let i = 0; i < raw.length; i++)
      decoded[i] = raw[i]! ^ 0x5A
    expect(decoded.toString('utf8')).toBe(plain)
  })

  it('lists lan ipv4 addresses as strings', () => {
    const ips = listLanIpv4Addresses()
    expect(Array.isArray(ips)).toBe(true)
    for (const ip of ips)
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })
})
