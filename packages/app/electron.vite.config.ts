import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Workspace packages ship TypeScript source and the ACP SDK is ESM-only: bundle them into the
// CJS main output (electron-updater too, so only node-pty ships in node_modules). Native node-pty and the Claude ACP adapter (spawned as a process) stay external.
const bundled = ['@workhub/core', '@workhub/adapters', '@workhub/protocol', '@noble/curves', '@noble/ciphers', '@noble/hashes', '@agentclientprotocol/sdk', 'zod', 'electron-updater']

interface Brand {
  appId: string
  repo: { owner: string; name: string }
  relay: string
}

export default defineConfig(async () => {
  // The release repository and the app id are named in scripts/brand.mjs only (plain JavaScript, so loaded by URL).
  const { BRAND } = (await import(new URL('../../scripts/brand.mjs', import.meta.url).href)) as { BRAND: Brand }
  return {
    main: {
      build: {
        externalizeDeps: { exclude: bundled },
        // The analytics and transcript workers run in their own utility processes (out/main/analytics-worker.js, transcript-worker.js);
        // the workhub host (out/main/host.js) runs as a child process on Node (WORKHUB_HOST=child).
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            'analytics-worker': resolve('src/main/analytics-worker.ts'),
            'transcript-worker': resolve('src/main/transcript-worker.ts'),
            host: resolve('src/main/host-entry.ts')
          }
        }
      },
      define: { __WORKHUB_RELEASE_REPO__: JSON.stringify(`${BRAND.repo.owner}/${BRAND.repo.name}`), __WORKHUB_DEFAULT_RELAY__: JSON.stringify(BRAND.relay), __WORKHUB_APP_ID__: JSON.stringify(BRAND.appId) }
    },
    preload: {},
    renderer: {
      plugins: [react(), tailwindcss()],
      resolve: { alias: { '@shared': resolve('src/shared') } }
    }
  }
})
