import { describe, expect, it } from 'vitest'
import { ClaudeTranscriptParser } from '../src/transcript-claude/parser'

const T = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString()
const at = (s: number) => Date.UTC(2026, 9, 1, 12, 0, s)
const MINUTE = 60_000

const prompt = (s: number) => JSON.stringify({ type: 'user', timestamp: T(s), message: { content: 'go' } })
const reply = (id: string, s: number, cache: { '5m'?: number; '1h'?: number; read?: number }) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: T(s),
    message: {
      id,
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: cache.read ?? 0,
        cache_creation_input_tokens: (cache['5m'] ?? 0) + (cache['1h'] ?? 0),
        cache_creation: { ephemeral_5m_input_tokens: cache['5m'] ?? 0, ephemeral_1h_input_tokens: cache['1h'] ?? 0 }
      }
    }
  })

describe('prompt cache expiry', () => {
  it('expires one hour after the last request that used a 1-hour cache was sent', () => {
    const p = new ClaudeTranscriptParser()
    p.ingest(prompt(0))
    p.ingest(reply('m1', 20, { '1h': 50_000 }))
    // A later request that only reads the cache renews it from the time it was sent.
    p.ingest(prompt(30))
    p.ingest(reply('m2', 45, { read: 50_000 }))
    const ctx = p.snapshot().context
    expect(ctx?.cacheTtlMs).toBe(60 * MINUTE)
    expect(ctx?.cacheExpiresAt).toBe(at(30) + 60 * MINUTE)
    // Sonnet 5 input is $2/M: resent cold at 2x, read warm at $0.2/M.
    expect(ctx?.coldCost?.amount).toBeCloseTo((50_010 * 2 * 2) / 1e6, 10)
    expect(ctx?.warmCost?.amount).toBeCloseTo((50_010 * 0.2) / 1e6, 10)
  })

  it('uses five minutes and the 1.25x write price for a 5-minute cache', () => {
    const p = new ClaudeTranscriptParser()
    p.ingest(prompt(0))
    p.ingest(reply('m1', 5, { '5m': 30_000 }))
    // The same message streamed again does not move the time it was sent.
    p.ingest(reply('m1', 9, { '5m': 30_000 }))
    const ctx = p.snapshot().context
    expect(ctx?.cacheTtlMs).toBe(5 * MINUTE)
    expect(ctx?.cacheExpiresAt).toBe(at(0) + 5 * MINUTE)
    expect(ctx?.coldCost?.amount).toBeCloseTo((30_010 * 2 * 1.25) / 1e6, 10)
  })

  it('reports no expiry when the transcript never says which lifetime the cache has', () => {
    const p = new ClaudeTranscriptParser()
    p.ingest(prompt(0))
    p.ingest(JSON.stringify({ type: 'assistant', timestamp: T(1), message: { id: 'm1', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }))
    expect(p.snapshot().context?.cacheExpiresAt).toBeUndefined()
  })
})
