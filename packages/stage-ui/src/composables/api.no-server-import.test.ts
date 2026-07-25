import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

describe('stage-ui api client boundary', () => {
  it('does not import the hosted backend app module', () => {
    const source = readFileSync(join(here, 'api.ts'), 'utf8')
    const importLines = source
      .split('\n')
      .filter(line => /^\s*import\b/.test(line))
      .join('\n')

    expect(importLines).not.toMatch(/apps\/server/)
    expect(importLines).not.toMatch(/from ['"][^'"]*\/app['"]/)
  })
})
