import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each database test file builds a fresh database from every migration in beforeAll.
    // On shared CI runners, several of those in parallel can take well over the 10s default.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
})
