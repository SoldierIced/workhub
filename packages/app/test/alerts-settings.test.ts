import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appOptions, DEFAULT_HEALTH_THRESHOLDS, parseFlowMap, quietNow, type FlowMap, type FlowMapReading, type Profile } from '@workhub/core'

vi.mock('electron', () => ({ Menu: {}, nativeImage: {}, Tray: class {} }))

import { TooltipProvider } from '../src/renderer/components/atoms'
import { Notifier, type NotificationLike } from '../src/main/notifier'
import { HealthWatcher } from '../src/main/watchers'
import { saveFlowMap, setFlowMapAlerts } from '../src/main/flow-maps'
import { HealthKindsGroup, QuietHoursGroup } from '../src/renderer/screens/AlertsSettings'
import { FlowMapLimitsTable } from '../src/renderer/screens/alerts/FlowLimits'
import { flowLimitsToForm, formToFlowAlerts, mapNow, saveFlowLimits } from '../src/renderer/screens/alerts/alertsForm'
import type { HealthView } from '../src/shared/health-api'

class FakeNotification implements NotificationLike {
  static made: FakeNotification[] = []
  handlers: Record<string, () => void> = {}
  shown = false
  constructor(public content: { title: string; body: string }) {
    FakeNotification.made.push(this)
  }
  on(event: 'click' | 'close', listener: () => void) {
    this.handlers[event] = listener
    return this
  }
  show() {
    this.shown = true
  }
}

// 2026-11-05 23:30 local time: inside 22–7 quiet hours; 12:00 is outside.
const NIGHT = new Date(2026, 10, 5, 23, 30).getTime()
const NOON = new Date(2026, 10, 5, 12, 0).getTime()

describe('notifier quiet hours and channels', () => {
  const make = (now: number) => {
    const asked: (string | undefined)[] = []
    const n = new Notifier({
      options: async () => appOptions({ options: undefined }),
      supported: () => true,
      create: (c) => new FakeNotification(c),
      now: () => now,
      quiet: async (kind, profileId, at) => {
        asked.push(profileId)
        return quietNow(kind, { startHour: 22, endHour: 7 }, at)
      }
    })
    return { n, asked }
  }

  it('holds back Health, flow-map and metric alerts inside quiet hours, never sessions or meetings', async () => {
    FakeNotification.made = []
    const { n, asked } = make(NIGHT)
    expect(await n.show('health', { title: 'h' }, () => {})).toBe(false)
    expect(await n.show('flowMaps', { title: 'f' }, () => {})).toBe(false)
    expect(await n.show('metricAlert', { title: 'm' }, () => {}, { profileId: 'work' })).toBe(false)
    expect(await n.show('replied', { title: 'r' }, () => {})).toBe(true)
    expect(await n.show('meeting', { title: 'c' }, () => {})).toBe(true)
    expect(FakeNotification.made.map((f) => f.content.title)).toEqual(['r', 'c'])
    expect(asked).toContain('work')
    expect(await make(NOON).n.show('health', { title: 'h' }, () => {})).toBe(true)
  })

  it('lists a tray-only alert without an OS notification, and the reverse', async () => {
    FakeNotification.made = []
    const { n } = make(NOON)
    expect(await n.show('health', { title: 'tray only' }, () => {}, {}, undefined, ['tray'])).toBe(true)
    expect(FakeNotification.made).toHaveLength(0)
    expect(n.recent().map((r) => r.title)).toEqual(['tray only'])
    expect(await n.show('health', { title: 'popup only' }, () => {}, {}, undefined, ['notification'])).toBe(true)
    expect(FakeNotification.made).toHaveLength(1)
    expect(n.recent().map((r) => r.title)).toEqual(['tray only'])
    expect(await n.show('health', { title: 'nowhere' }, () => {}, {}, undefined, [])).toBe(false)
  })
})

