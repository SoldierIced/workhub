import { describe, expect, it } from 'vitest'
import {
  breaches,
  CONFIG_VERSION,
  configSchema,
  DEFAULT_FLOW_MIN_CALLS,
  flowThresholds,
  healthAlerts,
  healthAlertSettingsOf,
  HEALTH_ALERT_KINDS,
  inQuietHours,
  parseFlowMap,
  quietNow,
  setJsonField,
  withAlertThresholds
} from '../src'

const at = (hour: number) => new Date(2026, 10, 5, hour, 30).getTime()

describe('Health alerts per kind', () => {
  it('defaults to today: every kind on, every channel, no own threshold', () => {
    const s = healthAlertSettingsOf(undefined)
    expect(Object.keys(s).sort()).toEqual([...HEALTH_ALERT_KINDS].sort())
    for (const kind of HEALTH_ALERT_KINDS) expect(s[kind]).toEqual({ notify: true, channels: ['notification', 'tray'] })
  })

  it('reads stored settings, clamps thresholds and ignores one on a kind that has none', () => {
    const s = healthAlertSettingsOf({ podDown: { notify: false, threshold: 5 }, stoppedReporting: { notify: true, threshold: 99_999, channels: ['tray'] }, errorsWorsening: { notify: true, threshold: 0 } })
    expect(s.podDown).toEqual({ notify: false, channels: ['notification', 'tray'] })
    expect(s.stoppedReporting).toEqual({ notify: true, threshold: 1440, channels: ['tray'] })
    expect(s.errorsWorsening.threshold).toBe(1)
  })

  it('parses from the config file without a migration, and an old file has none', () => {
    const base = { version: CONFIG_VERSION, profiles: [{ id: 'p', name: 'P', health: { environments: [] } }] }
    expect(configSchema.parse(base).profiles[0]?.health?.alerts).toBeUndefined()
    const parsed = configSchema.parse({
      ...base,
      profiles: [{ id: 'p', name: 'P', health: { environments: [], alerts: { degraded: { notify: false, threshold: 3 }, stoppedReporting: { threshold: 30, channels: ['tray', 'tray'] } } }, alerts: { quietHours: { startHour: 22, endHour: 24 } } }]
    })
    const p = parsed.profiles[0]!
    expect(p.health?.alerts?.degraded?.notify).toBe(false)
    expect(p.health?.alerts?.degraded?.threshold).toBeUndefined()
    expect(p.health?.alerts?.stoppedReporting).toEqual({ notify: true, threshold: 30, channels: ['tray'] })
    expect(p.alerts).toEqual({ quietHours: { startHour: 22, endHour: 0 } })
    expect(configSchema.parse({ ...base, profiles: [{ id: 'p', name: 'P', alerts: {} }] }).profiles[0]?.alerts).toEqual({ quietHours: null })
  })

  it('narrows what the comparison sees by the silent minutes and the error factor', () => {
    const stats = (recent: number, typicalDay: number) => ({ recent, typicalDay, streakDays: 1, streakTruncated: false, daysWithData: 5, state: 'worsening' as const })
    const snapshot = {
      silentServices: [{ service: 'a', lastSeen: 0, silentMinutes: 12, isReporting: false }, { service: 'b', lastSeen: 0, silentMinutes: 40, isReporting: false }],
      errorServices: [{ service: 'x', stats: stats(30, 10) }, { service: 'y', stats: stats(100, 10) }, { service: 'z', stats: stats(50, 0) }]
    }
    const s = healthAlertSettingsOf({ stoppedReporting: { notify: true, threshold: 30 }, errorsWorsening: { notify: true, threshold: 5 } })
    const narrowed = withAlertThresholds(snapshot, s)
    expect(narrowed.silentServices.map((x) => x.service)).toEqual(['b'])
    expect(narrowed.errorServices.map((x) => x.service)).toEqual(['y', 'z'])
    expect(withAlertThresholds(snapshot, healthAlertSettingsOf(undefined))).toBe(snapshot)
  })

  it('announces a silent service once it crosses its threshold, not before', () => {
    const settings = healthAlertSettingsOf({ stoppedReporting: { notify: true, threshold: 20 } })
    const readout = (minutes: number[]) => ({
      id: 'prod',
      name: 'PROD',
      state: 'healthy' as const,
      snapshot: withAlertThresholds({ silentServices: minutes.map((m) => ({ service: 'api', lastSeen: 0, silentMinutes: m, isReporting: false })), pods: [], errorServices: [], podVisibility: 'visible' as const, blindSpots: [] }, settings)
    })
    let r = healthAlerts(undefined, [readout([])])
    r = healthAlerts(r.baseline, [readout([12])])
    expect(r.alerts).toEqual([])
    r = healthAlerts(r.baseline, [readout([22])])
    expect(r.alerts.map((a) => a.kind)).toEqual(['stoppedReporting'])
  })
})

