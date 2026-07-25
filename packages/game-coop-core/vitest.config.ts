import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@proj-vera/game-coop-core',
    include: ['src/**/*.test.ts'],
  },
})
