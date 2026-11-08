// Builds the phone app into packages/relay/web-client (or WORKHUB_WEB_OUT): the app, then the
// service worker. The relay's Docker image copies that folder; see docs/user-guide/remote-access.md.
import { rm, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))
const configFile = resolve(here, '../vite.web.config.ts')
const outDir = process.env.WORKHUB_WEB_OUT ?? resolve(here, '../../relay/web-client')

// Only what a previous build left (the README of that folder is kept).
for (const entry of ['assets', 'icons', 'index.html', 'sw.js', 'manifest.webmanifest']) await rm(resolve(outDir, entry), { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

for (const target of ['app', 'sw']) {
  process.env.WORKHUB_WEB_TARGET = target
  process.env.WORKHUB_WEB_OUT = outDir
  await build({ configFile, mode: 'production', logLevel: 'info' })
}
console.log(`web client built into ${outDir}`)