describe('quiet hours', () => {
  it('crosses midnight and treats equal hours as none', () => {
    const q = { startHour: 22, endHour: 7 }
    expect(inQuietHours(q, at(23))).toBe(true)
    expect(inQuietHours(q, at(3))).toBe(true)
    expect(inQuietHours(q, at(7))).toBe(false)
    expect(inQuietHours(q, at(12))).toBe(false)
    expect(inQuietHours({ startHour: 9, endHour: 9 }, at(9))).toBe(false)
    expect(inQuietHours(null, at(23))).toBe(false)
  })

  it('holds back only Health, flow-map and metric alerts', () => {
    const q = { startHour: 22, endHour: 7 }
    expect(['health', 'flowMaps', 'metricAlert'].every((k) => quietNow(k as never, q, at(23)))).toBe(true)
    expect(['replied', 'needsAnswer', 'meeting', 'tickets', 'usage'].some((k) => quietNow(k as never, q, at(23)))).toBe(false)
  })
})

describe('flow map minimum calls', () => {
  const timing = (count: number) => ({ count, p50Ms: 100, p95Ms: 900, errorRate: 0.5, failed: Math.ceil(count / 2), hourly: [] })
  it(`breaks no limit under ${DEFAULT_FLOW_MIN_CALLS} calls by default, or under the map's own minimum`, () => {
    const limits = { p95Ms: 500, errorRate: 0.1 }
    expect(breaches(timing(DEFAULT_FLOW_MIN_CALLS - 1), limits)).toEqual([])
    expect(breaches(timing(DEFAULT_FLOW_MIN_CALLS), limits).map((b) => b.kind)).toEqual(['flowSlow', 'flowErrors'])
    expect(breaches(timing(5), { ...limits, minCalls: 5 })).toHaveLength(2)
    expect(breaches(timing(40), { ...limits, minCalls: 50 })).toEqual([])
  })

  it('is a map field passed down to every part, with notify', () => {
    const parsed = parseFlowMap({
      version: 1,
      id: 'm',
      name: 'M',
      lanes: [{ id: 'l', label: 'L' }],
      nodes: [{ id: 'a', lane: 'l', label: 'A', measure: { type: 'apm.transaction', service: 's', transaction: 't' } }],
      alerts: { p95Ms: 500, minCalls: 5, notify: false, parts: { a: { p95Ms: 100 } } }
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.map.alerts?.notify).toBe(false)
    expect(flowThresholds(parsed.map, { key: 'a' })).toEqual({ p95Ms: 100, errorRate: undefined, minCalls: 5 })
  })
})

describe('setJsonField', () => {
  const text = '{\n  "id": "m",\n  "alerts": {\n    "p95Ms": 1\n  },\n  "name": "M"\n}\n'

  it('replaces one top-level value in the file\'s indentation and keeps every other byte', () => {
    const out = setJsonField(text, 'alerts', { p95Ms: 2, parts: {} })
    expect(out).toBe('{\n  "id": "m",\n  "alerts": {\n    "p95Ms": 2,\n    "parts": {}\n  },\n  "name": "M"\n}\n')
  })

  it('adds a missing field after the last one, and removes one in any position', () => {
    expect(setJsonField('{\n  "id": "m"\n}', 'alerts', { p95Ms: 1 })).toBe('{\n  "id": "m",\n  "alerts": {\n    "p95Ms": 1\n  }\n}')
    expect(setJsonField('{"id":"m"}', 'alerts', { p95Ms: 1 })).toBe('{"id":"m", "alerts": {"p95Ms":1}}')
    expect(setJsonField(text, 'alerts', undefined)).toBe('{\n  "id": "m",\n  "name": "M"\n}\n')
    expect(setJsonField('{\n  "id": "m",\n  "alerts": 1\n}', 'alerts', undefined)).toBe('{\n  "id": "m"\n}')
  })

  it('is not fooled by braces and quotes inside strings', () => {
    const tricky = '{"name": "a } \\" {", "alerts": {"x": "}"}, "z": [1, {"alerts": 2}]}'
    const out = setJsonField(tricky, 'alerts', { p95Ms: 3 })
    expect(JSON.parse(out)).toEqual({ name: 'a } " {', alerts: { p95Ms: 3 }, z: [1, { alerts: 2 }] })
    expect(() => setJsonField('[1]', 'alerts', 1)).toThrow()
  })
})
