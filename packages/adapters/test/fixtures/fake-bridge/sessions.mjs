// A fake of sessions.mjs: prints canned sessions, tagged with the account's CLAUDE_CONFIG_DIR.
// `rename` writes its arguments to FAKE_SESSIONS_LOG.
import { writeFileSync } from 'node:fs'
const [command, ...args] = process.argv.slice(2)
const account = process.env.CLAUDE_CONFIG_DIR ?? 'default'
if (command === 'all') {
  process.stdout.write(JSON.stringify([
    { sessionId: 'sess-1', summary: 'Fix the build', customTitle: 'Build fix', firstPrompt: 'fix it', lastModified: 2000, cwd: '/tmp/acme-web', gitBranch: 'main', createdAt: 1000 },
    { sessionId: 'sess-2', summary: `Account ${account}`, lastModified: 1500 },
    { summary: 'no id, skipped' }
  ]))
} else if (command === 'messages' && args[1] === '/tmp/moved') {
  // The transcript is not under this folder: found only when every project is searched.
  process.stdout.write('[]')
} else if (command === 'messages') {
  process.stdout.write(JSON.stringify([
    { type: 'user', parent_tool_use_id: null, message: { content: `hello from ${args[0]} in ${args[1]}` } }
  ]))
} else if (command === 'rename' && process.env.FAKE_SESSIONS_LOG) {
  writeFileSync(process.env.FAKE_SESSIONS_LOG, JSON.stringify({ args, account }))
  process.stdout.write(JSON.stringify({ ok: true }))
} else {
  process.stdout.write(JSON.stringify({ error: `Unknown command: ${command}` }))
  process.exitCode = 1
}
