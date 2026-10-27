import { cp, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexRolloutParser, CodexSessionHistory, CodexTranscriptReader, findRollout, rolloutId, windowLabel } from '../src/transcript-codex'

// Synthetic rollouts written by hand from the documented structure (test/fixtures/codex-home):
// one full session in /tmp/acme-web, a short one, and a subagent's rollout.
const home = join(import.meta.dirname, 'fixtures', 'codex-home')
const ID = '0199aaaa-bbbb-4ccc-8ddd-eeee11112222'
const query = { agentSessionId: ID, cwd: '/tmp/acme-web', configDir: home }
const FILE = join(home, 'sessions', '2026', '10', '01', `rollout-2026-10-01T12-00-00-${ID}.jsonl`)

describe('CodexTranscriptReader', () => {
  it('fills title, model, tokens, context and active time', async () => {
    const snap = await new CodexTranscriptReader().read(query)
    expect(snap?.title).toBe('Fix the login form focus bug')
    expect(snap?.model).toBe('gpt-5.6-codex')
    // Codex counts the cached tokens inside input_tokens.
    expect(snap?.tokens).toEqual({ input: 500, cacheRead: 1500, output: 300, total: 2300 })
    expect(snap?.context).toEqual({ used: 2000, size: 200_000, percent: 1 })
    expect(snap?.activeTimeMs).toBe(18_000)
    expect(snap?.cost).toBeUndefined()
  })

  it('reads the 5 h and weekly rate limits from the last token_count', async () => {
    const snap = await new CodexTranscriptReader().read(query)
    expect(snap?.planUsage).toEqual([
      { window: '5h', percent: 12.5, resetsAt: Date.parse('2026-10-01T12:00:15.000Z') + 900_000 },
      { window: 'weekly', percent: 40, resetsAt: 1_790_600_000_000 }
    ])
  })

  it('describes tool calls and tracks their outcome', async () => {
    const snap = await new CodexTranscriptReader().read(query)
    expect(snap?.toolCalls?.map((t) => [t.title, t.kind, t.status])).toEqual([
      ['Ran a command', 'execute', 'completed'],
      ['Edited login.ts and 1 more', 'edit', 'completed'],
      ['Ran a command', 'execute', 'failed'],
      ['Ran a command', 'execute', 'completed'],
      ['Updated the plan', 'other', 'in_progress']
    ])
    expect(snap?.toolCalls?.[0]?.detail).toBe('$ rg focus src')
  })

  it('detects the pull request and the ticket from the branch', async () => {
    const snap = await new CodexTranscriptReader().read({ ...query, ticketPrefixes: ['ABC'] })
    expect(snap?.pullRequests).toEqual(['https://github.com/acme/web/pull/42'])
    expect(snap?.ticketKeys).toEqual(['ABC-12'])
  })

  it('reads only what was appended', async () => {
    const dir = await tmp()
    await cp(home, dir, { recursive: true })
    const reader = new CodexTranscriptReader()
    const q = { ...query, configDir: dir }
    expect((await reader.read(q))?.tokens?.total).toBe(2300)
    const file = join(dir, 'sessions', '2026', '10', '01', `rollout-2026-10-01T12-00-00-${ID}.jsonl`)
    const extra = '{"timestamp":"2026-10-01T12:05:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":0,"output_tokens":500,"total_tokens":3500}}}}\n'
    await writeFile(file, (await readFile(file, 'utf8')) + extra)
    const snap = await reader.read(q)
    expect(snap?.tokens).toEqual({ input: 3000, output: 500, total: 3500 })
    // A token_count without rate limits keeps the last known windows.
    expect(snap?.planUsage).toHaveLength(2)
  })

  it('reads a zstd-compressed rollout', async () => {
    const dir = await tmp()
    const day = join(dir, 'sessions', '2026', '10', '01')
    await cp(join(home, 'sessions', '2026', '10', '01'), day, { recursive: true })
    const plain = join(day, `rollout-2026-10-01T12-00-00-${ID}.jsonl`)
    await writeFile(`${plain}.zst`, zstdCompressSync(await readFile(plain)))
    await rm(plain)
    const reader = new CodexTranscriptReader()
    const snap = await reader.read({ ...query, configDir: dir })
    expect(snap?.title).toBe('Fix the login form focus bug')
    expect(snap?.tokens?.total).toBe(2300)
    expect(await reader.exists({ ...query, configDir: dir })).toBe(true)
  })

  it('returns null for unknown sessions, bad ids and a missing Codex home', async () => {
    const reader = new CodexTranscriptReader()
    expect(await reader.read({ ...query, agentSessionId: '0199ffff-ffff-4fff-8fff-ffffffffffff' })).toBeNull()
    expect(await reader.read({ ...query, agentSessionId: '../../etc/passwd' })).toBeNull()
    expect(await reader.read({ ...query, configDir: join(home, 'missing') })).toBeNull()
    expect(await reader.exists(query)).toBe(true)
  })
})

// The current rollout format (openai/codex main, 2026-10-27): ordinals, `item_completed` user
// messages instead of `user_message`, `token_usage_record`, per-model rate-limit buckets, a
// reverted thread's `<thread>_<rollout>` file name, and subagent / internal threads.
const current = join(import.meta.dirname, 'fixtures', 'codex-home-current')
const THREAD = '0199eeee-1111-7222-8333-444455556666'

