import { describe, expect, it } from 'vitest'
import { accountBudgetStatus, appOptions, DEFAULT_USAGE_BUDGET, effectiveCeilings, parseConfig, setCeiling, setSessionCeiling, type PlanUsageWindow } from '../src'

const NOW = Date.UTC(2026, 9, 27, 12)
const windows: PlanUsageWindow[] = [
  { window: '5h', percent: 60, resetsAt: NOW + 3_600_000 },
  { window: 'weekly', percent: 85, resetsAt: NOW + 86_400_000 }
]
const budget = setCeiling(DEFAULT_USAGE_BUDGET, 'claude:work', 'weekly', 80)

describe('per-session usage ceilings', () => {
  it('replace the account ceiling only for the windows the session sets', () => {
    expect(effectiveCeilings({ weekly: 80, '5h': 90 }, { weekly: 95 })).toEqual({ weekly: 95, '5h': 90 })
    expect(effectiveCeilings({ weekly: 80 }, undefined)).toEqual({ weekly: 80 })
    expect(effectiveCeilings(undefined, {})).toBeUndefined()
    // Invalid values in a stored override are ignored, not applied.
    expect(effectiveCeilings({ weekly: 80 }, { weekly: 0, '5h': 150 })).toEqual({ weekly: 80 })
  })

  it('lets a session go past the account ceiling, or stop earlier than it', () => {
    expect(accountBudgetStatus(budget, 'claude:work', windows, NOW).action).toBe('block')
    expect(accountBudgetStatus(budget, 'claude:work', windows, NOW, { weekly: 95 }).action).toBe('allow')
    expect(accountBudgetStatus(budget, 'claude:work', windows, NOW, { weekly: 100 }).action).toBe('allow')
    expect(accountBudgetStatus(DEFAULT_USAGE_BUDGET, 'claude:work', windows, NOW, { '5h': 50 })).toMatchObject({ action: 'block', window: '5h', ceiling: 50 })
    expect(accountBudgetStatus(DEFAULT_USAGE_BUDGET, 'claude:work', windows, NOW, { '5h': 63 })).toMatchObject({ action: 'warn', window: '5h' })
  })

  it('sets, rounds and clears one window', () => {
    let own = setSessionCeiling(undefined, 'weekly', 92.4)
    expect(own).toEqual({ weekly: 92 })
    own = setSessionCeiling(own, '5h', 40)
    expect(setSessionCeiling(own, 'weekly', null)).toEqual({ '5h': 40 })
    expect(setSessionCeiling({ weekly: 92 }, 'weekly', 0)).toEqual({})
  })
})

describe('Kiro usage option', () => {
  it('is off by default and kept when stored', () => {
    expect(appOptions({ options: undefined }).kiroUsage).toBe(false)
    const config = parseConfig({ version: 6, options: { kiroUsage: true } })
    expect(appOptions(config).kiroUsage).toBe(true)
  })
})
