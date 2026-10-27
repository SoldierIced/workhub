import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OpenCodeSessionHistory, OpenCodeTranscriptReader, modelName } from '../src/transcript-opencode'

// A synthetic database with the columns the reader uses (session_v2, session_message), written
// by hand from the structure checked on a real OpenCode install.
const SCHEMA = `
  CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL DEFAULT 's',
    directory text NOT NULL, title text, version text NOT NULL DEFAULT '1', cost real DEFAULT 0 NOT NULL,
    tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
    tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
    agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_idle integer, time_archived integer);
  CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`
const NOW = 1_790_000_100_000
const MODEL = JSON.stringify({ id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'medium' })

let dir: string
let dbPath: string

function db<T>(work: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(dbPath)
  try {
    return work(d)
  } finally {
    d.close()
  }
}

function addMessage(d: DatabaseSync, session: string, seq: number, type: string, data: unknown): void {
  d.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(`m-${session}-${seq}`, session, type, seq, NOW, NOW, JSON.stringify(data))
}

const tool = (id: string, name: string, status: string, input: unknown, text?: string) => ({
  type: 'tool',
  id,
  name,
  state: { status, input, content: text ? [{ type: 'text', text }] : [] },
  time: { created: NOW - 1000, completed: NOW - 900 }
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wh-opencode-'))
  dbPath = join(dir, 'opencode.db')
  db((d) => {
    d.exec(SCHEMA)
    const session = d.prepare(
      'INSERT INTO session_v2 (id, project_id, parent_id, directory, title, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated, time_idle, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    session.run('ses_main', 'p1', null, '/tmp/acme-web', 'Login form fix', 1.25, 1000, 400, 100, 5000, 300, 'build', MODEL, NOW - 60_000, NOW - 1000, null, null)
    session.run('ses_child', 'p1', 'ses_main', '/tmp/acme-web', 'Explore the forms', 0.1, 50, 20, 0, 0, 0, 'explore', MODEL, NOW - 50_000, NOW - 40_000, NOW - 40_000, null)
    session.run('ses_other', 'p1', null, '/tmp/acme-api', null, 0, 0, 0, 0, 0, 0, 'build', MODEL, NOW - 120_000, NOW - 100_000, null, null)
    session.run('ses_old', 'p1', null, '/tmp/old', 'Archived', 0, 0, 0, 0, 0, 0, 'build', MODEL, NOW - 200_000, NOW - 190_000, null, NOW - 180_000)
    addMessage(d, 'ses_main', 1, 'user', { text: 'Fix ABC-12: the form loses focus', time: { created: NOW - 59_000 } })
    addMessage(d, 'ses_main', 2, 'assistant', {
      model: { id: 'claude-opus-5-5', providerID: 'anthropic' },
      time: { created: NOW - 58_000, completed: NOW - 48_000 },
      content: [
        { type: 'reasoning', text: 'thinking' },
        tool('t1', 'read', 'completed', { path: '/tmp/acme-web/src/login.ts' }),
        tool('t2', 'shell', 'completed', { command: 'gh pr create --fill', description: 'Open the pull request' }, 'https://github.com/Acme/Web/pull/42'),
        tool('t3', 'edit', 'error', { path: '/tmp/acme-web/src/login.ts' })
      ]
    })
    addMessage(d, 'ses_main', 3, 'shell', { shellID: 'sh1', command: 'npm test', status: 'completed', exit: 0, output: { output: 'ok' }, time: { created: NOW - 40_000 } })
    addMessage(d, 'ses_main', 4, 'assistant', {
      time: { created: NOW - 30_000 },
      content: [tool('t4', 'grep', 'running', { pattern: 'focus' })]
    })
  })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('OpenCodeTranscriptReader', () => {
  const query = { agentSessionId: 'ses_main', cwd: '/tmp/acme-web' }
  const reader = () => new OpenCodeTranscriptReader({ dbPath, now: () => NOW })

  it('fills title, model, cost, tokens and active time', async () => {
    const snap = await reader().read({ ...query, ticketPrefixes: ['ABC'] })
    expect(snap?.title).toBe('Login form fix')
    expect(snap?.model).toBe('claude-opus-5-5')
    expect(snap?.cost).toEqual({ amount: 1.25, currency: 'USD' })
    // Reasoning tokens count as output: 400 + 100.
    expect(snap?.tokens).toEqual({ input: 1000, output: 500, cacheRead: 5000, cacheWrite: 300, total: 6800 })
    expect(snap?.activeTimeMs).toBe(10_000)
  })

  it('describes tool calls and shell messages and tracks their outcome', async () => {
    const snap = await reader().read(query)
    expect(snap?.toolCalls?.map((t) => [t.title, t.kind, t.status])).toEqual([
      ['Read login.ts', 'read', 'completed'],
      ['Open the pull request', 'execute', 'completed'],
      ['Edited login.ts', 'edit', 'failed'],
      ['Ran a command', 'execute', 'completed'],
      ['Searched the code for "focus"', 'search', 'in_progress']
    ])
    expect(snap?.toolCalls?.[1]?.detail).toBe('$ gh pr create --fill')
  })

  it('detects the pull request and the ticket', async () => {
    const snap = await reader().read({ ...query, ticketPrefixes: ['ABC'] })
    expect(snap?.pullRequests).toEqual(['https://github.com/acme/web/pull/42'])
    expect(snap?.ticketKeys).toEqual(['ABC-12'])
  })

  it('reports child sessions as subagents', async () => {
    const snap = await reader().read(query)
    expect(snap?.subagents).toEqual([
      {
        id: 'ses_child',
        status: 'completed',
        description: 'Explore the forms',
        type: 'explore',
        model: 'claude-opus-5-5',
        tokens: { total: 70, input: 50, output: 20 },
        cost: { amount: 0.1, currency: 'USD' },
        startedAt: NOW - 50_000,
        lastActivityAt: NOW - 40_000
      }
    ])
  })

  it('reads only new messages, plus the ones that were still running', async () => {
    const r = reader()
    await r.read(query)
    db((d) => {
      // The running grep finished, and a new turn arrived.
      d.prepare('UPDATE session_message SET data = ? WHERE session_id = ? AND seq = 4').run(
        JSON.stringify({ time: { created: NOW - 30_000, completed: NOW - 20_000 }, content: [tool('t4', 'grep', 'completed', { pattern: 'focus' })] }),
        'ses_main'
      )
      addMessage(d, 'ses_main', 5, 'assistant', { time: { created: NOW - 10_000, completed: NOW - 5000 }, content: [tool('t5', 'write', 'completed', { path: '/tmp/acme-web/new.ts' })] })
    })
    const snap = await r.read(query)
    expect(snap?.toolCalls?.map((t) => [t.title, t.status])).toEqual([
      ['Read login.ts', 'completed'],
      ['Open the pull request', 'completed'],
      ['Edited login.ts', 'failed'],
      ['Ran a command', 'completed'],
      ['Searched the code for "focus"', 'completed'],
      ['Wrote new.ts', 'completed']
    ])
    expect(snap?.activeTimeMs).toBe(10_000 + 10_000 + 5000)
  })

  it('hides cost and tokens that are zero', async () => {
    const snap = await reader().read({ agentSessionId: 'ses_other', cwd: '/tmp/acme-api' })
    expect(snap?.cost).toBeUndefined()
    expect(snap?.tokens).toBeUndefined()
    expect(snap?.title).toBeUndefined()
  })

  it('returns null for unknown sessions, bad ids and a missing or broken database', async () => {
    expect(await reader().read({ ...query, agentSessionId: 'ses_nope' })).toBeNull()
    expect(await reader().read({ ...query, agentSessionId: "x'; DROP TABLE session_v2;--" })).toBeNull()
    expect(await new OpenCodeTranscriptReader({ dbPath: join(dir, 'missing.db') }).read(query)).toBeNull()
    expect(await new OpenCodeTranscriptReader({ dbPath: dir }).read(query)).toBeNull()
    expect(await reader().exists(query)).toBe(true)
    expect(await reader().exists({ ...query, agentSessionId: 'ses_nope' })).toBe(false)
  })

  it('skips messages with broken JSON', async () => {
    db((d) => d.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('bad', 'ses_main', 'assistant', 9, NOW, NOW, '{not json'))
    expect((await reader().read(query))?.title).toBe('Login form fix')
  })
})

describe('OpenCodeSessionHistory', () => {
  it('lists top-level, non-archived sessions newest first', async () => {
    const entries = await new OpenCodeSessionHistory({ dbPath }).list({ agentId: 'opencode', accountId: null })
    expect(entries.map((e) => [e.agentSessionId, e.title, e.cwd])).toEqual([
      ['ses_main', 'Login form fix', '/tmp/acme-web'],
      ['ses_other', 'ses_other', '/tmp/acme-api']
    ])
    expect(entries[0]).toMatchObject({ firstPrompt: 'Fix ABC-12: the form loses focus', lastModified: NOW - 1000, createdAt: NOW - 60_000 })
  })

  it('lists nothing without a database', async () => {
    expect(await new OpenCodeSessionHistory({ dbPath: join(dir, 'missing.db') }).list({ agentId: 'opencode', accountId: null })).toEqual([])
  })
})

describe('modelName', () => {
  it('reads the id from the JSON column and tolerates plain text', () => {
    expect(modelName(MODEL)).toBe('claude-opus-5-5')
    expect(modelName('gpt-5')).toBe('gpt-5')
    expect(modelName(null)).toBeUndefined()
  })
})
