import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexPlanUsageReader, codexCredentials, lastRateLimits, parseCodexUsage } from '../src/transcript-codex'
import { PlanUsageError } from '../src/agent-claude-native'

// Shape of ChatGPT's `backend-api/codex/usage`, as usageChecker's `_codex.py` reads it. Synthetic values.
const body = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_790_000_000 },
    secondary_window: { used_percent: 120, reset_at: 1_790_500_000 }
  }
}
const auth = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok-codex', account_id: 'acct-1', refresh_token: 'never-used' } })
// Synthetic rollouts (see transcript-codex.test.ts): the last token_count has 12.5% 5h and 40% weekly.
const fixtureHome = join(import.meta.dirname, 'fixtures', 'codex-home')

const okFetch = (calls: [string, RequestInit | undefined][]) =>
  (async (url: string, init?: RequestInit) => {
    calls.push([url, init])
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch

describe('Codex plan usage', () => {
  it('parses the 5 h and weekly windows of a usage response', () => {
    expect(parseCodexUsage(body)).toEqual([
      { window: '5h', percent: 42, resetsAt: 1_790_000_000_000 },
      { window: 'weekly', percent: 100, resetsAt: 1_790_500_000_000 }
    ])
    expect(parseCodexUsage({})).toEqual([])
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 'x' } } })).toEqual([])
  })

  it('reads only the ChatGPT tokens of auth.json', () => {
    expect(codexCredentials(auth)).toEqual({ accessToken: 'tok-codex', accountId: 'acct-1' })
    expect(codexCredentials(JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).toBeNull()
    expect(codexCredentials('not json')).toBeNull()
  })

  it('sends the account sign-in to the usage endpoint only, and caches the read', async () => {
    const calls: [string, RequestInit | undefined][] = []
    const reader = new CodexPlanUsageReader({ readFile: async (p) => (p.endsWith('auth.json') ? auth : null), fetch: okFetch(calls) })
    expect((await reader.read('/tmp/acme-codex')).map((w) => w.window)).toEqual(['5h', 'weekly'])
    await reader.read('/tmp/acme-codex')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/usage')
    const headers = calls[0]?.[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok-codex')
    expect(headers['chatgpt-account-id']).toBe('acct-1')
    expect(JSON.stringify(calls[0]?.[1])).not.toContain('never-used')
  })

  it('falls back to the newest rate limits in the session files, without a sign-in or when the endpoint fails', async () => {
    const offline = new CodexPlanUsageReader({ readFile: async () => auth, fetch: (async () => Promise.reject(new Error('down'))) as typeof fetch })
    const windows = await offline.read(fixtureHome)
    expect(windows.map((w) => [w.window, w.percent])).toEqual([
      ['5h', 12.5],
      ['weekly', 40]
    ])
    expect(windows[0]?.asOf).toBe(Date.parse('2026-10-01T12:00:15.000Z'))
    expect(windows[0]?.resetsAt).toBe(Date.parse('2026-10-01T12:00:15.000Z') + 900_000)
    const signedOut = new CodexPlanUsageReader({ readFile: async () => null, fetch: (async () => { throw new Error('must not be called') }) as typeof fetch })
    expect((await signedOut.read(fixtureHome)).length).toBe(2)
  })

  it('reports why when there is nothing to show', async () => {
    const none = new CodexPlanUsageReader({ readFile: async () => null })
    await expect(none.read('/tmp/no-such-codex-home')).rejects.toMatchObject({ code: 'noLogin' })
    const expired = new CodexPlanUsageReader({ readFile: async () => auth, fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch })
    await expect(expired.read('/tmp/no-such-codex-home')).rejects.toBeInstanceOf(PlanUsageError)
    await expect(expired.read('/tmp/no-such-codex-home')).rejects.toMatchObject({ code: 'expired' })
  })

  it('backs off after a 429', async () => {
    let calls = 0
    let now = 1_000_000
    const reader = new CodexPlanUsageReader({
      readFile: async () => auth,
      now: () => now,
      fetch: (async () => {
        calls++
        return new Response('', { status: 429 })
      }) as unknown as typeof fetch
    })
    await expect(reader.read('/tmp/no-such-codex-home')).rejects.toMatchObject({ code: 'rateLimited' })
    now += 60_000
    await expect(reader.read('/tmp/no-such-codex-home')).rejects.toMatchObject({ code: 'rateLimited' })
    expect(calls).toBe(1)
  })

  it('takes the last rate limits of a rollout and skips other lines', () => {
    const text = [
      JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 1_790_000_000 } } } }),
      JSON.stringify({ timestamp: '2026-10-01T11:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 30, window_minutes: 300, resets_at: 1_790_000_000 } } } }),
      JSON.stringify({ timestamp: '2026-10-01T11:01:00Z', type: 'response_item', payload: { type: 'message', text: 'rate_limits are fine' } }),
      'garbage'
    ].join('\n')
    expect(lastRateLimits(text)).toEqual([{ window: '5h', percent: 30, resetsAt: 1_790_000_000_000, asOf: Date.parse('2026-10-01T11:00:00Z') }])
    expect(lastRateLimits('')).toEqual([])
    // A per-model bucket written after the main limit does not replace it.
    const tc = (id: string | null, p: number) => JSON.stringify({ timestamp: '2026-10-20T08:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: id, primary: { used_percent: p, window_minutes: 300 } } } })
    expect(lastRateLimits([tc(null, 20), tc('codex_bengalfox', 2)].join('\n'))[0]?.percent).toBe(20)
    expect(lastRateLimits(tc('codex_bengalfox', 2))[0]?.percent).toBe(2)
  })
})
