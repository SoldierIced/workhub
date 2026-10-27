import { describe, expect, it } from 'vitest'
import { compactWindows } from '../src/renderer/lib/agent-usage'

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
