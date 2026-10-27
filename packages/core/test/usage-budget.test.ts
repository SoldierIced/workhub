import { describe, expect, it } from 'vitest'
import {
  alertTiers,
  appOptions,
  DEFAULT_USAGE_BUDGET,
  evaluateBudget,
  evaluateUsageAlerts,
  gatePrompt,
  liveWindows,
  parseConfig,
  parseThresholds,
  parseUsageAlertState,
  pruneUsageAlerts,
  RESET_TOLERANCE_MS,
  setCeiling,
  usageAccountKey,
  usageAlertKey,
  type PlanUsageWindow
} from '../src'

const NOW = Date.UTC(2026, 9, 27, 12)
const HOUR = 3_600_000
const w = (window: string, percent: number, resetsInHours?: number): PlanUsageWindow => ({ window, percent, ...(resetsInHours !== undefined ? { resetsAt: NOW + resetsInHours * HOUR } : {}) })

describe('usage budget policy', () => {
  it('keys accounts like automation agent keys', () => {
    expect(usageAccountKey('claude', null)).toBe('claude')
    expect(usageAccountKey('codex', 'work')).toBe('codex:work')
  })

  it('fails open: no ceilings, no windows, unknown windows', () => {
    expect(evaluateBudget([w('5h', 99, 1)], undefined, 5, NOW).action).toBe('allow')
    expect(evaluateBudget([], { weekly: 80 }, 5, NOW).action).toBe('allow')
    expect(evaluateBudget([w('5h', 99, 1)], { weekly: 80 }, 5, NOW).action).toBe('allow')
    expect(evaluateBudget([w('weekly', 99, 1)], { weekly: Number.NaN }, 5, NOW).action).toBe('allow')
  })

  it('blocks at or past a ceiling and warns inside the margin', () => {
    expect(evaluateBudget([w('weekly', 80, 30)], { weekly: 80 }, 5, NOW)).toEqual({ action: 'block', window: 'weekly', percent: 80, ceiling: 80, resetsAt: NOW + 30 * HOUR })
    expect(evaluateBudget([w('weekly', 76, 30)], { weekly: 80 }, 5, NOW)).toMatchObject({ action: 'warn', window: 'weekly' })
    expect(evaluateBudget([w('weekly', 74, 30)], { weekly: 80 }, 5, NOW).action).toBe('allow')
    // A margin wider than the ceiling warns from zero instead of never.
    expect(evaluateBudget([w('5h', 0, 1)], { '5h': 3 }, 5, NOW).action).toBe('warn')
  })

  it('reports the block that lasts longest and the warning with the least headroom', () => {
    const windows = [w('5h', 95, 2), w('weekly', 85, 50)]
    expect(evaluateBudget(windows, { '5h': 90, weekly: 80 }, 5, NOW)).toMatchObject({ action: 'block', window: 'weekly' })
    expect(evaluateBudget([w('5h', 88, 2), w('weekly', 79, 50)], { '5h': 90, weekly: 80 }, 5, NOW)).toMatchObject({ action: 'warn', window: 'weekly', percent: 79 })
  })

  it('ignores windows that have reset since they were read', () => {
    expect(liveWindows([w('5h', 99, -1), w('weekly', 10, 2), w('x', 5)], NOW).map((x) => x.window)).toEqual(['weekly', 'x'])
    expect(evaluateBudget([w('5h', 99, -0.1)], { '5h': 90 }, 5, NOW).action).toBe('allow')
  })

  it('gates prompts: the user confirms, automations pause, an override passes once', () => {
    const blocked = evaluateBudget([w('weekly', 92, 5)], { weekly: 90 }, 5, NOW)
    expect(gatePrompt(blocked, 'user').kind).toBe('confirm')
    expect(gatePrompt(blocked, 'automation').kind).toBe('pause')
    expect(gatePrompt(blocked, 'user', true).kind).toBe('send')
    expect(gatePrompt(blocked, 'automation', true).kind).toBe('send')
    const warned = evaluateBudget([w('weekly', 87, 5)], { weekly: 90 }, 5, NOW)
    expect(gatePrompt(warned, 'automation')).toEqual({ kind: 'send', status: warned })
  })

  it('raises, lowers and clears ceilings without leaving empty entries', () => {
    let b = setCeiling(DEFAULT_USAGE_BUDGET, 'claude', 'weekly', 80)
    b = setCeiling(b, 'claude', '5h', 90.4)
    expect(b.ceilings).toEqual({ claude: { weekly: 80, '5h': 90 } })
    b = setCeiling(b, 'claude', 'weekly', null)
    expect(b.ceilings).toEqual({ claude: { '5h': 90 } })
    b = setCeiling(b, 'claude', '5h', 0)
    expect(b.ceilings).toEqual({})
    expect(DEFAULT_USAGE_BUDGET.ceilings).toEqual({})
  })

  it('parses alert thresholds typed by the user', () => {
    expect(parseThresholds('95, 80 80;  x 120 0 50.4')).toEqual([50, 80, 95])
    expect(parseThresholds('')).toEqual([])
  })
})

