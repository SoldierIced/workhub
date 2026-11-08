import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/protocol', 'packages/adapters', 'packages/app']
  }
})
