import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { localDayKey, spendKey } from '@workhub/core'
import { openAiCost, openAiPrice } from '../src/shared/openai-prices'
import { claudeSpendLine, codexSpendLine, commitClaude, emptyCosts, type ClaudeSpendState, type CodexSpendState } from '../src/token-spend'
import { openCodeMessageCost, readOpenCodeCosts } from '../src/transcript-opencode'

const T = '2026-10-27T10:00:00.000Z'
const DAY = localDayKey(new Date(T))

describe('the OpenAI price table', () => {
  it('matches whole model ids (with a date or provider prefix), never a newer family', () => {
    expect(openAiPrice('gpt-5-codex')?.input).toBe(1.25)
    expect(openAiPrice('openai/gpt-5-mini-2025-08-07')?.output).toBe(2)
    expect(openAiPrice('gpt-5.5-codex')).toBeUndefined()
    expect(openAiPrice(undefined)).toBeUndefined()
    expect(openAiCost('gpt-5', { input: 1_000_000, cached: 1_000_000, output: 1_000_000 })).toBeCloseTo(11.375)
  })
})

describe('what the spend cost', () => {
  it('prices Claude messages with their model, and keeps unknown models as unpriced tokens', () => {
    const state: ClaudeSpendState = {}
    const costs = emptyCosts()
    const line = (id: string, model: string) =>
      JSON.stringify({ type: 'assistant', cwd: '/w/repo', timestamp: T, message: { id, model, usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 } } })
    claudeSpendLine(line('m1', 'claude-sonnet-4-5'), state, {}, '/home', costs)
    claudeSpendLine(line('m2', 'some-other-model'), state, {}, '/home', costs)
    commitClaude(state, {}, costs)
    expect(costs.usd).toEqual({ [spendKey(DAY, 'claude', '/w/repo')]: 3 })
    expect(costs.unpriced).toEqual({ [spendKey(DAY, 'claude', '/w/repo')]: 1_000_000 })
  })

  it('prices the growth of a Codex total with the turn model, and notes plan rate limits', () => {
    const state: CodexSpendState = {}
    const costs = emptyCosts()
    const total = (input: number, cached: number, output: number, limits?: object) =>
      JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } }, ...(limits ? { rate_limits: limits } : {}) } })
    codexSpendLine(JSON.stringify({ timestamp: T, type: 'turn_context', payload: { cwd: '/w/repo', model: 'gpt-5' } }), state, {}, costs)
    codexSpendLine(total(1_000_000, 0, 0), state, {}, costs)
    codexSpendLine(total(2_000_000, 1_000_000, 100_000), state, {}, costs)
    // 1M fresh input, then 1M cached input and 0.1M output, at gpt-5 prices.
    expect(costs.usd[spendKey(DAY, 'codex', '/w/repo')]).toBeCloseTo(1.25 + 0.125 + 1)
    expect(state.plan).toBeUndefined()
    codexSpendLine(total(2_000_000, 1_000_000, 100_000, { primary: { used_percent: 3 } }), state, {}, costs)
    expect(state.plan).toBe(true)
  })
})

describe('OpenCode costs', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('reads assistant messages with a positive cost since a time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-oc-'))
    dirs.push(dir)
    const dbPath = join(dir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)')
    const insert = db.prepare('INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)')
    const msg = (cost: number, at: number) => JSON.stringify({ cost, time: { created: at, completed: at + 5 }, tokens: { input: 2, output: 100, reasoning: 10, cache: { read: 9999, write: 20 } } })
    insert.run('a', 's', 'assistant', 2000, msg(0.16, 2000))
    insert.run('b', 's', 'assistant', 2100, msg(0, 2100))
    insert.run('c', 's', 'assistant', 500, msg(5, 500))
    insert.run('d', 's', 'user', 2200, JSON.stringify({ cost: 1 }))
    db.close()
    expect(await readOpenCodeCosts({ since: 1000, dbPath })).toEqual([{ at: 2005, usd: 0.16, tokens: 132 }])
    expect(await readOpenCodeCosts({ since: 0, dbPath: join(dir, 'missing.db') })).toEqual([])
    expect(openCodeMessageCost('not json', 1)).toBeNull()
  })
})
