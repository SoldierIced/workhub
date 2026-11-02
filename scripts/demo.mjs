#!/usr/bin/env node
// `npm run demo`: the dev build with every demo source on and an isolated data folder, seeded on
// first run with "a day of a team lead" (a ready profile, a calendar, milestones, an inbox and
// metric alerts). Nothing here reads or writes your real data.
//
//   npm run demo               start (or resume) the demo in <repo>/.demo-data
//   npm run demo -- --reset    wipe that folder first, so the scenario is seeded again
//
// Every number, person and ticket in the scenario is made up.
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = join(root, '.demo-data')
const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run demo [-- --reset]\n\n  --reset  wipe .demo-data first, so the scenario is seeded again')
  process.exit(0)
}
const unknown = args.filter((a) => a !== '--reset')
if (unknown.length > 0) {
  console.error(`Unknown option: ${unknown.join(' ')}. Try: npm run demo -- --help`)
  process.exit(2)
}

if (args.includes('--reset') && existsSync(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true })
  console.log(`demo: wiped ${dataDir}`)
}

const env = {
  ...process.env,
  WORKHUB_DATA_DIR: dataDir,
  WORKHUB_DEMO_SCENARIO: 'team-lead',
  WORKHUB_DEMO_TICKETS: '1',
  WORKHUB_DEMO_CODEHOST: '1',
  WORKHUB_DEMO_SLACK: '1',
  WORKHUB_DEMO_HEALTH: '1',
  WORKHUB_DEMO_USAGE: '1',
  WORKHUB_DEMO_CALENDAR: '1'
}

console.log(`demo: data folder ${dataDir}`)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const child = spawn(npm, ['run', 'dev', '-w', '@workhub/app'], { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
