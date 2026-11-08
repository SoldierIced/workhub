import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'relay', include: ['test/**/*.test.ts'], environment: 'node' }
})