describe('health watcher per-kind settings', () => {
  const silent = (service: string, silentMinutes = 30) => ({ service, lastSeen: 0, silentMinutes, isReporting: false })
  const at = (state: 'healthy' | 'degraded', services: { service: string; minutes?: number }[]): HealthView => ({
    state: 'ready',
    refreshMinutes: 5,
    environments: [
      {
        id: 'prod',
        name: 'PROD',
        snapshot: { environmentId: 'prod', state, blindSpots: [], silentServices: services.map((s) => silent(s.service, s.minutes)), pods: [], errorServices: [], podVisibility: 'visible' } as never,
        kibanaUrl: null,
        serviceUrls: {},
        errorUrls: {},
        podUrls: {},
        slowFlowHours: 1,
        errorWindowHours: 1,
        thresholds: DEFAULT_HEALTH_THRESHOLDS,
        hasKubeState: true,
        k8sIndexSuffix: ''
      } as never
    ]
  })

  it('skips a kind that is off, passes the channels and honours the silent-minutes threshold', async () => {
    let current = at('healthy', [])
    const alerts: string[] = []
    const w = new HealthWatcher({
      activeProfileId: async () => 'p',
      read: async () => current,
      alert: (a, channels) => alerts.push(`${a.kind}:${a.subject}:${channels.join('+')}`),
      changed: () => {},
      alertSettings: async () => ({ degraded: { notify: false }, stoppedReporting: { notify: true, threshold: 20, channels: ['tray'] } })
    })
    await w.tick()
    // Degraded is off; "api" has been silent 12 minutes, under the 20-minute threshold.
    current = at('degraded', [{ service: 'api', minutes: 12 }])
    await w.tick()
    expect(alerts).toEqual([])
    current = at('degraded', [{ service: 'api', minutes: 25 }])
    await w.tick()
    expect(alerts).toEqual(['stoppedReporting:api:tray'])
    // Recovery stays on with every channel.
    current = at('healthy', [{ service: 'api', minutes: 25 }])
    await w.tick()
    expect(alerts).toEqual(['stoppedReporting:api:tray', 'recovered::notification+tray'])
  })
})

const exampleMap = (): FlowMap => (parseFlowMap(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'examples', 'flow-maps', 'checkout.json'), 'utf8'))) as { ok: true; map: FlowMap }).map

describe('flow map files: setAlerts and the control endpoint', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'wh-alerts-'))
    dirs.push(d)
    return d
  }
  const raw = {
    version: 1,
    id: 'orders',
    name: 'Orders',
    lanes: [{ id: 'app', label: 'App' }],
    nodes: [{ id: 'bff', lane: 'app', label: 'shop-bff', measure: { type: 'apm.transaction', service: 'shop-bff', transaction: 'POST /orders' } }],
    alerts: { p95Ms: 900 }
  }

  it('writes only the alerts field and keeps the rest of the file byte for byte', () => {
    const dir = tmp()
    // Four-space indent, a key order of its own: nothing Workhub would write.
    const text = `{\n    "name": "Orders",\n    "version": 1,\n    "id": "orders",\n    "lanes": [ { "id": "app", "label": "App" } ],\n    "alerts": { "p95Ms": 900 },\n    "nodes": [{"id":"bff","lane":"app","label":"shop-bff","measure":{"type":"apm.transaction","service":"shop-bff","transaction":"POST /orders"}}]\n}\n`
    writeFileSync(join(dir, 'orders.json'), text)
    const r = setFlowMapAlerts(dir, 'orders', { p95Ms: 1200, errorRate: 0.05, minCalls: 30, parts: { bff: { p95Ms: 800 } } })
    expect(r.ok).toBe(true)
    const after = readFileSync(join(dir, 'orders.json'), 'utf8')
    const [before0, before1] = text.split('"alerts": { "p95Ms": 900 }')
    expect(after.startsWith(before0!)).toBe(true)
    expect(after.endsWith(before1!)).toBe(true)
    expect(JSON.parse(after).alerts).toEqual({ p95Ms: 1200, errorRate: 0.05, minCalls: 30, parts: { bff: { p95Ms: 800 } } })
  })

  it('refuses limits on a part that does not exist and removes the field for null', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'orders.json'), JSON.stringify(raw, null, 2))
    const bad = setFlowMapAlerts(dir, 'orders', { parts: { nope: { p95Ms: 1 } } })
    expect(bad).toEqual({ ok: false, errors: ['alerts.parts: unknown part "nope"'] })
    expect(JSON.parse(readFileSync(join(dir, 'orders.json'), 'utf8')).alerts).toEqual({ p95Ms: 900 })
    expect(setFlowMapAlerts(dir, 'orders', null).ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'orders.json'), 'utf8'))).not.toHaveProperty('alerts')
    expect(setFlowMapAlerts(dir, 'missing', null).ok).toBe(false)
  })

  it('keeps the stored limits when a posted map has none (control endpoint), not on import', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'orders.json'), JSON.stringify(raw, null, 2))
    const { alerts: _none, ...posted } = raw
    expect(saveFlowMap(dir, { ...posted, name: 'Orders v2' }, { keepAlerts: true }).ok).toBe(true)
    const kept = JSON.parse(readFileSync(join(dir, 'orders.json'), 'utf8'))
    expect(kept).toMatchObject({ name: 'Orders v2', alerts: { p95Ms: 900 } })
    // A posted map with its own alerts wins; a plain save replaces.
    saveFlowMap(dir, { ...posted, alerts: { p95Ms: 100 } }, { keepAlerts: true })
    expect(JSON.parse(readFileSync(join(dir, 'orders.json'), 'utf8')).alerts).toMatchObject({ p95Ms: 100 })
    saveFlowMap(dir, posted)
    expect(JSON.parse(readFileSync(join(dir, 'orders.json'), 'utf8'))).not.toHaveProperty('alerts')
  })
})

