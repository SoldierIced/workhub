import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The phone app (Workhub Remote's web client): a static site the relay serves. Two builds share
 * this file: the app (`src/web/index.html`) and the service worker (`src/web/sw.ts`, a single
 * classic script at `/sw.js`). `scripts/build-web.mjs` runs both; `WORKHUB_WEB_OUT` picks the folder.
 */
const outDir = process.env['WORKHUB_WEB_OUT'] ?? resolve(__dirname, '../relay/web-client')
const target = process.env['WORKHUB_WEB_TARGET'] ?? 'app'

export default defineConfig(
  target === 'sw'
    ? {
        root: resolve(__dirname, 'src/web'),
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          lib: { entry: resolve(__dirname, 'src/web/sw.ts'), formats: ['iife'], name: 'workhubSw', fileName: () => 'sw.js' },
          rollupOptions: { output: { inlineDynamicImports: true } },
          target: 'es2020',
          minify: true
        }
      }
    : {
        root: resolve(__dirname, 'src/web'),
        publicDir: resolve(__dirname, 'src/web/public'),
        plugins: [react(), tailwindcss()],
        resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
        build: { outDir, emptyOutDir: false, target: 'es2020', sourcemap: false },
        server: { port: 5180 }
      }
)
