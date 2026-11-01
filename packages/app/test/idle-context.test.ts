import { describe, expect, it } from 'vitest'
import { CACHE_LIFETIME_MS, idleContext, lastActivityAt } from '../src/renderer/lib/idle-context'
import type { ChatItem } from '../src/renderer/store'

const usd = (amount: number) => ({ amount, currency: 'USD' })
const context = { used: 120_000, coldCost: usd(0.96), warmCost: usd(0.024) }

describe('idle context notice', () => {
  it('takes the newest timestamp among the items, skipping the ones without one', () => {
    const items: ChatItem[] = [
      { id: 1, kind: 'replayStart', count: 3 },
      { id: 2, at: 1_000, kind: 'user', text: 'hi' },
      { id: 3, at: 5_000, kind: 'turnEnd', stopReason: 'end_turn' },
      { id: 4, kind: 'agent', text: 'no time' }
    ]
    expect(lastActivityAt(items)).toBe(5_000)
    expect(lastActivityAt([])).toBeUndefined()
  })

  it('shows past the cache lifetime with the context size and both costs', () => {
    const last = 0
    expect(idleContext(last, CACHE_LIFETIME_MS - 1, context)).toBeUndefined()
    expect(idleContext(last, CACHE_LIFETIME_MS, context)).toEqual({ idleMs: CACHE_LIFETIME_MS, expired: false, tokens: 120_000, coldCost: usd(0.96), warmCost: usd(0.024) })
  })

  it('stays hidden for a small context, an unknown one or no activity', () => {
    const late = CACHE_LIFETIME_MS * 10
    expect(idleContext(0, late, { used: 5_000 })).toBeUndefined()
    expect(idleContext(0, late, { percent: 40 })).toBeUndefined()
    expect(idleContext(0, late, undefined)).toBeUndefined()
    expect(idleContext(undefined, late, context)).toBeUndefined()
  })

  it('shows tokens only when the agent reports no cost', () => {
    expect(idleContext(0, CACHE_LIFETIME_MS, { used: 50_000 })).toEqual({ idleMs: CACHE_LIFETIME_MS, expired: false, tokens: 50_000 })
  })

  it('follows the expiry the agent reported over the guess', () => {
    const hour = 60 * 60_000
    const reported = { ...context, cacheTtlMs: hour, cacheExpiresAt: hour }
    // Idle 30 minutes on a 1-hour cache: still warm, no notice.
    expect(idleContext(0, 30 * 60_000, reported)).toBeUndefined()
    expect(idleContext(0, hour + 2 * 60_000, reported)).toMatchObject({ expired: true, expiredForMs: 2 * 60_000, tokens: 120_000 })
    // Items added on resume carry the current time; idle still counts from the last request.
    expect(idleContext(hour + 2 * 60_000, hour + 2 * 60_000, reported)).toMatchObject({ idleMs: hour + 2 * 60_000, expired: true })
  })

  it('stays hidden when the known cost of a cold resend is under five cents', () => {
    expect(idleContext(0, CACHE_LIFETIME_MS, { used: 39_000, coldCost: usd(0.0078), warmCost: usd(0.00039) })).toBeUndefined()
    expect(idleContext(0, CACHE_LIFETIME_MS, { used: 39_000, coldCost: usd(0.05) })).toMatchObject({ tokens: 39_000 })
  })
})
