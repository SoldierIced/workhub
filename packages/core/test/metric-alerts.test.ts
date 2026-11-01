import { describe, expect, it } from 'vitest'
import {
  addDays,
  alertRulesOf,
  applyAlertAction,
  availableAlertActions,
  businessDaysAfter,
  CLOSED_ALERT_LIFETIME_MS,
  DEFAULT_ALERT_RULES,
  demoMetricSamples,
  detectMetricAlerts,
  detectSeries,
  healthMetricSamples,
  isAlertAction,
  lastBusinessDay,
  localDay,
  mergeSamples,
  reconcileAlerts,
  seriesKey,
  SERIES_RETENTION_DAYS,
  sortAlerts,
  DEMO_METRICS,
  type AlertRulesConfig,
  type MetricAlert,
  type MetricDefinition,
  type MetricDetection,
  type MetricSample,
  type MetricSeries
} from '../src'

// 2026-10-30 is a Friday; 2026-11-02 a Monday.
const at = (day: string, hour = 12) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d!, hour).getTime()
}
const FRI = '2026-10-30'
const SAT = '2026-10-31'
const MON = '2026-11-02'

const COUNT: MetricDefinition = { id: 'orders.errors', label: 'Order errors', source: 'acme', direction: 'upIsBad', kind: 'count', absentIsZero: true }
const DOWN: MetricDefinition = { id: 'signups', label: 'Sign-ups', source: 'acme', direction: 'downIsBad', kind: 'count' }
const RATE: MetricDefinition = { id: 'conversion', label: 'Conversion', source: 'acme', direction: 'downIsBad', kind: 'rate' }
const DAILY: MetricDefinition = { id: 'feed', label: 'Feed', source: 'acme', direction: 'upIsBad', kind: 'count', expectDaily: true }

/** Business-day values ending on `last` (weekends skipped), oldest first. */
function businessSamples(def: MetricDefinition, subject: string, values: number[], last: string, extra: Partial<MetricSample> = {}): MetricSample[] {
  const out: MetricSample[] = []
  let day = last
  for (let i = values.length - 1; i >= 0; i--) {
    while ([0, 6].includes(new Date(at(day)).getDay())) day = addDays(day, -1)
    out.push({ metric: def.id, subject, day, value: values[i]!, source: def.source, at: at(day), ...extra })
    day = addDays(day, -1)
  }
  return out
}

function seriesOf(def: MetricDefinition, values: number[], last = FRI, subject = 'checkout-api', extra: Partial<MetricSample> = {}): MetricSeries {
  const store = mergeSamples({}, businessSamples(def, subject, values, last, extra), at(last))
  return Object.values(store)[0]!
}

const rules = (patch: Partial<AlertRulesConfig> = {}): AlertRulesConfig => ({ ...DEFAULT_ALERT_RULES, ...patch })
const flat = (n: number, v = 40) => Array.from({ length: n }, () => v)

describe('days', () => {
  it('finds the latest business day and counts business days between two days', () => {
    expect(lastBusinessDay(SAT, [1, 2, 3, 4, 5])).toBe(FRI)
    expect(lastBusinessDay(MON, [1, 2, 3, 4, 5])).toBe(MON)
    expect(lastBusinessDay(SAT, [6])).toBe(SAT)
    expect(businessDaysAfter(FRI, '2026-11-04', [1, 2, 3, 4, 5])).toBe(3)
    expect(localDay(at(FRI, 23))).toBe(FRI)
  })
})

