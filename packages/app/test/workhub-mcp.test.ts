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
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, WORKHUB_SOCKET: '', WORKHUB_URL: '', WORKHUB_SESSION: '', WORKHUB_SESSION_TOKEN: '', ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
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
  const exited = new Promise<string>((done) => child.once('exit', (code, signal) => done(`exited (code ${code}, signal ${signal})`)))
  const alive = () => child.exitCode === null && child.signalCode === null
  return { rpc, exited, alive, notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`), close: () => child.kill() }
}

describe.skipIf(process.platform === 'win32')('workhub MCP server', () => {
  it('lists the tools and turns a call into one endpoint request with the session and folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-mcp-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const seen: { what: string; params?: string; body?: unknown }[] = []
    const server = await startControlServer(socket, {
      auth: { sessionOf: (t) => (t === 'tok-1' ? 'sess-1' : undefined), readOnly: () => false },
      openReview: (id, repos) => (seen.push({ what: `review ${id}`, body: repos }), { ok: true }),
      automations: {
        list: async (p) => (seen.push({ what: 'list', params: p.toString() }), { status: 200, body: { ok: true, automations: [] } }),
        create: async (b) => (seen.push({ what: 'create', body: b }), { status: 200, body: { ok: true } }),
        update: async (id, b) => (seen.push({ what: `update ${id}`, body: b }), { status: 400, body: { ok: false, error: 'nope' } }),
        history: async (p) => (seen.push({ what: 'history', params: p.toString() }), { status: 200, body: { ok: true, entries: [] } }),
        session: async (a, s) => (seen.push({ what: `session ${a} ${s}` }), { status: 200, body: { ok: true } })
      }
    })
    const client = mcp({ WORKHUB_SOCKET: socket, WORKHUB_SESSION: 'sess-1', WORKHUB_SESSION_TOKEN: 'tok-1', WORKHUB_CWD: '/w/acme' })
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

  it('offers the read-only analytics tools and maps them to the analytics routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-mcp-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const seen: { what: string; params?: string; body?: unknown }[] = []
    const server = await startControlServer(socket, {
      auth: { sessionOf: (t) => (t === 'tok-1' ? 'sess-1' : undefined), readOnly: () => false },
      openReview: () => ({ ok: true }),
      analytics: {
        schema: async (p) => (seen.push({ what: 'schema', params: p.toString() }), { status: 200, body: { ok: true, tables: [] } }),
        query: async (b) => (seen.push({ what: 'query', body: b }), { status: 400, body: { ok: false, error: 'only SELECT or WITH queries are allowed' } }),
        report: async (p) => (seen.push({ what: 'report', params: p.toString() }), { status: 200, body: { ok: true, rows: [] } })
      }
    })
    const client = mcp({ WORKHUB_SOCKET: socket, WORKHUB_SESSION: 'sess-1', WORKHUB_SESSION_TOKEN: 'tok-1', WORKHUB_CWD: '/w/acme' })
    try {
      const list = (await client.rpc('tools/list'))['result'] as { tools: { name: string; description: string; inputSchema: { type: string; properties: Record<string, { enum?: string[] }>; required: string[] } }[] }
      const tool = (name: string) => list.tools.find((t) => t.name === name)!
      expect(tool('analytics_schema').inputSchema).toMatchObject({ type: 'object', properties: {}, required: [] })
      expect(tool('analytics_query').inputSchema).toMatchObject({ type: 'object', required: ['sql'] })
      expect(Object.keys(tool('analytics_query').inputSchema.properties)).toEqual(['sql', 'params', 'limit'])
      expect(tool('usage_report').inputSchema.required).toEqual(['kind'])
      expect(tool('usage_report').inputSchema.properties['kind']!.enum).toEqual(['spend_by_project', 'spend_by_ticket', 'spend_by_tag', 'spend_by_agent', 'weekly'])
      for (const name of ['analytics_schema', 'analytics_query', 'usage_report']) expect(tool(name).description).toMatch(/read-only/)

      const call = async (name: string, args: unknown) => (await client.rpc('tools/call', { name, arguments: args }))['result'] as { isError: boolean; content: { text: string }[] }
      expect((await call('analytics_schema', {})).isError).toBe(false)
      const refused = await call('analytics_query', { sql: 'PRAGMA user_version', params: [1, null], limit: 10 })
      expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('only SELECT') }] })
      expect((await call('usage_report', { kind: 'weekly', since: '2026-11-09' })).isError).toBe(false)
      expect(seen).toEqual([
        { what: 'schema', params: 'session=sess-1&cwd=%2Fw%2Facme' },
        { what: 'query', body: { sql: 'PRAGMA user_version', params: [1, null], limit: 10, session: 'sess-1', cwd: '/w/acme' } },
        { what: 'report', params: 'kind=weekly&since=2026-11-09&session=sess-1&cwd=%2Fw%2Facme' }
      ])
    } finally {
      client.close()
      server?.close()
    }
  })

  it('offers the session tools and maps them to the session routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-mcp-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const seen: { what: string; body?: unknown }[] = []
    const ok = { status: 200, body: { ok: true } }
    const server = await startControlServer(socket, {
      auth: { sessionOf: (t) => (t === 'tok-1' ? 'sess-1' : undefined), readOnly: () => false },
      openReview: () => ({ ok: true }),
      sessions: {
        list: async (caller) => (seen.push({ what: `list ${caller}` }), ok),
        propose: async (caller, b) => (seen.push({ what: `propose ${caller}`, body: b }), { status: 202, body: { ok: true, pending: true } }),
        message: async (caller, target, b) => (seen.push({ what: `message ${caller}>${target}`, body: b }), ok),
        notify: async (caller, b) => (seen.push({ what: `notify ${caller}`, body: b }), ok)
      }
    })
    const client = mcp({ WORKHUB_SOCKET: socket, WORKHUB_SESSION: 'sess-1', WORKHUB_SESSION_TOKEN: 'tok-1', WORKHUB_CWD: '/w/acme' })
    try {
      const list = (await client.rpc('tools/list'))['result'] as { tools: { name: string; description: string; inputSchema: { required: string[] } }[] }
      const tool = (name: string) => list.tools.find((t) => t.name === name)!
      expect(tool('session_propose').inputSchema.required).toEqual(['agent', 'folder', 'prompt'])
      expect(tool('session_propose').description).toMatch(/does NOT start/)
      expect(tool('session_message').inputSchema.required).toEqual(['id', 'text'])
      expect(tool('notify_user').inputSchema.required).toEqual(['title'])
      const call = async (name: string, args: unknown) => (await client.rpc('tools/call', { name, arguments: args }))['result'] as { isError: boolean }
      expect((await call('sessions_list', {})).isError).toBe(false)
      expect((await call('session_propose', { agent: 'claude', folder: '/w/acme/api', prompt: 'Write the tests' })).isError).toBe(false)
      expect((await call('session_message', { id: 'sess-2', text: 'The API is merged' })).isError).toBe(false)
      expect((await call('notify_user', { title: 'Done', body: 'Tests pass' })).isError).toBe(false)
      expect(seen).toEqual([
        { what: 'list sess-1' },
        { what: 'propose sess-1', body: { agent: 'claude', folder: '/w/acme/api', prompt: 'Write the tests', session: 'sess-1', cwd: '/w/acme' } },
        { what: 'message sess-1>sess-2', body: { text: 'The API is merged', session: 'sess-1', cwd: '/w/acme' } },
        { what: 'notify sess-1', body: { title: 'Done', body: 'Tests pass', session: 'sess-1', cwd: '/w/acme' } }
      ])
    } finally {
      client.close()
      server?.close()
    }
  })

  it('offers board_save and sends the board as the whole body, with no session key added', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-mcp-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const seen: unknown[] = []
    const server = await startControlServer(socket, {
      auth: { sessionOf: (t) => (t === 'tok-1' ? 'sess-1' : undefined), readOnly: () => false },
      openReview: () => ({ ok: true }),
      saveBoard: async (board, caller) => (seen.push({ board, session: caller.session }), { ok: false, status: 409, error: 'Live boards is off for this profile' })
    })
    const client = mcp({ WORKHUB_SOCKET: socket, WORKHUB_SESSION: 'sess-1', WORKHUB_SESSION_TOKEN: 'tok-1', WORKHUB_CWD: '/w/acme' })
    try {
      const init = (await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }))['result'] as { instructions: string }
      expect(init.instructions).toMatch(/Live board/)
      expect(init.instructions).toMatch(/heartbeatSeconds/)
      const list = (await client.rpc('tools/list'))['result'] as { tools: { name: string; description: string; inputSchema: { required: string[] } }[] }
      const tool = list.tools.find((t) => t.name === 'board_save')!
      expect(tool.inputSchema.required).toEqual(['board'])
      expect(tool.description).toMatch(/whole board/)
      // The block kinds are the format's own names.
      expect(tool.description).toContain('(steps, graph, list, table, log and text blocks)')
      expect(tool.description).toMatch(/heartbeatSeconds/)
      expect(tool.description).toMatch(/60 s/)
      expect(tool.description).toMatch(/Workhub session/)
      expect(tool.description).toMatch(/workhub-board/)
      // Boards show in the chat that sent them; there is no Live boards screen to point the person to.
      expect(tool.description).not.toMatch(/Live boards screen/)
      expect(tool.description).toMatch(/live-boards\.md/)
      const board = { format: 'workhub.board', version: 1, id: 'b1', title: 'T', status: 'live', blocks: [{ type: 'text', text: 'hi' }] }
      const r = (await client.rpc('tools/call', { name: 'board_save', arguments: { board } }))['result'] as { isError: boolean; content: { text: string }[] }
      expect(r).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('off for this profile') }] })
      // The board is the body as it is: a `session` key beside it would make the strict parser refuse it.
      expect(seen).toEqual([{ board, session: 'sess-1' }])
    } finally {
      client.close()
      server?.close()
    }
  })

  it('sends neither session nor folder without a session token (installed outside Workhub)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-mcp-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const seen: string[] = []
    const server = await startControlServer(socket, {
      auth: { sessionOf: () => undefined, readOnly: () => false },
      openReview: () => ({ ok: true }),
      automations: {
        list: async (p) => (seen.push(`list ${p.toString()}`), { status: 200, body: { ok: true, automations: [] } }),
        create: async () => (seen.push('create'), { status: 200, body: { ok: true } }),
        update: async () => ({ status: 200, body: { ok: true } }),
        history: async () => ({ status: 200, body: { ok: true } }),
        session: async () => ({ status: 200, body: { ok: true } })
      }
    })
    const client = mcp({ WORKHUB_SOCKET: socket, WORKHUB_CWD: '/w/acme' })
    try {
      const call = async (name: string, args: unknown) => (await client.rpc('tools/call', { name, arguments: args }))['result'] as { isError: boolean; content: { text: string }[] }
      expect((await call('automations_list', {})).isError).toBe(false)
      // A change needs a session token: the endpoint refuses it.
      expect(await call('automation_save', { automation: { name: 'Triage' } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('session token') }] })
      expect(seen).toEqual(['list '])
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

  it('survives an oversized upload: the tool call fails and the bridge answers the next call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-mcp-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const seen: string[] = []
    const server = await startControlServer(socket, {
      auth: { sessionOf: (t) => (t === 'tok-1' ? 'sess-1' : undefined), readOnly: () => false },
      openReview: () => ({ ok: true }),
      saveFlowMap: () => (seen.push('flow-map'), { ok: true, file: 'm.json', id: 'm' }),
      saveBoard: async () => (seen.push('board'), { ok: true, id: 'b', dropped: [] })
    })
    const client = mcp({ WORKHUB_SOCKET: socket, WORKHUB_SESSION: 'sess-1', WORKHUB_SESSION_TOKEN: 'tok-1', WORKHUB_CWD: '/w/acme' })
    try {
      const call = async (name: string, args: unknown) => {
        // A bridge that died would never answer: race it against its exit.
        const r = await Promise.race([client.rpc('tools/call', { name, arguments: args }), client.exited.then((why) => Promise.reject(new Error(`the bridge ${why}`)))])
        return r['result'] as { isError: boolean; content: { text: string }[] }
      }
      await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      // About 600 KB (inside the discard cap) and about 9 MB (past it).
      for (const size of Array.from({ length: 20 }, (_, i) => (i % 2 ? 9 * 1024 * 1024 : 600 * 1024))) {
        const r = await call('flow_map_save', { map: { filler: 'x'.repeat(size) } })
        expect(r.isError).toBe(true)
        expect(r.content[0]!.text).toMatch(/body too large|could not be reached/)
        expect(client.alive()).toBe(true)
        expect((await call('board_save', { board: { format: 'workhub.board', version: 1, id: 'ok', title: 'T', status: 'live', blocks: [] } })).isError).toBe(false)
      }
      expect(seen.length).toBe(20)
    } finally {
      client.close()
      server?.close()
    }
  }, 30000)

  it('does not send a board over 256 KB: the tool answers with the endpoint text and the server sees no request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-mcp-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const seen: string[] = []
    const server = await startControlServer(socket, {
      auth: { sessionOf: () => (seen.push('auth'), 'sess-1'), readOnly: () => false },
      openReview: () => ({ ok: true }),
      saveBoard: async () => (seen.push('board'), { ok: true, id: 'b', dropped: [] })
    })
    const client = mcp({ WORKHUB_SOCKET: socket, WORKHUB_SESSION: 'sess-1', WORKHUB_SESSION_TOKEN: 'tok-1', WORKHUB_CWD: '/w/acme' })
    try {
      const board = { format: 'workhub.board', version: 1, id: 'big', title: 'T', status: 'live', blocks: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] }
      const r = (await client.rpc('tools/call', { name: 'board_save', arguments: { board } }))['result'] as { isError: boolean; content: { text: string }[] }
      expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'the board is over 256 KB: shorten the log or the tables' }] })
      expect(seen).toEqual([])
    } finally {
      client.close()
      server?.close()
    }
  })
})
