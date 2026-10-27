#!/usr/bin/env node
/**
 * Stages the Claude bridge for packaging into packages/app/.stage/bridge:
 *   - the bridge scripts (packages/adapters/src/agent-claude-native/bridge/*.mjs)
 *   - a private node_modules with the Claude Agent SDK, its peer dependencies, the SDK's native
 *     `claude` binary for the target platform and the claude-agent-acp adapter.
 * electron-builder copies the folder to <resources>/bridge, where main finds it (the bridge runs
 * with Electron's own Node, so it needs no Node install).
 *
 * usage: stage-bridge.mjs [--platform darwin|win32|linux] [--arch x64|arm64]   (default: this machine)
 *        stage-bridge.mjs --update-lock      rewrites scripts/bridge-deps/ after a version bump
 *
 * The bridge's dependency tree is locked in scripts/bridge-deps/package-lock.json and installed with
 * `npm ci --ignore-scripts`, so a build never resolves new versions and never runs install scripts.
 * Its top-level versions are the ones the repo already pins (peers are read from the installed
 * tree); the stage refuses to run when they drift from scripts/bridge-deps/package.json.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stage = join(root, 'packages', 'app', '.stage', 'bridge')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const updateLock = args.includes('--update-lock')
const platform = opt('platform', process.platform)
const arch = opt('arch', process.arch)

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const installed = (name) => readJson(join(root, 'node_modules', ...name.split('/'), 'package.json')).version
const sdkVersion = readJson(join(root, 'packages', 'adapters', 'package.json')).dependencies['@anthropic-ai/claude-agent-sdk']
const acpVersion = readJson(join(root, 'packages', 'app', 'package.json')).dependencies['@agentclientprotocol/claude-agent-acp']

const depsDir = join(root, 'scripts', 'bridge-deps')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const bridgeManifest = {
  name: 'workhub-bridge',
  private: true,
  type: 'module',
  dependencies: {
    '@anthropic-ai/claude-agent-sdk': sdkVersion,
    '@anthropic-ai/sdk': installed('@anthropic-ai/sdk'),
    '@modelcontextprotocol/sdk': installed('@modelcontextprotocol/sdk'),
    zod: installed('zod'),
    '@agentclientprotocol/claude-agent-acp': acpVersion
  }
}

if (updateLock) {
  // The lockfile records the native `claude` package of every platform, so one lock serves all.
  mkdirSync(depsDir, { recursive: true })
  writeFileSync(join(depsDir, 'package.json'), `${JSON.stringify(bridgeManifest, null, 2)}\n`)
  execFileSync(npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: depsDir, stdio: 'inherit', shell: process.platform === 'win32' })
  console.log(`bridge lockfile updated in ${depsDir}`)
  process.exit(0)
}

const locked = readJson(join(depsDir, 'package.json')).dependencies
if (JSON.stringify(locked) !== JSON.stringify(bridgeManifest.dependencies)) {
  console.error('scripts/bridge-deps/package.json does not match the versions the repo pins:')
  console.error(`  locked:   ${JSON.stringify(locked)}`)
  console.error(`  expected: ${JSON.stringify(bridgeManifest.dependencies)}`)
  console.error('Run `node scripts/stage-bridge.mjs --update-lock` and commit scripts/bridge-deps/.')
  process.exit(1)
}

if (existsSync(stage)) rmSync(stage, { recursive: true })
mkdirSync(stage, { recursive: true })

const bridgeSrc = join(root, 'packages', 'adapters', 'src', 'agent-claude-native', 'bridge')
for (const file of readdirSync(bridgeSrc).filter((f) => f.endsWith('.mjs'))) cpSync(join(bridgeSrc, file), join(stage, file))

cpSync(join(depsDir, 'package.json'), join(stage, 'package.json'))
cpSync(join(depsDir, 'package-lock.json'), join(stage, 'package-lock.json'))

// npm picks the optional native package of the SDK from --os/--cpu/--libc, so the stage can target
// another platform than the one running this script.
const libc = platform === 'linux' ? ['--libc=glibc'] : []
execFileSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', `--os=${platform}`, `--cpu=${arch}`, ...libc], {
  cwd: stage,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

const native = join(stage, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}-${arch}`)
if (!existsSync(native)) {
  console.error(`The Claude native package for ${platform}-${arch} was not installed (${native}).`)
  process.exit(1)
}
console.log(`bridge staged for ${platform}-${arch} in ${stage}`)
