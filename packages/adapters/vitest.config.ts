import { defineConfig } from 'vitest/config'

// Tests that spawn git, or write SQLite files, take several seconds on Windows runners (process
// start-up and file scanning are slow there), so they get a longer limit on that platform only.
const windows = process.platform === 'win32'

export default defineConfig({
  test: { name: 'adapters', include: ['test/**/*.test.ts'], environment: 'node', ...(windows ? { testTimeout: 60_000, hookTimeout: 60_000 } : {}) }
})
