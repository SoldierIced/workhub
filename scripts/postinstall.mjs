#!/usr/bin/env node
/**
 * Root postinstall: downloads the Electron binary, then makes node-pty loadable by it.
 *
 * node-pty is N-API, so one binary works for Node and Electron alike (no ABI rebuild needed).
 *  - Windows: node-pty ships prebuilt win32-x64/arm64 binaries (conpty included). Rebuilding them
 *    from source needs a Visual Studio workload with Spectre-mitigated libraries, because node-pty's
 *    gyp files set SpectreMitigation: Spectre (MSB8040 otherwise), so the prebuilds are used as is.
 *  - macOS/Linux: rebuild with electron-rebuild. On macOS this also fixes the missing execute bit
 *    of the prebuilt spawn-helper; Linux has no prebuilds and compiles here.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

run(process.execPath, [join('node_modules', 'electron', 'install.js')])

// The repo's own hooks (.githooks): they block commits and pushes carrying private terms, and do
// nothing until the developer keeps a terms file (see scripts/check-private-terms.sh).
if (existsSync(join(root, '.git')) && !process.env.CI) spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' })

const prebuilt = join(root, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`)
if (process.platform === 'win32' && existsSync(prebuilt)) {
  console.log(`node-pty: using the prebuilt binaries in ${prebuilt} (no rebuild)`)
} else {
  run('electron-rebuild', ['-f', '-w', 'node-pty', '-m', 'packages/app'])
}
