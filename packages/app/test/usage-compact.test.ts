import { describe, expect, it } from 'vitest'
import { accountHoverText, compactWindows, kiroSpendLines } from '../src/renderer/lib/agent-usage'

const w = (window: string) => ({ window, percent: 10 })

describe('compactWindows', () => {
  it('shows the base windows side by side and leaves per-model ones for the hover', () => {
    const { shown, extra } = compactWindows([w('5h'), w('weekly'), w('weekly Sonnet')])
    expect(shown.map((x) => x.window)).toEqual(['5h', 'weekly'])
    expect(extra.map((x) => x.window)).toEqual(['weekly Sonnet'])
  })

  it('falls back to the first two windows when none is a base window', () => {
    const { shown, extra } = compactWindows([w('credits'), w('daily'), w('other')])
    expect(shown.map((x) => x.window)).toEqual(['credits', 'daily'])
    expect(extra.map((x) => x.window)).toEqual(['other'])
  })

  it('keeps a single window and no extras', () => {
    expect(compactWindows([w('monthly')])).toEqual({ shown: [w('monthly')], extra: [] })
    expect(compactWindows([])).toEqual({ shown: [], extra: [] })
  })
})

describe('accountHoverText', () => {
  it('puts the title first, then every block with a blank line between, skipping empty ones', () => {
    expect(accountHoverText('Kiro · KIRO POWER', ['monthly: 25%\n2,500 of 10,000 credits used', undefined, '', '  ', 'spent 3 today'])).toBe(
      'Kiro · KIRO POWER\n\nmonthly: 25%\n2,500 of 10,000 credits used\n\nspent 3 today'
    )
  })

  it('is just the title when nothing else is known', () => {
    expect(accountHoverText('Claude', [null, undefined])).toBe('Claude')
  })
})

describe('kiroSpendLines', () => {
  it('lists each day under the heading, rounded to cents', () => {
    expect(
      kiroSpendLines(
        'Credits per day',
        [
          { day: '2026-10-26', credits: 1.234 },
          { day: '2026-10-27', credits: 0.5 }
        ],
        String
      )
    ).toBe('Credits per day\n2026-10-26: 1.23\n2026-10-27: 0.5')
  })
})