describe('mergeSamples', () => {
  it('keeps one point per day (the last write wins), sorted, under one key per source, metric, subject and segment', () => {
    const s = (day: string, value: number, segment?: string): MetricSample => ({ metric: 'm', subject: 'a', segment, day, value, source: 'acme' })
    const store = mergeSamples(mergeSamples({}, [s(FRI, 1), s('2026-10-29', 5)], at(FRI)), [s(FRI, 3), s(FRI, 9, 'eu')], at(FRI, 15))
    expect(Object.keys(store).sort()).toEqual(['acme|m|a|', 'acme|m|a|eu'])
    expect(store['acme|m|a|']!.points).toEqual([
      { day: '2026-10-29', value: 5 },
      { day: FRI, value: 3 }
    ])
    expect(store['acme|m|a|']!.lastSampleAt).toBe(at(FRI, 15))
    expect(seriesKey({ source: 'acme', metric: 'm', subject: 'a' })).toBe('acme|m|a|')
  })

  it(`drops days older than ${SERIES_RETENTION_DAYS} days, empty series and bad samples`, () => {
    const old = addDays(FRI, -SERIES_RETENTION_DAYS)
    const store = mergeSamples(
      { 'acme|m|gone|': { key: 'acme|m|gone|', source: 'acme', metric: 'm', subject: 'gone', points: [{ day: old, value: 1 }] } },
      [
        { metric: 'm', subject: 'a', day: addDays(FRI, -(SERIES_RETENTION_DAYS - 1)), value: 1, source: 'acme' },
        { metric: 'm', subject: 'a', day: old, value: 1, source: 'acme' },
        { metric: 'm', subject: 'a', day: addDays(FRI, 1), value: 1, source: 'acme' },
        { metric: 'm', subject: 'a', day: '2026-13-01', value: 1, source: 'acme' },
        { metric: 'm', subject: 'a', day: FRI, value: Number.NaN, source: 'acme' },
        { metric: '', subject: 'a', day: FRI, value: 1, source: 'acme' }
      ],
      at(FRI)
    )
    expect(Object.keys(store)).toEqual(['acme|m|a|'])
    expect(store['acme|m|a|']!.points).toHaveLength(1)
  })
})

