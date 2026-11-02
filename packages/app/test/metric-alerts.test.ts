import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ALERT_RULES, type MetricAlert, type MetricDefinition, type MetricSample, type MetricSource } from '@workhub/core'
import { DemoMetricSource, HealthMetricSource, MetricAlertService, type MetricAlertsState } from '../src/main/metric-alerts'
import { registerMetricAlertsIpc } from '../src/main/metric-alerts-ipc'
import { metricAlertWords, trayText } from '../src/main/tray-text'
import type { HealthView } from '../src/shared/health-api'
import { alertRulesToForm, changeText, filterAlerts, formToAlertRules, sparklinePoints } from '../src/renderer/lib/metricAlerts'

// 2026-10-30 is a Friday.
const at = (day: string, hour = 12) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d!, hour).getTime()
}
const FRI = '2026-10-30'

const DEF: MetricDefinition = { id: 'orders.errors', label: 'Order errors', source: 'acme', direction: 'upIsBad', kind: 'count', absentIsZero: true }

/** Eight business days ending Friday: 40 a day, then `last`. */
function history(last: number, subject = 'checkout-api'): MetricSample[] {
  const days = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']
  return [...days.map((day) => ({ metric: DEF.id, subject, day, value: 40, source: 'acme' })), { metric: DEF.id, subject, day: FRI, value: last, source: 'acme' }]
}

function setup(over: { samples?: () => MetricSample[]; demo?: boolean; profiles?: string[]; failing?: boolean } = {}) {
  let saved: MetricAlertsState = { profiles: {} }
  const source: MetricSource = {
    id: 'acme',
    definitions: () => [DEF],
    collect: vi.fn(async () => {
      if (over.failing) throw new Error('down')
      return over.samples ? over.samples() : history(90)
    })
  }
  const notify = vi.fn()
  const changed = vi.fn()
  let now = at(FRI)
  const service = new MetricAlertService({
    profiles: async () => (over.profiles ?? ['acme']).map((id) => ({ id, rules: DEFAULT_ALERT_RULES })),
    sources: () => [source],
    store: { load: (fallback) => saved.profiles.acme ? saved : fallback, save: (v) => void (saved = JSON.parse(JSON.stringify(v))) },
    notify,
    changed,
    demo: over.demo,
    now: () => now
  })
  return { service, notify, changed, source, saved: () => saved, setNow: (n: number) => void (now = n) }
}

describe('MetricAlertService', () => {
  it('collects, opens an alert, stores series and alerts, notifies once and says what changed', async () => {
    const { service, notify, changed, saved } = setup()
    await service.tick()
    expect(notify).toHaveBeenCalledTimes(1)
    const [profileId, alerts] = notify.mock.calls[0] as [string, MetricAlert[]]
    expect(profileId).toBe('acme')
    expect(alerts).toMatchObject([{ kind: 'jump', severity: 'high', subject: 'checkout-api', status: 'new' }])
    expect(changed).toHaveBeenCalledWith('acme')
    expect(Object.keys(saved().profiles.acme!.series)).toEqual(['acme|orders.errors|checkout-api|'])
    // The same detection again: updated, not announced again.
    await service.tick()
    expect(notify).toHaveBeenCalledTimes(1)
    expect((await service.list('acme')).alerts).toHaveLength(1)
  })

  it('announces only at or above the minimum severity, and never in the demo', async () => {
    const medium = setup({ samples: () => history(65) })
    await medium.service.tick()
    expect(medium.notify).not.toHaveBeenCalled()
    expect((await medium.service.list('acme')).alerts[0]).toMatchObject({ severity: 'medium' })
    const demo = setup({ demo: true })
    await demo.service.tick()
    expect(demo.notify).not.toHaveBeenCalled()
    expect((await demo.service.list('acme')).demo).toBe(true)
  })

  it('applies an action, keeps it across a restart, and refreshes one profile on demand', async () => {
    const t = setup()
    await t.service.tick()
    const key = (await t.service.list('acme')).alerts[0]!.key
    const view = await t.service.setStatus('acme', key, { type: 'snooze', until: '7d' })
    expect(view.alerts[0]).toMatchObject({ status: 'snoozed' })
    expect(t.changed).toHaveBeenCalledTimes(2)
    // A new service reads the stored state.
    const again = new MetricAlertService({ profiles: async () => [{ id: 'acme', rules: DEFAULT_ALERT_RULES }], sources: () => [], store: { load: () => t.saved(), save: () => undefined }, notify: vi.fn(), changed: vi.fn() })
    expect((await again.list('acme')).alerts[0]).toMatchObject({ status: 'snoozed' })
    const refreshed = await t.service.refresh('acme')
    expect(refreshed.enabled).toBe(true)
    expect(t.source.collect).toHaveBeenCalledTimes(2)
  })

  it('a failing source keeps the stored history; a profile without Health is not enabled', async () => {
    const t = setup({ failing: true })
    await t.service.tick()
    expect((await t.service.list('acme')).alerts).toEqual([])
    expect((await t.service.list('other')).enabled).toBe(false)
  })
})

