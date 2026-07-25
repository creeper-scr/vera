import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@proj-vera/game-bridges',
    include: ['src/**/*.test.ts'],
  },
})