describe('rules', () => {
  it('jump: today above the previous 7 business days by the percentage, high above twice it', () => {
    const medium = detectSeries(seriesOf(COUNT, [...flat(7), 65]), COUNT, rules(), at(FRI))
    expect(medium).toMatchObject({ kind: 'jump', severity: 'medium', value: 65, baseline: 40, changePct: 62.5 })
    expect(detectSeries(seriesOf(COUNT, [...flat(7), 90]), COUNT, rules(), at(FRI))).toMatchObject({ kind: 'jump', severity: 'high' })
    expect(detectSeries(seriesOf(COUNT, [...flat(7), 45]), COUNT, rules(), at(FRI))).toBeNull()
  })

  it('jump: also beyond k standard deviations', () => {
    const values = [100, 100, 100, 100, 100, 100, 100, 125]
    expect(detectSeries(seriesOf(COUNT, values), COUNT, rules(), at(FRI))).toMatchObject({ kind: 'jump', severity: 'medium' })
    // √mean keeps a flat history from making every wobble a jump.
    expect(detectSeries(seriesOf(COUNT, [100, 100, 100, 100, 100, 100, 100, 115]), COUNT, rules(), at(FRI))).toBeNull()
  })

  it('near threshold: 80% of the jump percentage is a low alert', () => {
    expect(detectSeries(seriesOf(COUNT, [...flat(7, 100), 142]), COUNT, rules({ thresholds: { ...DEFAULT_ALERT_RULES.thresholds, jumpStdDevs: 10 } }), at(FRI))).toMatchObject({ kind: 'jump', severity: 'low' })
  })

  it('sustained trend: rises N business days in a row and ends above the average by the percentage', () => {
    const d = detectSeries(seriesOf(COUNT, [40, 40, 40, 40, 41, 44, 48, 53]), COUNT, rules(), at(FRI))
    expect(d).toMatchObject({ kind: 'sustainedTrend', severity: 'medium' })
    // Two rises only.
    expect(detectSeries(seriesOf(COUNT, [40, 40, 40, 40, 40, 44, 44, 50]), COUNT, rules(), at(FRI))).toBeNull()
    // Configurable days.
    expect(detectSeries(seriesOf(COUNT, [40, 40, 40, 40, 40, 44, 47, 50]), COUNT, rules({ thresholds: { ...DEFAULT_ALERT_RULES.thresholds, trendDays: 2 } }), at(FRI))).toMatchObject({ kind: 'sustainedTrend' })
  })

  it('minimum volume: nothing alerts below the floor', () => {
    expect(detectSeries(seriesOf(COUNT, [...flat(7, 2), 15]), COUNT, rules(), at(FRI))).toBeNull()
    expect(detectSeries(seriesOf(COUNT, [...flat(7, 2), 15]), COUNT, rules({ overrides: { [COUNT.id]: { minVolume: 5 } } }), at(FRI))).toMatchObject({ kind: 'jump', severity: 'high' })
  })

  it('new subject: first appearance in 30 days above the floor, once the source is warmed up', () => {
    const store = mergeSamples({}, [...businessSamples(COUNT, 'old', flat(10), FRI), ...businessSamples(COUNT, 'fresh', [30], FRI)], at(FRI))
    const found = detectMetricAlerts(store, [COUNT], rules(), at(FRI))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ subject: 'fresh', kind: 'newSubject', severity: 'medium', baseline: 0 })
    // A fresh install: every subject is new, so nothing is announced.
    expect(detectMetricAlerts(mergeSamples({}, businessSamples(COUNT, 'fresh', [30], FRI), at(FRI)), [COUNT], rules(), at(FRI))).toEqual([])
    // Below the floor.
    const quiet = mergeSamples({}, [...businessSamples(COUNT, 'old', flat(10), FRI), ...businessSamples(COUNT, 'fresh', [5], FRI)], at(FRI))
    expect(detectMetricAlerts(quiet, [COUNT], rules(), at(FRI))).toEqual([])
  })

  it('rate drop: points below the average, high above twice the limit, medium between, low near it', () => {
    const rate = (last: number, base = 500) => seriesOf(RATE, [...flat(7, 32), last], FRI, 'web', { base })
    expect(detectSeries(rate(24), RATE, rules(), at(FRI))).toMatchObject({ kind: 'rateDrop', severity: 'medium', changePoints: -8 })
    expect(detectSeries(rate(20), RATE, rules(), at(FRI))).toMatchObject({ kind: 'rateDrop', severity: 'high' })
    expect(detectSeries(rate(27.8), RATE, rules(), at(FRI))).toMatchObject({ kind: 'rateDrop', severity: 'low' })
    expect(detectSeries(rate(31), RATE, rules(), at(FRI))).toBeNull()
    // A rise is good for a downIsBad rate; and a small base is below the floor.
    expect(detectSeries(rate(45), RATE, rules(), at(FRI))).toBeNull()
    expect(detectSeries(rate(20, 10), RATE, rules(), at(FRI))).toBeNull()
  })

  it('direction: a downIsBad metric alerts on drops, never on rises', () => {
    expect(detectSeries(seriesOf(DOWN, [...flat(7, 200), 60]), DOWN, rules(), at(FRI))).toMatchObject({ kind: 'jump', severity: 'medium', changePct: -70 })
    expect(detectSeries(seriesOf(DOWN, [...flat(7, 200), 500]), DOWN, rules(), at(FRI))).toBeNull()
    expect(detectSeries(seriesOf(COUNT, [...flat(7, 200), 60]), COUNT, rules(), at(FRI))).toBeNull()
  })

  it('business days: the weekend is skipped, and Saturday evaluates Friday', () => {
    // Saturday's spike is not a business day; Friday is quiet.
    const samples = [...businessSamples(COUNT, 'a', flat(8), FRI), { metric: COUNT.id, subject: 'a', day: SAT, value: 500, source: 'acme' }]
    const series = Object.values(mergeSamples({}, samples, at(SAT)))[0]!
    expect(detectSeries(series, COUNT, rules(), at(SAT))).toBeNull()
    // Counting Saturday as a business day, it alerts.
    expect(detectSeries(series, COUNT, rules({ businessDays: [1, 2, 3, 4, 5, 6] }), at(SAT))).toMatchObject({ kind: 'jump', day: SAT })
  })

  it('absent days count as zero only for metrics that say so', () => {
    const sparse = Object.values(mergeSamples({}, [{ metric: COUNT.id, subject: 'a', day: '2026-10-19', value: 40, source: 'acme' }, ...businessSamples(COUNT, 'a', [90], FRI)], at(FRI)))[0]!
    // Zero-filled: the baseline is mostly zeros, so 90 is a jump.
    expect(detectSeries(sparse, COUNT, rules(), at(FRI))).toMatchObject({ kind: 'jump', severity: 'high' })
    // Not zero-filled: a single earlier day is too little baseline.
    expect(detectSeries({ ...sparse }, { ...COUNT, absentIsZero: false }, rules(), at(FRI))).toBeNull()
  })

  it('missing data: an expected series without a sample for 24 h on a business day', () => {
    const series = seriesOf(DAILY, flat(6, 30), '2026-10-29')
    expect(detectSeries(series, DAILY, rules(), at(FRI, 18))).toMatchObject({ kind: 'missingData', severity: 'low' })
    // Not on a weekend, and not within 24 h.
    expect(detectSeries(series, DAILY, rules(), at(SAT, 18))).toBeNull()
    expect(detectSeries(series, DAILY, rules(), at(FRI, 9))).toBeNull()
    // A metric that does not expect daily samples never reports a gap.
    expect(detectSeries(series, { ...DAILY, expectDaily: false }, rules(), at(FRI, 18))).toBeNull()
  })

  it('critical metrics are high; muted metrics never alert', () => {
    expect(detectSeries(seriesOf(COUNT, [...flat(7), 65]), { ...COUNT, critical: true }, rules(), at(FRI))).toMatchObject({ severity: 'high' })
    expect(detectSeries(seriesOf(COUNT, [...flat(7), 65]), COUNT, rules({ overrides: { [COUNT.id]: { critical: true } } }), at(FRI))).toMatchObject({ severity: 'high' })
    expect(detectSeries(seriesOf(COUNT, [...flat(7), 90]), COUNT, rules({ overrides: { [COUNT.id]: { muted: true } } }), at(FRI))).toBeNull()
  })

  it('carries a 14-day history and the metric label and link', () => {
    const d = detectSeries(seriesOf(COUNT, [...flat(20), 90], FRI, 'a', { link: 'https://dash.example.test/a' }), COUNT, rules(), at(FRI))!
    expect(d.history).toHaveLength(14)
    expect(d.history.at(-1)).toEqual({ day: FRI, value: 90 })
    expect(d).toMatchObject({ label: 'Order errors', link: 'https://dash.example.test/a' })
  })
})

