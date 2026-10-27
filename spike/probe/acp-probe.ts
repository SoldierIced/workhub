// Headless probe: npx tsx probe/acp-probe.ts <kiro|claude>
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpAgentSession, AGENT_COMMANDS, type AgentName } from '../src/shared/acp-client'

const PROMPT =
  'List the names of the MCP servers and MCP tools you have available. Names only, no explanation.'

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workhub2 = resolve(spikeRoot, '..')

const agent = process.argv[2] as AgentName
if (!(agent in AGENT_COMMANDS)) {
  console.error(`usage: tsx probe/acp-probe.ts <${Object.keys(AGENT_COMMANDS).join('|')}>`)
  process.exit(2)
}

mkdirSync(join(spikeRoot, 'probe/out'), { recursive: true })
const log = createWriteStream(join(spikeRoot, `probe/out/${agent}.jsonl`))
const record = (kind: string, payload: unknown) =>
  log.write(
    JSON.stringify({ t: new Date().toISOString(), kind, payload }, (k, v) =>
      // OAuth URLs carry PKCE state; keep only origin + path in the log.
      k === 'oauthUrl' && typeof v === 'string' ? v.split('?')[0] + '?<redacted>' : v
    ) + '\n'
  )

const section = (title: string, value: unknown) =>
  console.log(`\n=== ${title} ===\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

let answer = ''
const toolCalls: string[] = []
const updateKinds = new Set<string>()

const session = new AcpAgentSession(agent, spikeRoot, {
  onRaw: (dir, msg) => record(dir, msg),
  onStderr: (line) => record('stderr', line),
  onExit: (code) => record('exit', code),
  onUpdate: (n) => {
    const u = n.update
    updateKinds.add(u.sessionUpdate)
    if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') answer += u.content.text
    if (u.sessionUpdate === 'tool_call') toolCalls.push(`${u.title} [${u.kind ?? '?'}]`)
  },
  // The probe prompt only asks for names; deny anything that asks for permission and log it.
  onPermission: async (req) => {
    section('permission request (denied by probe)', req)
    const reject = req.options.find((o) => o.kind.startsWith('reject'))
    return reject
      ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }
})

const timeout = setTimeout(() => {
  console.error('probe timed out after 180s')
  void session.stop().then(() => process.exit(1))
}, 180_000)

async function main(): Promise<void> {
try {
  const { init, session: created } = await session.start(workhub2)
  section('initialize.agentInfo', init.agentInfo ?? null)
  section('initialize.agentCapabilities', init.agentCapabilities)
  section('initialize.authMethods', init.authMethods ?? [])
  section('initialize._meta', init._meta ?? null)
  section('session/new response', created)
  const stop = await session.prompt(PROMPT)
  section('streamed answer', answer)
  section('stopReason', stop)
  section('tool calls', toolCalls)
  section('session/update kinds seen', [...updateKinds])
} catch (e) {
  section('probe error', String(e instanceof Error ? (e.stack ?? e.message) : JSON.stringify(e)))
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  await session.stop()
  log.end()
}
}

void main()