describe('the current Codex rollout format', () => {
  const q = { agentSessionId: THREAD, cwd: '/tmp/acme-shop', configDir: current, ticketPrefixes: ['SHOP'] }

  it('finds a reverted thread by its thread id and reads the monitor fields', async () => {
    expect(rolloutId(`rollout-2026-10-20T08-00-00-${THREAD}_0199eeee-9999-7aaa-8bbb-ccccddddeeee.jsonl`)).toBe(THREAD)
    const snap = await new CodexTranscriptReader().read(q)
    expect(snap?.title).toBe('Make the cart total include taxes')
    expect(snap?.model).toBe('gpt-5.5-codex')
    expect(snap?.tokens).toEqual({ input: 3000, cacheRead: 6000, output: 700, total: 9700 })
    expect(snap?.context).toMatchObject({ used: 5000, size: 272_000 })
    expect(snap?.activeTimeMs).toBe(8_000)
    expect(snap?.toolCalls?.map((t) => [t.title, t.kind, t.status])).toEqual([
      ['Ran a command', 'execute', 'completed'],
      ['Edited total.ts', 'edit', 'completed']
    ])
    expect(snap?.ticketKeys).toEqual(['SHOP-7'])
  })

  it('keeps the main rate limit when another bucket reports after it', async () => {
    const snap = await new CodexTranscriptReader().read(q)
    expect(snap?.planUsage).toEqual([
      { window: '5h', percent: 20, resetsAt: 1_792_656_000_000 },
      { window: 'weekly', percent: 35, resetsAt: 1_793_000_000_000 }
    ])
  })

  it('titles a session from its user message when no user event was written', () => {
    const parser = new CodexRolloutParser()
    parser.ingest('{"timestamp":"2026-10-20T08:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /x"}]}}')
    parser.ingest('{"timestamp":"2026-10-20T08:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Rename the flag"}]}}')
    expect(parser.snapshot().title).toBe('Rename the flag')
  })

  it('lists only user threads in the history, titled from item_completed', async () => {
    const entries = await new CodexSessionHistory({ defaultHome: current }).list({ agentId: 'codex', accountId: null })
    expect(entries.map((e) => [e.agentSessionId, e.title, e.gitBranch])).toEqual([[THREAD, 'Make the cart total include taxes', 'feature/SHOP-7-cart']])
  })
})

describe('CodexRolloutParser fails soft', () => {
  it('ignores broken lines, unknown events and malformed numbers', () => {
    const parser = new CodexRolloutParser()
    for (const line of ['', 'not json', '[]', '{"type":"event_msg"}', '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":"x"}},"rate_limits":{"primary":{"used_percent":"hi"}}}}']) parser.ingest(line)
    expect(parser.snapshot()).toEqual({})
  })
})

describe('CodexSessionHistory', () => {
  it('lists top-level sessions, newest first, with the first prompt', async () => {
    const entries = await new CodexSessionHistory({ defaultHome: home }).list({ agentId: 'codex', accountId: null })
    // The subagent rollout is not a session of its own.
    expect(entries.map((e) => [e.agentSessionId, e.title, e.cwd]).sort()).toEqual([
      ['0199aaaa-bbbb-4ccc-8ddd-eeee11112222', 'Fix the login form focus bug', '/tmp/acme-web'],
      ['0199cccc-dddd-4eee-8fff-000011112222', 'Add the health endpoint', '/tmp/acme-api']
    ])
    expect(entries.find((e) => e.agentSessionId === ID)).toMatchObject({ gitBranch: 'feature/ABC-12-login', createdAt: Date.parse('2026-10-01T12:00:00.000Z') })
  })

  it('orders by modification time and respects the limit and the account folder', async () => {
    const dir = await tmp()
    await cp(home, dir, { recursive: true })
    await utimes(join(dir, 'sessions', '2026', '10', '01', `rollout-2026-10-01T12-00-00-${ID}.jsonl`), new Date('2030-01-01'), new Date('2030-01-01'))
    const history = new CodexSessionHistory({ limit: 5 })
    const entries = await history.list({ agentId: 'codex', accountId: 'work', configDir: dir })
    expect(entries[0]?.agentSessionId).toBe(ID)
    expect(entries[0]?.accountId).toBe('work')
    expect(await new CodexSessionHistory({ limit: 1 }).list({ agentId: 'codex', accountId: null, configDir: dir })).toHaveLength(1)
  })

  it('lists nothing without a sessions folder, and keeps no messages', async () => {
    const history = new CodexSessionHistory({ defaultHome: join(home, 'missing') })
    expect(await history.list({ agentId: 'codex', accountId: null })).toEqual([])
    expect(await history.messages()).toEqual([])
  })
})

describe('helpers', () => {
  it('find the session id in a file name and label rate windows', async () => {
    expect(rolloutId(`rollout-2026-10-01T12-00-00-${ID}.jsonl.zst`)).toBe(ID)
    expect(rolloutId('notes.txt')).toBeUndefined()
    expect(windowLabel(300)).toBe('5h')
    expect(windowLabel(10_080)).toBe('weekly')
    expect(windowLabel(1440)).toBe('1d')
    expect(windowLabel(90)).toBe('90m')
    expect(windowLabel(undefined)).toBe('limit')
    expect(await findRollout(join(home, 'sessions'), ID)).toBe(FILE)
  })
})

const dirs: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wh-codex-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