describe('alertRulesOf', () => {
  it('fills defaults and clamps hand-edited values', () => {
    expect(alertRulesOf(undefined)).toEqual(DEFAULT_ALERT_RULES)
    const r = alertRulesOf({ thresholds: { ...DEFAULT_ALERT_RULES.thresholds, jumpPct: -5 }, businessDays: [9, 3, 1, 1], notifyMinSeverity: 'nope' as never, overrides: { ' feed ': { minVolume: 1e12, critical: true } } })
    expect(r.thresholds.jumpPct).toBe(1)
    expect(r.businessDays).toEqual([1, 3])
    expect(r.notifyMinSeverity).toBe('high')
    expect(r.overrides).toEqual({ feed: { minVolume: 1_000_000_000, critical: true } })
  })
})

describe('reconcileAlerts', () => {
  const detection = (over: Partial<MetricDetection> = {}): MetricDetection => ({
    key: 'acme|orders.errors|checkout-api|',
    kind: 'jump',
    severity: 'medium',
    source: 'acme',
    metric: 'orders.errors',
    subject: 'checkout-api',
    day: FRI,
    value: 65,
    baseline: 40,
    changePct: 62.5,
    history: [{ day: FRI, value: 65 }],
    ...over
  })

  it('opens one alert per key and updates it on re-detection', () => {
    const first = reconcileAlerts([], [detection()], at(FRI))
    expect(first.opened).toHaveLength(1)
    expect(first.alerts[0]).toMatchObject({ status: 'new', firstSeenDay: FRI, lastSeenDay: FRI, lastValue: 65 })
    const again = reconcileAlerts(first.alerts, [detection({ day: MON, value: 70 }), detection({ day: MON, value: 75 })], at(MON))
    expect(again.alerts).toHaveLength(1)
    expect(again.opened).toEqual([])
    expect(again.escalated).toEqual([])
    expect(again.alerts[0]).toMatchObject({ status: 'new', firstSeenDay: FRI, lastSeenDay: MON, lastValue: 75 })
  })

  it('escalates when severity rises, and never lowers it while open', () => {
    const first = reconcileAlerts([], [detection()], at(FRI)).alerts
    const up = reconcileAlerts(first, [detection({ severity: 'high' })], at(FRI))
    expect(up.escalated).toHaveLength(1)
    expect(up.alerts[0]!.severity).toBe('high')
    const down = reconcileAlerts(up.alerts, [detection({ severity: 'low' })], at(FRI))
    expect(down.alerts[0]!.severity).toBe('high')
    expect(down.escalated).toEqual([])
  })

  it('proposes to resolve after 3 quiet business days', () => {
    const first = reconcileAlerts([], [detection()], at(FRI)).alerts
    expect(reconcileAlerts(first, [], at('2026-11-03')).alerts[0]!.proposeResolve).toBe(false)
    const later = reconcileAlerts(first, [], at('2026-11-04')).alerts
    expect(later[0]!.proposeResolve).toBe(true)
    // Detected again: no longer proposed.
    expect(reconcileAlerts(later, [detection({ day: '2026-11-04' })], at('2026-11-04')).alerts[0]!.proposeResolve).toBe(false)
  })

  it('snoozes for a while: quiet until it expires, then new again', () => {
    const first = reconcileAlerts([], [detection()], at(FRI)).alerts
    const snoozed = applyAlertAction(first, first[0]!.key, { type: 'snooze', until: '7d' }, at(FRI))
    expect(snoozed[0]).toMatchObject({ status: 'snoozed', snoozedUntil: at(FRI) + 7 * 86_400_000 })
    const during = reconcileAlerts(snoozed, [detection({ severity: 'high', day: MON })], at(MON))
    expect(during.escalated).toEqual([])
    expect(during.alerts[0]).toMatchObject({ status: 'snoozed', severity: 'high' })
    const after = reconcileAlerts(during.alerts, [detection({ day: '2026-11-09' })], at('2026-11-09'))
    expect(after.alerts[0]!.status).toBe('new')
    expect(after.alerts[0]!.snoozedUntil).toBeUndefined()
  })

  it('snoozes until the trend changes: a new rule kind or a higher severity wakes it', () => {
    const first = reconcileAlerts([], [detection()], at(FRI)).alerts
    const snoozed = applyAlertAction(first, first[0]!.key, { type: 'snooze', until: 'trendChange' }, at(FRI))
    expect(reconcileAlerts(snoozed, [detection({ day: MON })], at(MON)).alerts[0]!.status).toBe('snoozed')
    const kind = reconcileAlerts(snoozed, [detection({ kind: 'sustainedTrend', day: MON })], at(MON))
    expect(kind.alerts[0]!.status).toBe('new')
    expect(kind.escalated).toHaveLength(1)
    const worse = reconcileAlerts(snoozed, [detection({ severity: 'high', day: MON })], at(MON))
    expect(worse.alerts[0]!.status).toBe('new')
    expect(worse.escalated).toHaveLength(1)
  })

  it('keeps a resolved alert closed for the same day, reopens it on a later day, and prunes it after 7 days', () => {
    const first = reconcileAlerts([], [detection()], at(FRI)).alerts
    const resolved = applyAlertAction(first, first[0]!.key, { type: 'resolve' }, at(FRI, 13))
    expect(resolved[0]).toMatchObject({ status: 'resolved', closedAt: at(FRI, 13) })
    const same = reconcileAlerts(resolved, [detection()], at(FRI, 14))
    expect(same.opened).toEqual([])
    expect(same.alerts[0]!.status).toBe('resolved')
    const later = reconcileAlerts(resolved, [detection({ day: MON })], at(MON))
    expect(later.opened).toHaveLength(1)
    expect(later.alerts[0]).toMatchObject({ status: 'new', firstSeenDay: MON })
    expect(reconcileAlerts(resolved, [], at(FRI, 13) + CLOSED_ALERT_LIFETIME_MS - 1).alerts).toHaveLength(1)
    expect(reconcileAlerts(resolved, [], at(FRI, 13) + CLOSED_ALERT_LIFETIME_MS).alerts).toEqual([])
  })
})