describe('Settings → Alerts renderer', () => {
  const profile = (over: Partial<Profile> = {}): Profile => ({
    id: 'work',
    name: 'Work',
    connections: {},
    accountIds: [],
    modules: { flows: false, health: true, chatWatcher: false, automations: false, flowMaps: true, planner: false },
    health: { refreshMinutes: 15, environments: [], alerts: { podDown: { notify: false } } },
    ...over
  })

  it('renders one row per Health alert kind from the snapshot, with "—" where no threshold exists', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(HealthKindsGroup, { profile: profile(), editable: true, save: () => {} })))
    for (const kind of ['stoppedReporting', 'podDown', 'errorsWorsening', 'degraded', 'unreachable', 'recovered']) expect(html).toContain(`id="alerts.health.${kind}"`)
    expect(html).toContain('A pod is down or crash-looping')
    expect((html.match(/—/g) ?? []).length).toBe(4)
    expect(html).toContain('min silent')
  })

  it('shows the quiet hours of the profile', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(QuietHoursGroup, { profile: profile({ alerts: { quietHours: { startHour: 22, endHour: 7 } } }), editable: true, save: () => {} })))
    expect(html).toContain('From 22:00 to 07:00, local time.')
  })

  it('renders a map limits table with a stable row id, its parts and the tone of now', () => {
    const map = { ...exampleMap(), alerts: { p95Ms: 1000, parts: { bff: { errorRate: 0.01 } } } } as FlowMap
    const hourly = [{ at: 0, count: 100, p50Ms: 100, p95Ms: 300 }]
    const reading: FlowMapReading = { at: 1, windowHours: 1, nodes: { bff: { count: 100, p50Ms: 400, p95Ms: 2400, errorRate: 0.03, failed: 3, hourly } }, edges: {}, stages: {}, errors: {} }
    const html = renderToStaticMarkup(createElement(FlowMapLimitsTable, { entry: { map, environmentName: 'Staging', reading }, form: flowLimitsToForm(map.alerts), editable: true, dirty: false, onChange: () => {}, onSave: () => {} }))
    expect(html).toContain(`id="alerts.flow.${map.id}"`)
    expect(html).toContain('Staging')
    expect(html).toContain('data-part="bff"')
    expect(html).toContain('over p95')
    expect(html).toContain('over failures')
    expect(mapNow(map, reading).tone).toEqual({ kind: 'over', over: ['flowSlow', 'flowErrors'] })
  })

  it('saving a limit calls flowMaps.setAlerts with the alerts shape', async () => {
    const setAlerts = vi.fn(async () => ({ ok: true as const, file: 'f', id: 'checkout' }))
    const form = { ...flowLimitsToForm(undefined), p95Ms: '1500', errorPct: '2.5', minCalls: '10', parts: [{ key: 'bff', p95Ms: '', errorPct: '1' }, { key: 'orders', p95Ms: '', errorPct: '' }] }
    await saveFlowLimits({ setAlerts }, 'work', 'checkout', form)
    expect(setAlerts).toHaveBeenCalledWith('work', 'checkout', { p95Ms: 1500, errorRate: 0.025, minCalls: 10, parts: { bff: { errorRate: 0.01 } } })
    // Nothing set removes the field; a bad number writes nothing.
    await saveFlowLimits({ setAlerts }, 'work', 'checkout', flowLimitsToForm(undefined))
    expect(setAlerts).toHaveBeenLastCalledWith('work', 'checkout', null)
    expect(await saveFlowLimits({ setAlerts }, 'work', 'checkout', { ...form, errorPct: '140' })).toEqual({ ok: false, field: 'errorPct' })
    expect(setAlerts).toHaveBeenCalledTimes(2)
    expect(formToFlowAlerts({ ...flowLimitsToForm(undefined), notify: false })).toEqual({ ok: true, alerts: { notify: false, parts: {} } })
  })
})
