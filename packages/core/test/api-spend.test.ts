import { describe, expect, it } from 'vitest'
import { apiSpendSummary, localDayKey } from '../src'

const NOW = new Date(2026, 9, 27, 15).getTime()
const day = (back: number) => localDayKey(new Date(2026, 9, 27 - back, 12))

describe('apiSpendSummary', () => {
  it('sums each agent per day over the last 7 days, biggest week first', () => {
    const out = apiSpendSummary(
      [
        { agent: 'opencode', day: day(0), usd: 1.5, tokens: 1000 },
        { agent: 'opencode', day: day(0), usd: 0.5 },
        { agent: 'opencode', day: day(3), usd: 2 },
        { agent: 'codex', day: day(1), usd: 0.25, tokens: 10, unpricedTokens: 400 },
        { agent: 'codex', day: day(7), usd: 99 },
        { agent: 'gemini', day: day(0), usd: 0 }
      ],
      NOW
    )
    expect(out.map((a) => [a.agent, a.today, a.week, a.tokens, a.unpricedTokens])).toEqual([
      ['opencode', 2, 4, 1000, 0],
      ['codex', 0, 0.25, 410, 400]
    ])
    expect(out[0]?.days).toHaveLength(7)
    expect(out[0]?.days[6]).toEqual({ day: day(0), usd: 2 })
    expect(out[0]?.days[3]).toEqual({ day: day(3), usd: 2 })
  })
})
