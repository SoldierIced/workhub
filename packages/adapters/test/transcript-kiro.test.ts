import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KiroSessionHistory, KiroTranscriptReader, parseKiroCliMeta, parseKiroSessionJson } from '../src/transcript-kiro'

// Synthetic Kiro data written by hand from the documented structure (test/fixtures/kiro-home):
// one chat session with a subagent and sub-executions, one ACP session, one empty ACP session.
const kiroDir = join(import.meta.dirname, 'fixtures', 'kiro-home')
const CHAT = 'sess_aaaa1111-bbbb-4ccc-8ddd-eeee22223333'
const CLI = '11111111-2222-4333-8444-555555555555'
const base = { cwd: '/tmp/acme-web' }

describe('KiroTranscriptReader, chat session', () => {
  it('fills title, model, credits, context and active time', async () => {
    const snap = await new KiroTranscriptReader({ kiroDir }).read({ ...base, agentSessionId: CHAT })
    expect(snap?.title).toBe('Fix the login form')
    expect(snap?.model).toBe('claude-sonnet-5')
    // Two turns: 1.5 credits, then 0.25 + 0.25.
    expect(snap?.credits).toBe(2)
    expect(snap?.lastTurnCredits).toBe(0.5)
    expect(snap?.context).toEqual({ percent: 15 })
    expect(snap?.activeTimeMs).toBe(5000)
    // The chat file records no tokens or cost.
    expect(snap?.tokens).toBeUndefined()
    expect(snap?.cost).toBeUndefined()
  })

  it('reads tool calls with their kind and outcome', async () => {
    const snap = await new KiroTranscriptReader({ kiroDir }).read({ ...base, agentSessionId: CHAT })
    expect(snap?.toolCalls?.map((t) => [t.title, t.kind, t.status])).toEqual([
      ['Read login.ts', 'read', 'completed'],
      ['Open the pull request', 'execute', 'completed'],
      ['Delete old.ts', 'delete', 'failed'],
      ['Run the tests', 'execute', 'failed'],
      ['Search the code', 'search', 'in_progress']
    ])
    expect(snap?.toolCalls?.[1]?.detail).toBe('$ gh pr create --fill')
    expect(snap?.toolCalls?.[0]?.detail).toBe('/tmp/acme-web/src/login.ts')
  })

  it('detects the pull request and the ticket', async () => {
    const snap = await new KiroTranscriptReader({ kiroDir }).read({ ...base, agentSessionId: CHAT, ticketPrefixes: ['ABC'] })
    expect(snap?.pullRequests).toEqual(['https://github.com/acme/web/pull/42'])
    expect(snap?.ticketKeys).toEqual(['ABC-12'])
  })

  it('reads subagents and their sub-execution activity', async () => {
    const snap = await new KiroTranscriptReader({ kiroDir }).read({ ...base, agentSessionId: CHAT })
    expect(snap?.subagents).toMatchObject([
      { id: 'sub1', name: 'explorer', description: 'Find other forms', status: 'completed', stepCount: 2, lastStep: 'Search for forms' },
      { id: 'sub2', name: 'tester', status: 'running' }
    ])
  })

  it('reads only what was appended and ignores broken lines', async () => {
    const dir = await tmp()
    await cp(kiroDir, dir, { recursive: true })
    const reader = new KiroTranscriptReader({ kiroDir: dir })
    const query = { ...base, agentSessionId: CHAT }
    expect((await reader.read(query))?.credits).toBe(2)
    const file = join(dir, 'sessions', '0123456789abcdef', CHAT, 'messages.jsonl')
    await appendFile(file, '{"id":"m19","timestamp":"2026-10-01T12:20:00.000Z","payload":{"type":"usage_summary","elapsedTime":1000,"promptTurnSummaries":[{"usage":1}]}}\n{"partial":')
    const snap = await reader.read(query)
    expect(snap?.credits).toBe(3)
    expect(snap?.lastTurnCredits).toBe(1)
    // The unfinished line completes on the next append.
    await appendFile(file, 'true}\n')
    expect((await reader.read(query))?.credits).toBe(3)
  })
})

