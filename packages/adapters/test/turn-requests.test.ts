import { describe, expect, it } from 'vitest'
import { ClaudeTranscriptParser } from '../src/transcript-claude/parser'
import { CodexRolloutParser } from '../src/transcript-codex/parser'

const T = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString()

describe('new tokens per request', () => {
  it('lists the requests of the current turn: input, cache write and output, without cache re-reads', () => {
    const p = new ClaudeTranscriptParser()
    const prompt = (s: number) => JSON.stringify({ type: 'user', timestamp: T(s), message: { content: 'go' } })
    const reply = (id: string, s: number, usage: object) => JSON.stringify({ type: 'assistant', timestamp: T(s), message: { id, model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'x' }] } })
    p.ingest(prompt(0))
    p.ingest(reply('m1', 1, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 }))
    // A streamed message repeats its usage: it is still one request.
    p.ingest(reply('m1', 2, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 }))
    p.ingest(reply('m2', 3, { input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }))
    expect(p.snapshot().turnRequests).toEqual([115, 24])
    // A new prompt starts a new turn.
    p.ingest(prompt(10))
    p.ingest(reply('m3', 11, { input_tokens: 1, output_tokens: 2 }))
    expect(p.snapshot().turnRequests).toEqual([3])
  })

  it('reads a Codex turn request by request, counting a repeated token_count once', () => {
    const p = new CodexRolloutParser()
    const ev = (s: number, payload: object) => p.ingest(JSON.stringify({ timestamp: T(s), type: 'event_msg', payload }))
    const count = (total: number, last: object) => ({ type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last } })
    ev(0, { type: 'task_started' })
    ev(1, count(120, { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: 120 }))
    ev(1, count(120, { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: 120 }))
    ev(2, count(300, { input_tokens: 150, cached_input_tokens: 100, output_tokens: 30, total_tokens: 180 }))
    expect(p.snapshot().turnRequests).toEqual([60, 80])
    ev(3, { type: 'task_complete' })
    ev(4, { type: 'task_started' })
    expect(p.snapshot().turnRequests).toBeUndefined()
  })
})