describe('metric sources of the app', () => {
  it('maps the Health view only when it is live or demo', async () => {
    const snapshot = { environmentId: 'prod', state: 'degraded', podVisibility: 'visible', reasons: [], blindSpots: [], errorServices: [{ service: 'checkout-api', stats: { recent: 50, typicalDay: 1, streakDays: 1, streakTruncated: false, daysWithData: 1, state: 'new' } }], pods: [], events: [], silentServices: [], reportingServiceCount: 1, slow: [], containerStderr: [] }
    const view = (state: HealthView['state']) => ({ state, refreshMinutes: 15, environments: [{ id: 'prod', name: 'Production', snapshot, errorUrls: {}, serviceUrls: {} }] }) as unknown as HealthView
    expect(await new HealthMetricSource(async () => view('ready')).collect('acme', at(FRI))).toMatchObject([{ metric: 'health.errors', subject: 'checkout-api', value: 50, segment: 'Production' }])
    expect(await new HealthMetricSource(async () => view('noConnection')).collect('acme', at(FRI))).toEqual([])
    expect((await new DemoMetricSource(async () => [1, 2, 3, 4, 5]).collect('acme', at(FRI))).length).toBeGreaterThan(100)
  })
})

describe('metric alerts IPC', () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  it('checks its arguments before acting', async () => {
    const handlers = new Map<string, Handler>()
    const service = { list: vi.fn(async () => ({ enabled: true, demo: false, alerts: [] })), setStatus: vi.fn(async () => ({ enabled: true, demo: false, alerts: [] })), refresh: vi.fn(async () => ({ enabled: true, demo: false, alerts: [] })) }
    registerMetricAlertsIpc({ handle: (c, h) => handlers.set(c, h as Handler), on: () => undefined }, service)
    const invoke = (c: string, ...a: unknown[]) => handlers.get(c)!({} as IpcMainInvokeEvent, ...a)
    await invoke('metricAlerts:list', 'acme')
    expect(service.list).toHaveBeenCalledWith('acme')
    expect(await invoke('metricAlerts:list', 42)).toMatchObject({ enabled: false, alerts: [] })
    await invoke('metricAlerts:setStatus', 'acme', 'k', { type: 'snooze', until: 'trendChange' })
    expect(service.setStatus).toHaveBeenCalledWith('acme', 'k', { type: 'snooze', until: 'trendChange' })
    expect(() => invoke('metricAlerts:setStatus', 'acme', 'k', { type: 'drop' })).toThrow()
    await invoke('metricAlerts:refresh', 'acme')
    expect(service.refresh).toHaveBeenCalledWith('acme')
  })
})

describe('metric alert wording and helpers', () => {
  const alert = (over: Partial<MetricAlert> = {}): MetricAlert => ({ key: 'k', kind: 'jump', severity: 'high', status: 'new', firstSeenDay: FRI, lastSeenDay: FRI, metric: 'orders.errors', label: 'Order errors', subject: 'checkout-api', segment: 'Production', source: 'acme', lastValue: 90, baseline: 40, changePct: 125, history: [], ...over })

  it('words one alert and folds several', () => {
    const { t } = trayText('en')
    expect(metricAlertWords([alert()], t)).toEqual({ title: 'Order errors jumped for checkout-api · Production', body: '90 vs 40 on a usual day (+125%)' })
    expect(metricAlertWords([alert({ kind: 'rateDrop', changePct: undefined, changePoints: -8, lastValue: 24, baseline: 32 })], t).body).toBe('24% vs 32% on a usual day (-8 points)')
    expect(metricAlertWords([alert(), alert({ key: 'b', subject: 'billing-api', segment: undefined })], t)).toEqual({ title: '2 new metric alerts', body: 'Order errors: checkout-api · Production, Order errors: billing-api' })
  })

  it('filters, words the change and draws a sparkline', () => {
    const list = [alert(), alert({ key: 'b', status: 'resolved', severity: 'low', kind: 'missingData' })]
    expect(filterAlerts(list, { kind: 'all', severity: 'all', status: 'open' }).map((a) => a.key)).toEqual(['k'])
    expect(filterAlerts(list, { kind: 'missingData', severity: 'all', status: 'all' }).map((a) => a.key)).toEqual(['b'])
    expect(changeText(alert(), 'pts')).toBe('+125%')
    expect(changeText({ changePoints: -8 }, 'pts')).toBe('−8 pts')
    expect(changeText({}, 'pts')).toBeNull()
    expect(sparklinePoints([0, 10], 10, 10, 0)).toBe('0,10 10,0')
    expect(sparklinePoints([5, 5], 10, 10, 0)).toBe('0,5 10,5')
    expect(sparklinePoints([], 10, 10)).toBe('')
  })

  it('round-trips the alert rules form, dropping blank rows and numbers', () => {
    const form = alertRulesToForm(undefined)
    form.overrides.push({ metric: ' health.errors ', minVolume: '5', jumpPct: '', rateDropPoints: 'x', critical: true, muted: false }, { metric: '', minVolume: '1', jumpPct: '', rateDropPoints: '', critical: false, muted: false })
    form.businessDays = [1, 2, 3, 4, 5, 6]
    const rules = formToAlertRules(form)
    expect(rules.overrides).toEqual({ 'health.errors': { minVolume: 5, critical: true } })
    expect(rules.businessDays).toEqual([1, 2, 3, 4, 5, 6])
    expect(alertRulesToForm(rules).overrides).toEqual([{ metric: 'health.errors', minVolume: '5', jumpPct: '', rateDropPoints: '', critical: true, muted: false }])
  })
})
