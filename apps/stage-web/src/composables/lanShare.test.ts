import { describe, expect, it } from 'vitest'

import { lanQrImageUrl } from './lanShare'

describe('lanShare', () => {
  it('builds a qr image url with encoded mobile page', () => {
    const url = lanQrImageUrl('http://192.168.1.8:5173/lan/mobile.html')
    expect(url).toContain('api.qrserver.com')
    expect(url).toContain(encodeURIComponent('http://192.168.1.8:5173/lan/mobile.html'))
  })
})
