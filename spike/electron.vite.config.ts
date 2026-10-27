import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // The ACP SDK is ESM-only; bundle it into the (CJS) main output. node-pty stays external.
    build: { externalizeDeps: { exclude: ['@agentclientprotocol/sdk'] } }
  },
  preload: {},
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
