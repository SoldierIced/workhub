import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Workspace packages ship TypeScript source and the ACP SDK is ESM-only: bundle them into the
// CJS main output. Native node-pty and the Claude ACP adapter (spawned as a process) stay external.
const bundled = ['@workhub/core', '@workhub/adapters', '@agentclientprotocol/sdk', 'zod']

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: bundled } }
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
