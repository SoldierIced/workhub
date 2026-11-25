import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer's `@shared` alias, as electron.vite.config.ts sets it, so tests can load renderer modules that use it.
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: { name: 'app', include: ['test/**/*.test.ts'], environment: 'node' }
})