describe('KiroTranscriptReader, ACP session', () => {
  it('fills model, context, tokens, credits and duration from the metadata', async () => {
    const snap = await new KiroTranscriptReader({ kiroDir }).read({ cwd: '/tmp/acme-api', agentSessionId: CLI })
    expect(snap?.model).toBe('claude-opus-5')
    expect(snap?.context).toEqual({ percent: 4.5, size: 1_000_000, used: 45_000 })
    expect(snap?.tokens).toEqual({ input: 1500, output: 300, cacheRead: 300, total: 2100 })
    expect(snap?.credits).toBeCloseTo(0.875, 8)
    expect(snap?.lastTurnCredits).toBeCloseTo(0.125, 8)
    expect(snap?.activeTimeMs).toBe(15_500)
    expect(snap?.title).toBe('Add the health endpoint for ABC-77')
  })

  it('reads tool uses, their results, the pull request and the ticket', async () => {
    const snap = await new KiroTranscriptReader({ kiroDir }).read({ cwd: '/tmp/acme-api', agentSessionId: CLI })
    expect(snap?.toolCalls?.map((t) => [t.title, t.kind, t.status])).toEqual([
      ['Read app.ts', 'read', 'completed'],
      ['Open the pull request', 'execute', 'completed'],
      ['Edited app.ts', 'edit', 'failed']
    ])
    expect(snap?.pullRequests).toEqual(['https://github.com/acme/api/pull/7'])
    expect(snap?.ticketKeys).toEqual(['ABC-77'])
  })

  it('returns null for an unknown session and rejects ids that are not file names', async () => {
    const reader = new KiroTranscriptReader({ kiroDir })
    expect(await reader.read({ ...base, agentSessionId: 'nope' })).toBeNull()
    expect(await reader.read({ ...base, agentSessionId: '../../etc/passwd' })).toBeNull()
    expect(await reader.exists({ ...base, agentSessionId: CLI })).toBe(true)
    expect(await reader.exists({ ...base, agentSessionId: CHAT })).toBe(true)
    expect(await reader.exists({ ...base, agentSessionId: 'nope' })).toBe(false)
  })

  it('returns null when the Kiro folder does not exist', async () => {
    expect(await new KiroTranscriptReader({ kiroDir: join(kiroDir, 'missing') }).read({ ...base, agentSessionId: CLI })).toBeNull()
  })
})

describe('Kiro parsers fail soft', () => {
  it('return nothing for broken or empty metadata', () => {
    expect(parseKiroSessionJson('not json')).toEqual({})
    expect(parseKiroSessionJson('[]')).toEqual({})
    expect(parseKiroCliMeta('{')).toEqual({})
    expect(parseKiroCliMeta('{"session_state":{"conversation_metadata":{"user_turn_metadatas":[{"metering_usage":"x","input_token_count":0}]}}}')).toEqual({})
  })
})

describe('KiroSessionHistory', () => {
  it('lists chat and ACP sessions, newest first, without the empty one', async () => {
    const entries = await new KiroSessionHistory({ kiroDir }).list({ agentId: 'kiro', accountId: null })
    expect(entries.map((e) => [e.agentSessionId, e.title, e.cwd])).toEqual([
      [CLI, 'Add the health endpoint for ABC-77', '/tmp/acme-api'],
      [CHAT, 'Fix the login form', '/tmp/acme-web']
    ])
    expect(entries[0]).toMatchObject({ agentId: 'kiro', accountId: null, firstPrompt: 'Add the health endpoint for ABC-77' })
  })

  it('lists nothing when Kiro has no sessions folder, and keeps no messages', async () => {
    const history = new KiroSessionHistory({ kiroDir: join(kiroDir, 'missing') })
    expect(await history.list({ agentId: 'kiro', accountId: null })).toEqual([])
    expect(await history.messages()).toEqual([])
  })
})

const dirs: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wh-kiro-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
