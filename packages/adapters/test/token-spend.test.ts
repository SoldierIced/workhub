import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localDayKey, spendKey, type SpendBuckets } from '@workhub/core'
import { claudeSpendLine, codexSpendLine, commitClaude, kiroSpendFile, TokenSpendScanner, worktreeAliases, worktreeOf, type ClaudeSpendState, type CodexSpendState } from '../src/token-spend'

const T = '2026-10-27T10:00:00.000Z'
const DAY = localDayKey(new Date(T))
const key = (agent: 'claude' | 'codex' | 'kiro', path: string) => spendKey(DAY, agent, path)

const assistant = (id: string, usage: object | null, content: object[] = [], cwd = '/w/acme') =>
  JSON.stringify({ type: 'assistant', cwd, timestamp: T, message: { id, content, ...(usage ? { usage } : {}) } })
const usage = (input: number, output: number, cacheWrite = 0, cacheRead = 1000) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead
})

describe('Claude spend lines', () => {
  it('counts a streamed message once (its last copy), without cache reads', () => {
    const state: ClaudeSpendState = {}
    const b: SpendBuckets = {}
    claudeSpendLine(assistant('m1', usage(10, 1, 5)), state, b)
    claudeSpendLine(assistant('m1', usage(10, 20, 5)), state, b)
    claudeSpendLine(assistant('m2', usage(1, 1)), state, b)
    commitClaude(state, b)
    expect(b).toEqual({ [key('claude', '/w/acme')]: 35 + 2 })
  })

  it('moves the work to the folder edits and cd commands touch, not reads', () => {
    const state: ClaudeSpendState = {}
    const b: SpendBuckets = {}
    const home = '/Users/me'
    claudeSpendLine(assistant('a', usage(1, 0), [{ type: 'tool_use', name: 'Read', input: { file_path: '/w/acme/docs/x.md' } }]), state, b, home)
    claudeSpendLine(assistant('b', usage(2, 0), [{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/acme/api/src/a.ts' } }]), state, b, home)
    claudeSpendLine(assistant('c', usage(4, 0), [{ type: 'tool_use', name: 'Bash', input: { command: 'cd ~/w/web && npm test' } }]), state, b, home)
    claudeSpendLine(assistant('d', usage(8, 0), [{ type: 'tool_use', name: 'Bash', input: { command: 'git -C ../tools status' } }]), state, b, home)
    commitClaude(state, b)
    expect(b).toEqual({
      [key('claude', '/w/acme')]: 1,
      [key('claude', '/w/acme/api/src')]: 2,
      [key('claude', '/Users/me/w/web')]: 4,
      [key('claude', '/w/tools')]: 8
    })
  })

  it('a new cwd moves the work back, and user lines are skipped cheaply', () => {
    const state: ClaudeSpendState = {}
    const b: SpendBuckets = {}
    claudeSpendLine(assistant('a', usage(1, 0), [{ type: 'tool_use', name: 'Write', input: { file_path: '/w/acme/api/x' } }]), state, b)
    claudeSpendLine(JSON.stringify({ type: 'user', cwd: '/w/acme/web', timestamp: T, message: { content: 'hi' } }), state, b)
    claudeSpendLine(assistant('b', usage(2, 0), [], '/w/acme/web'), state, b)
    claudeSpendLine('{broken', state, b)
    commitClaude(state, b)
    expect(b).toEqual({ [key('claude', '/w/acme/api')]: 1, [key('claude', '/w/acme/web')]: 2 })
  })
})

describe('Codex spend lines', () => {
  const tokenCount = (input: number, cached: number, output: number) =>
    JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } })

  it('counts the growth of the fresh running total, once per repeated event', () => {
    const state: CodexSpendState = {}
    const b: SpendBuckets = {}
    codexSpendLine(JSON.stringify({ timestamp: T, type: 'session_meta', payload: { cwd: '/w/repo' } }), state, b)
    codexSpendLine(tokenCount(100, 40, 10), state, b)
    codexSpendLine(tokenCount(100, 40, 10), state, b)
    codexSpendLine(tokenCount(300, 140, 30), state, b)
    expect(b).toEqual({ [key('codex', '/w/repo')]: 190 })
  })

  it('takes the totals from token_usage_record once there is one, without counting twice', () => {
    const state: CodexSpendState = {}
    const b: SpendBuckets = {}
    const record = (input: number, cached: number, output: number) =>
      JSON.stringify({ timestamp: T, type: 'token_usage_record', payload: { usage: {}, thread_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } })
    codexSpendLine(JSON.stringify({ timestamp: T, type: 'turn_context', payload: { cwd: '/w/repo' } }), state, b)
    codexSpendLine(tokenCount(100, 40, 10), state, b)
    codexSpendLine(record(100, 40, 10), state, b)
    codexSpendLine(record(300, 140, 30), state, b)
    // A token_count written after a record (even a lagging one) is ignored.
    codexSpendLine(tokenCount(250, 100, 20), state, b)
    codexSpendLine(tokenCount(300, 140, 30), state, b)
    expect(b).toEqual({ [key('codex', '/w/repo')]: 190 })
  })
})

describe('Kiro spend file', () => {
  it('sums each turn’s input, cache write and output in the session cwd', () => {
    const b: SpendBuckets = {}
    kiroSpendFile(
      JSON.stringify({
        cwd: '/w/repo',
        updated_at: T,
        session_state: { conversation_metadata: { user_turn_metadatas: [{ input_token_count: 5, output_token_count: 2, cache_write_input_token_count: 1, cache_read_input_token_count: 50 }, { input_token_count: 0 }] } }
      }),
      b
    )
    kiroSpendFile('{nope', b)
    expect(b).toEqual({ [key('kiro', '/w/repo')]: 8 })
  })
})

describe('TokenSpendScanner', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wh-spend-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const since = new Date(T).getTime() - 6 * 86_400_000
  const sinceDay = localDayKey(new Date(since))

  it('counts a Claude session copied to another account once, from its newest copy', async () => {
    const a = join(root, '.claude')
    const b = join(root, '.claude-work')
    for (const dir of [a, b]) mkdirSync(join(dir, 'projects', '-w-acme'), { recursive: true })
    const first = `${assistant('m1', usage(10, 0))}\n`
    writeFileSync(join(a, 'projects', '-w-acme', 'sess.jsonl'), first)
    // The failover copy continued in the other account.
    const copy = join(b, 'projects', '-w-acme', 'sess.jsonl')
    writeFileSync(copy, `${first}${assistant('m2', usage(5, 0))}\n`)
    const t = new Date(T).getTime() / 1000
    utimesSync(join(a, 'projects', '-w-acme', 'sess.jsonl'), t - 60, t - 60)
    utimesSync(copy, t, t)
    writeFileSync(join(b, 'projects', '-w-acme', 'other.jsonl'), `${assistant('o1', usage(1, 0))}\n`)
    const scanner = new TokenSpendScanner()
    const sources = { claudeDirs: [a, b], codexHomes: [], kiroDirs: [] }
    expect(await scanner.scan(sources, since, sinceDay)).toEqual({ [key('claude', '/w/acme')]: 16 })
    expect(Object.keys(scanner.snapshot().files).sort()).toEqual([copy, join(b, 'projects', '-w-acme', 'other.jsonl')].sort())
  })

  it('reads every source, resumes appended transcripts from the cache, and skips old files', async () => {
    const claude = join(root, '.claude')
    const project = join(claude, 'projects', '-w-acme')
    mkdirSync(join(project, 'sess', 'subagents'), { recursive: true })
    const transcript = join(project, 'sess.jsonl')
    writeFileSync(transcript, `${assistant('m1', usage(10, 0))}\n${assistant('m1', usage(10, 5))}\n`)
    writeFileSync(join(project, 'sess', 'subagents', 'agent-1.jsonl'), `${assistant('s1', usage(3, 0))}\n`)
    const old = join(project, 'old.jsonl')
    writeFileSync(old, `${assistant('o1', usage(999, 0))}\n`)
    utimesSync(old, new Date(since - 86_400_000), new Date(since - 86_400_000))

    const codexDir = join(root, '.codex', 'sessions', '2026', '10', '27')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      join(codexDir, 'rollout-2026-10-27T10-00-00-0199a213-81c0-7800-8aa1-bbab2a035a53.jsonl'),
      [
        JSON.stringify({ timestamp: T, type: 'session_meta', payload: { cwd: '/w/repo' } }),
        JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 } } } })
      ].join('\n') + '\n'
    )
    const kiroCli = join(root, '.kiro', 'sessions', 'cli')
    mkdirSync(kiroCli, { recursive: true })
    writeFileSync(join(kiroCli, 'k.json'), JSON.stringify({ cwd: '/w/repo', updated_at: T, session_state: { conversation_metadata: { user_turn_metadatas: [{ input_token_count: 4 }] } } }))

    const sources = { claudeDirs: [claude], codexHomes: [join(root, '.codex')], kiroDirs: [join(root, '.kiro')] }
    const scanner = new TokenSpendScanner()
    // The streamed message is still pending at the end of the file; it counts already.
    expect(await scanner.scan(sources, since, sinceDay)).toEqual({ [key('claude', '/w/acme')]: 18, [key('codex', '/w/repo')]: 55, [key('kiro', '/w/repo')]: 4 })

    // A new scanner from the persisted cache reads only the appended lines.
    const cache = JSON.parse(JSON.stringify(scanner.snapshot()))
    const entry = cache.files[transcript]
    expect(entry.offset).toBeGreaterThan(0)
    appendFileSync(transcript, `${assistant('m2', usage(100, 0), [], '/w/acme/api')}\n{"type":"assistant","cwd":"/w/acme/api"`)
    const next = new TokenSpendScanner(cache)
    expect(next.cached(sinceDay)[key('claude', '/w/acme')]).toBe(18)
    const after = await next.scan(sources, since, sinceDay)
    expect(after[key('claude', '/w/acme')]).toBe(18)
    expect(after[key('claude', '/w/acme/api')]).toBe(100)
    // The unfinished last line is left for the next scan.
    expect(next.snapshot().files[transcript]!.offset).toBeLessThan(next.snapshot().files[transcript]!.size)

    // A rewritten (shorter) file is read again from the start.
    writeFileSync(transcript, `${assistant('z', usage(1, 0))}\n`)
    const rewritten = await next.scan(sources, since, sinceDay)
    expect(rewritten[key('claude', '/w/acme')]).toBe(1 + 3)
    expect(rewritten[key('claude', '/w/acme/api')]).toBeUndefined()
  })

  it('ignores a cache of another version and missing folders', async () => {
    const scanner = new TokenSpendScanner({ version: 0, files: { x: { size: 1, mtimeMs: 1, offset: 0, buckets: { a: 1 } } } })
    expect(scanner.cached(sinceDay)).toEqual({})
    expect(await scanner.scan({ claudeDirs: [join(root, 'none')], codexHomes: [join(root, 'none')], kiroDirs: [join(root, 'none')] }, since, sinceDay)).toEqual({})
  })
})

describe('git worktrees', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wh-wt-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('finds the main repository of a linked worktree from git files, and nothing for others', async () => {
    const main = join(root, 'profile', 'api')
    const wt = join(root, 'elsewhere', 'api-fix')
    mkdirSync(join(main, '.git', 'worktrees', 'api-fix'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'api-fix', 'commondir'), '../..\n')
    mkdirSync(join(wt, 'src'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'api-fix')}\n`)
    expect(await worktreeOf(join(wt, 'src', 'gone', 'deeper'))).toEqual({ worktree: wt, main })
    expect(await worktreeOf(join(main, 'src'))).toBeNull()
    expect(await worktreeOf(join(root, 'nowhere'))).toBeNull()
    const cache = new Map()
    expect(await worktreeAliases([join(wt, 'src'), join(root, 'nowhere')], cache)).toEqual({ [wt]: main })
    expect(cache.size).toBe(2)
  })
})