describe('usage alerts', () => {
  const read = (accountKey: string, windows: PlanUsageWindow[]) => [{ accountKey, windows }]

  it('fires once per tier crossed, the highest only, and never on falling usage', () => {
    let r = evaluateUsageAlerts({}, read('claude', [w('weekly', 10, 40)]), [80, 95])
    expect(r.events).toEqual([])
    r = evaluateUsageAlerts(r.state, read('claude', [w('weekly', 97, 40)]), [80, 95])
    expect(r.events.map((e) => e.threshold)).toEqual([95])
    r = evaluateUsageAlerts(r.state, read('claude', [w('weekly', 81, 40)]), [80, 95])
    expect(r.events).toEqual([])
    r = evaluateUsageAlerts(r.state, read('claude', [w('weekly', 99, 40)]), [80, 95])
    expect(r.events).toEqual([])
  })

  it('re-arms when the window resets, tolerating drift in the reset time', () => {
    let r = evaluateUsageAlerts({}, read('codex', [w('5h', 85, 2)]), [80])
    expect(r.events).toHaveLength(1)
    const drifted: PlanUsageWindow = { window: '5h', percent: 86, resetsAt: NOW + 2 * HOUR + RESET_TOLERANCE_MS / 2 }
    r = evaluateUsageAlerts(r.state, read('codex', [drifted]), [80])
    expect(r.events).toHaveLength(0)
    r = evaluateUsageAlerts(r.state, read('codex', [w('5h', 82, 7)]), [80])
    expect(r.events.map((e) => [e.window, e.threshold])).toEqual([['5h', 80]])
  })

  it('treats a ceiling as a tier and marks it', () => {
    expect(alertTiers([95, 80, 80, 0, 101], 90)).toEqual([80, 90, 95])
    const r = evaluateUsageAlerts({}, read('claude:work', [w('weekly', 91, 40)]), [80, 95], { 'claude:work': { weekly: 90 } })
    expect(r.events).toEqual([{ accountKey: 'claude:work', window: 'weekly', threshold: 90, percent: 91, ceiling: true, resetsAt: NOW + 40 * HOUR }])
  })

  it('skips windows without a reset time and never mutates its input', () => {
    const state = { [usageAlertKey('claude', 'weekly')]: { resetsAt: NOW + 40 * HOUR, notified: 80 } }
    const frozen = JSON.stringify(state)
    const r = evaluateUsageAlerts(state, read('claude', [w('weekly', 99, 40), w('5h', 99)]), [80, 95])
    expect(JSON.stringify(state)).toBe(frozen)
    expect(r.events.map((e) => e.window)).toEqual(['weekly'])
  })

  it('prunes removed accounts and drops malformed stored entries', () => {
    const state = { 'claude::5h': { resetsAt: 1, notified: 80 }, 'codex:old::5h': { resetsAt: 1, notified: 80 } }
    expect(Object.keys(pruneUsageAlerts(state, ['claude']))).toEqual(['claude::5h'])
    expect(parseUsageAlertState({ a: { resetsAt: 1, notified: 2 }, b: { resetsAt: 'x' }, c: null })).toEqual({ a: { resetsAt: 1, notified: 2 } })
    expect(parseUsageAlertState([1])).toEqual({})
  })
})

describe('usage options in the config', () => {
  it('parses configs without the new fields unchanged, with defaults', () => {
    const parsed = parseConfig({ version: 5, options: { claudePlanUsage: true } })
    expect(parsed.options).toMatchObject({ claudePlanUsage: true, codexUsage: false, usageBudget: DEFAULT_USAGE_BUDGET })
    expect(appOptions({ options: undefined }).usageBudget).toEqual(DEFAULT_USAGE_BUDGET)
  })

  it('clamps hand-edited budget values and falls back on a malformed block', () => {
    const parsed = parseConfig({ version: 5, options: { usageBudget: { thresholds: [95, 80, 150], warnMargin: 80, ceilings: { claude: { weekly: 0 } } } } })
    expect(parsed.options?.usageBudget).toEqual({ alerts: true, thresholds: [80, 95, 100], warnMargin: 50, ceilings: { claude: { weekly: 1 } } })
    expect(parseConfig({ version: 5, options: { usageBudget: 'nope' } }).options?.usageBudget).toEqual(DEFAULT_USAGE_BUDGET)
  })
})