describe('alert actions and order', () => {
  const alert = (over: Partial<MetricAlert>): MetricAlert => ({ key: 'k', kind: 'jump', severity: 'medium', status: 'new', firstSeenDay: FRI, lastSeenDay: FRI, metric: 'm', subject: 's', source: 'acme', lastValue: 1, baseline: 1, history: [], ...over })

  it('offers the actions of each status and applies track and reopen', () => {
    expect(availableAlertActions({ status: 'new' })).toEqual(['track', 'snooze', 'resolve'])
    expect(availableAlertActions({ status: 'resolved' })).toEqual(['reopen'])
    expect(applyAlertAction([alert({})], 'k', { type: 'track' }, 0)[0]!.status).toBe('tracking')
    const reopened = applyAlertAction([alert({ status: 'resolved', closedAt: 5 })], 'k', { type: 'reopen' }, 9)[0]!
    expect(reopened.status).toBe('tracking')
    expect(reopened.closedAt).toBeUndefined()
    expect(isAlertAction({ type: 'snooze', until: '30d' })).toBe(true)
    expect(isAlertAction({ type: 'snooze', until: 'forever' })).toBe(false)
    expect(isAlertAction({ type: 'delete' })).toBe(false)
  })

  it('sorts by severity, then the most recent', () => {
    const list = sortAlerts([alert({ key: 'a', severity: 'low' }), alert({ key: 'b', severity: 'high', lastSeenDay: '2026-10-28' }), alert({ key: 'c', severity: 'high' })])
    expect(list.map((a) => a.key)).toEqual(['c', 'b', 'a'])
  })
})

