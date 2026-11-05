import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Workspace packages ship TypeScript source and the ACP SDK is ESM-only: bundle them into the
// CJS main output (electron-updater too, so only node-pty ships in node_modules). Native node-pty and the Claude ACP adapter (spawned as a process) stay external.
const bundled = ['@workhub/core', '@workhub/adapters', '@agentclientprotocol/sdk', 'zod', 'electron-updater']

interface Brand {
  repo: { owner: string; name: string }
}

export default defineConfig(async () => {
  // The release repository is named in scripts/brand.mjs only (plain JavaScript, so loaded by URL).
  const { BRAND } = (await import(new URL('../../scripts/brand.mjs', import.meta.url).href)) as { BRAND: Brand }
  return {
    main: {
      build: { externalizeDeps: { exclude: bundled } },
      define: { __WORKHUB_RELEASE_REPO__: JSON.stringify(`${BRAND.repo.owner}/${BRAND.repo.name}`) }
    },
    preload: {},
    renderer: {
      plugins: [react(), tailwindcss()],
      resolve: { alias: { '@shared': resolve('src/shared') } }
    }
  }
})
