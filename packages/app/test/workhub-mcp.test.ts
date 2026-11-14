import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { controlSocketPath, startControlServer } from '../src/main/control-server'

const SCRIPT = resolve(__dirname, '../../adapters/src/agent-claude-native/bridge/workhub-mcp.mjs')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Starts the MCP server as an agent would (stdio) and returns a JSON-RPC caller. */
function mcp(env: Record<string, string>) {
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, WORKHUB_SOCKET: '', WORKHUB_URL: '', WORKHUB_SESSION: '', ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map<number, (v: Record<string, unknown>) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line) as { id: number }
    pending.get(msg.id)?.(msg as unknown as Record<string, unknown>)
  })
  let next = 1
  const rpc = (method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((done) => {
      const id = next++
      pending.set(id, done)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  return { rpc, notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`), close: () => child.kill() }
}

describe.skipIf(process.platform === 'win32')('workhub MCP server', () => {
  it('lists the tools and turns a call into one endpoint request with the session and folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-mcp-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const seen: { what: string; params?: string; body?: unknown }[] = []
    const server = await startControlServer(socket, {
      openReview: (id, repos) => (seen.push({ what: `review ${id}`, body: repos }), { ok: true }),
      automations: {
        list: async (p) => (seen.push({ what: 'list', params: p.toString() }), { status: 200, body: { ok: true, automations: [] } }),
        create: async (b) => (seen.push({ what: 'create', body: b }), { status: 200, body: { ok: true } }),
        update: async (id, b) => (seen.push({ what: `update ${id}`, body: b }), { status: 400, body: { ok: false, error: 'nope' } }),
        history: async (p) => (seen.push({ what: 'history', params: p.toString() }), { status: 200, body: { ok: true, entries: [] } }),
        session: async (a, s) => (seen.push({ what: `session ${a} ${s}` }), { status: 200, body: { ok: true } })
      }
    })
    const client = mcp({ WORKHUB_SOCKET: socket, WORKHUB_SESSION: 'sess-1', WORKHUB_CWD: '/w/acme' })
    try {
      const init = await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      expect(init['result']).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'workhub' }, capabilities: { tools: {} } })
      client.notify('notifications/initialized')
      const list = (await client.rpc('tools/list'))['result'] as { tools: { name: string; inputSchema: { type: string } }[] }
      expect(list.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['plan_today', 'inbox_propose', 'automation_save', 'history_search', 'history_read', 'review_open']))
      expect(list.tools.every((t) => t.inputSchema.type === 'object')).toBe(true)

      const call = async (name: string, args: unknown) => (await client.rpc('tools/call', { name, arguments: args }))['result'] as { isError: boolean; content: { text: string }[] }
      expect((await call('automations_list', {})).isError).toBe(false)
      expect((await call('automation_save', { automation: { name: 'Triage' } })).isError).toBe(false)
      const failed = await call('automation_save', { id: 'a1', automation: { prompt: '/x' } })
      expect(failed).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('nope') }] })
      await call('history_search', { q: 'deploy', limit: 5 })
      await call('history_read', { agentId: 'claude', agentSessionId: 's-1' })
      await call('review_open', { repos: [{ path: dir }] })
      expect(seen).toEqual([
        { what: 'list', params: 'session=sess-1&cwd=%2Fw%2Facme' },
        { what: 'create', body: { automation: { name: 'Triage' }, session: 'sess-1', cwd: '/w/acme' } },
        { what: 'update a1', body: { automation: { prompt: '/x' }, session: 'sess-1', cwd: '/w/acme' } },
        { what: 'history', params: 'q=deploy&limit=5&session=sess-1&cwd=%2Fw%2Facme' },
        { what: 'session claude s-1' },
        { what: 'review sess-1', body: [{ path: dir }] }
      ])
      expect((await client.rpc('nope/method'))['error']).toMatchObject({ code: -32601 })
    } finally {
      client.close()
      server?.close()
    }
  })

  it('says it is not in a Workhub session when no endpoint is set', async () => {
    const client = mcp({})
    try {
      const r = (await client.rpc('tools/call', { name: 'plan_today', arguments: {} }))['result'] as { isError: boolean; content: { text: string }[] }
      expect(r.isError).toBe(true)
      expect(r.content[0]!.text).toMatch(/not reachable/)
    } finally {
      client.close()
    }
  })
})