describe('sources', () => {
  it('maps Health environments to daily samples and skips unread ones', () => {
    const stats = (recent: number) => ({ recent, typicalDay: 1, streakDays: 1, streakTruncated: false, daysWithData: 1, state: 'ongoing' as const })
    const samples = healthMetricSamples(
      [
        {
          name: 'Production',
          snapshot: {
            state: 'degraded',
            blindSpots: [],
            errorServices: [{ service: 'checkout-api', stats: stats(120) }],
            containerStderr: [{ key: 'billing-worker', stats: stats(30) }],
            slow: [
              { service: 'checkout-api', name: 'POST /orders', calls: 300, p50Ms: 1, p95Ms: 2, p99Ms: 3, failureRate: 0.1 },
              { service: 'checkout-api', name: 'GET /orders', calls: 100, p50Ms: 1, p95Ms: 2, p99Ms: 3, failureRate: 0.5 }
            ]
          },
          errorUrls: { 'checkout-api': 'https://kibana.example.test/errors' }
        },
        { name: 'Staging', snapshot: { state: 'blind', blindSpots: [{ code: 'notReadYet' }], errorServices: [{ service: 'x', stats: stats(9) }], containerStderr: [], slow: [] } }
      ],
      at(FRI)
    )
    expect(samples.map((s) => [s.metric, s.subject, s.value, s.base])).toEqual([
      ['health.errors', 'checkout-api', 120, undefined],
      ['health.stderr', 'billing-worker', 30, undefined],
      ['health.slowCalls', 'checkout-api', 400, undefined],
      ['health.slowFailureRate', 'checkout-api', 20, 400]
    ])
    expect(samples[0]).toMatchObject({ day: FRI, segment: 'Production', source: 'health', link: 'https://kibana.example.test/errors' })
  })

  it('the demo history shows each rule', () => {
    const now = at('2026-11-03', 15)
    const store = mergeSamples({}, demoMetricSamples(now), now)
    const found = detectMetricAlerts(store, DEMO_METRICS, DEFAULT_ALERT_RULES, now)
    const bySubject = Object.fromEntries(found.map((d) => [`${d.metric}/${d.subject}`, [d.kind, d.severity]]))
    expect(bySubject).toEqual({
      'demo.paymentErrors/checkout-api': ['jump', 'high'],
      'demo.paymentErrors/billing-api': ['sustainedTrend', 'medium'],
      'demo.paymentErrors/notifications-worker': ['newSubject', 'medium'],
      'demo.checkoutConversion/web': ['rateDrop', 'medium'],
      'demo.signups/mobile': ['missingData', 'low']
    })
  })
})
