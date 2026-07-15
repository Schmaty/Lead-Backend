import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/setup/global-setup.ts'],
    // Test files share one Postgres database; run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    // First run may download embedded Postgres binaries.
    hookTimeout: 240_000,
    include: ['tests/**/*.test.ts'],
  },
})
