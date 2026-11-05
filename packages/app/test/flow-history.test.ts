import { mkdtempSync, readdirSync, utimesSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HEALTH_THRESHOLDS, emptyConfig, flowHistoryStart, hourStart, type Connection, type HealthEnvironment, type Profile, type SecretStore, type WorkhubConfig } from '@workhub/core'
import type { HttpClient } from '@workhub/adapters/http'
import type { FlowMapSummary } from '../src/shared/health-api'
import { FlowHistoryStore, flowHistoryFileName } from '../src/main/flow-history'
import { FLOW_HISTORY_REFRESH_MS, FLOW_HISTORY_RETRY_BASE_MS, FLOW_HISTORY_RETRY_MAX_MS, HEALTH_MIN_GAP_MS, HealthService } from '../src/main/health-service'
import { FlowMapList, groupFlowMaps } from '../src/renderer/screens/flowMaps/FlowMapList'

const H = 3_600_000
const tmp = () => mkdtempSync(join(tmpdir(), 'wh-flow-history-'))

const elastic: Connection = { id: 'es', kind: 'health', provider: 'elastic-apm', endpoint: 'https://es.example.test:9200', secretRef: 'connection/es', settings: {} }
const env: HealthEnvironment = { id: 'dev', name: 'Develop', apmEnvironments: ['dev'], k8sIndexSuffix: '', hasKubeState: false, apm: { errors: 'errors-*', traces: 'traces-*', metrics: 'metrics-*' }, kibanaUrl: '', thresholds: { ...DEFAULT_HEALTH_THRESHOLDS } }
const profile: Profile = { id: 'work', name: 'Work', connections: { health: 'es' }, accountIds: [], modules: { flows: false, health: true, chatWatcher: false, automations: false, flowMaps: true, planner: false }, health: { refreshMinutes: 15, environments: [env] } }

/** Two maps sharing the BFF transaction; the second also measures the hop to orders. */
const maps = [
  { version: 1, id: 'checkout', name: 'Checkout', group: 'Payments', alerts: { p95Ms: 50, minCalls: 1 }, lanes: [{ id: 'app', label: 'App' }], nodes: [{ id: 'bff', lane: 'app', label: 'shop-bff', measure: { type: 'apm.transaction', service: 'shop-bff', transaction: 'POST /checkout' } }] },
  { version: 1, id: 'orders', name: 'Orders', lanes: [{ id: 'app', label: 'App' }], nodes: [{ id: 'bff', lane: 'app', label: 'shop-bff', measure: { type: 'apm.transaction', service: 'shop-bff', transaction: 'POST /checkout' } }, { id: 'orders', lane: 'app', label: 'orders' }], edges: [{ from: 'bff', to: 'orders', measure: { type: 'apm.span', service: 'shop-bff', destination: 'orders:8080' } }] }
]

/** A cluster that answers every hourly read with two calls of 100 ms in the first hour asked, and records the ranges. */
function cluster(fail = false) {
  const ranges: { gte: number; lt: number }[] = []
  const http: HttpClient = async (req) => {
    const body = JSON.parse(req.body ?? '{}') as { query: { bool: { filter: { range?: { '@timestamp': { gte: number; lt: number } } }[] } } }
    const range = body.query.bool.filter[0]!.range!['@timestamp']
    ranges.push(range)
    if (fail) return { status: 500, text: '{"error":"boom"}' }
    const bucket = { key: hourStart(range.gte), doc_count: 2, failed: { doc_count: 0 }, latency: { buckets: Array.from({ length: 30 }, (_, i) => ({ doc_count: i === 27 ? 2 : 0 })) } }
    return { status: 200, text: JSON.stringify({ aggregations: { hours: { buckets: [bucket] } } }) }
  }
  return { http, ranges }
}

function setup(opts: { http: HttpClient; now: () => number }) {
  const dir = tmp()
  const flowMapsDir = join(dir, 'flow-maps')
  mkdirSync(flowMapsDir)
  for (const m of maps) writeFileSync(join(flowMapsDir, `${m.id}.json`), JSON.stringify(m))
  const config: WorkhubConfig = { ...emptyConfig(), connections: [elastic], profiles: [profile], activeProfileId: 'work' }
  const secrets: SecretStore = { get: async () => 'key', set: async () => {}, delete: async () => {}, has: async () => true }
  const flowHistory = new FlowHistoryStore(join(dir, 'flow-history'), opts.now, 0)
  const service = new HealthService({ configuration: { current: async () => config } as never, secrets, demo: false, httpFor: () => opts.http, now: opts.now, flowMapsDir, flowHistory })
  return { service, flowHistory, dir }
}

describe('HealthService with the flow history', () => {
  const start = Date.UTC(2026, 0, 15, 12, 30)

  it('backfills a week once, then reads only the hours not final yet', async () => {
    const { http, ranges } = cluster()
    let now = start
    const { service } = setup({ http, now: () => now })
    const first = await service.flowMap('work', 'dev', 'checkout', 24)
    expect(first.ok && first.reading?.nodes.bff?.count).toBe(0) // the calls are a week back, out of the window
    expect(ranges).toEqual([{ gte: flowHistoryStart(start), lt: start, format: 'epoch_millis' }])

    now = start + FLOW_HISTORY_REFRESH_MS + 1
    const second = await service.flowMap('work', 'dev', 'checkout', 24)
    expect(ranges).toHaveLength(2)
    expect(ranges[1]!.gte).toBe(hourStart(start)) // the open hour only
    expect(second.ok && second.reading?.nodes.bff?.count).toBe(2)
    expect(second.ok && second.reading?.nodes.bff?.weekly?.count).toBe(4)
  })

  it('shares a measure between maps and does not read it again before the refresh time', async () => {
    const { http, ranges } = cluster()
    const now = start
    const { service } = setup({ http, now: () => now })
    await Promise.all([service.flowMap('work', 'dev', 'checkout', 24), service.flowMap('work', 'dev', 'orders', 24)])
    expect(ranges).toHaveLength(2) // the BFF transaction once, the span once
    await service.flowMap('work', 'dev', 'orders', 24)
    expect(ranges).toHaveLength(2)
  })

  it('reads again sooner when forced, never within the minimum gap', async () => {
    const { http, ranges } = cluster()
    let now = start
    const { service } = setup({ http, now: () => now })
    await service.flowMap('work', 'dev', 'checkout', 24)
    await service.flowMap('work', 'dev', 'checkout', 24, true)
    expect(ranges).toHaveLength(1)
    now += HEALTH_MIN_GAP_MS
    await service.flowMap('work', 'dev', 'checkout', 24, true)
    expect(ranges).toHaveLength(2)
  })

  it('answers from disk without reading when asked for what is stored', async () => {
    const { http, ranges } = cluster()
    const now = start
    const { service } = setup({ http, now: () => now })
    const empty = await service.flowMap('work', 'dev', 'checkout', 24, false, true)
    expect(empty).toMatchObject({ ok: true })
    expect(empty.ok && empty.reading).toBeUndefined()
    expect(ranges).toHaveLength(0)
    await service.flowMap('work', 'dev', 'checkout', 24)
    const stored = await service.flowMap('work', 'dev', 'checkout', 24, false, true)
    expect(stored.ok && stored.reading?.nodes.bff).toBeDefined()
    expect(ranges).toHaveLength(1)
  })

  it('reports a failed read per part when nothing is stored', async () => {
    const { http } = cluster(true)
    const now = start
    const { service } = setup({ http, now: () => now })
    const result = await service.flowMap('work', 'dev', 'checkout', 24)
    expect(result.ok && result.reading?.errors.bff).toBeTruthy()
  })

  it('backs off a measure whose read failed instead of asking again on every ask', async () => {
    let fail = true
    const ok = cluster()
    const bad = cluster(true)
    const http: HttpClient = (req) => (fail ? bad.http(req) : ok.http(req))
    let now = start
    const { service } = setup({ http, now: () => now })
    const first = await service.flowMap('work', 'dev', 'checkout', 24)
    expect(first.ok && first.reading?.errors.bff).toBeTruthy()
    // Asked again at once: the error stands, nothing is read.
    const again = await service.flowMap('work', 'dev', 'checkout', 24)
    expect(again.ok && again.reading?.errors.bff).toBeTruthy()
    expect(bad.ranges).toHaveLength(1)
    // The wait doubles per failure in a row: base, then twice the base.
    now += FLOW_HISTORY_RETRY_BASE_MS
    await service.flowMap('work', 'dev', 'checkout', 24)
    expect(bad.ranges).toHaveLength(2)
    now += FLOW_HISTORY_RETRY_BASE_MS
    await service.flowMap('work', 'dev', 'checkout', 24)
    expect(bad.ranges).toHaveLength(2)
    now += FLOW_HISTORY_RETRY_BASE_MS
    await service.flowMap('work', 'dev', 'checkout', 24)
    expect(bad.ranges).toHaveLength(3)
    // The refresh button waits only the minimum gap.
    now += HEALTH_MIN_GAP_MS
    await service.flowMap('work', 'dev', 'checkout', 24, true)
    expect(bad.ranges).toHaveLength(4)
    // Never more than the cap; a success clears the streak.
    fail = false
    now += FLOW_HISTORY_RETRY_MAX_MS
    const healed = await service.flowMap('work', 'dev', 'checkout', 24)
    expect(ok.ranges).toHaveLength(1)
    expect(healed.ok && healed.reading?.errors.bff).toBeUndefined()
  })

  it('tells the map states from what is stored only', async () => {
    const { http, ranges } = cluster()
    let now = start
    const { service } = setup({ http, now: () => now })
    expect(await service.flowMapStates('work', 'dev')).toEqual({ checkout: 'unknown', orders: 'unknown' })
    expect(ranges).toHaveLength(0)
    await service.flowMap('work', 'dev', 'checkout', 24)
    now = start + FLOW_HISTORY_REFRESH_MS + 1
    await service.flowMap('work', 'dev', 'checkout', 24) // two calls in the open hour, p95 well over 50 ms
    expect(await service.flowMapStates('work', 'dev')).toEqual({ checkout: 'alert', orders: 'unknown' })
  })
})

describe('FlowHistoryStore', () => {
  it('writes one file per scope, named by a hash', () => {
    const dir = tmp()
    const store = new FlowHistoryStore(dir, () => Date.UTC(2026, 0, 15), 0)
    store.set('work|key|dev', 'tx|a|b', { hours: [], settledUntil: 0, fetchedAt: Date.UTC(2026, 0, 15) })
    store.flush()
    expect(readdirSync(dir)).toEqual([flowHistoryFileName('work|key|dev')])
    expect(new FlowHistoryStore(dir).get('work|key|dev', 'tx|a|b')).toMatchObject({ fetchedAt: Date.UTC(2026, 0, 15) })
  })

  it('drops measures nobody read for a week and deletes files not written for a week', () => {
    const dir = tmp()
    const now = Date.UTC(2026, 0, 15)
    const store = new FlowHistoryStore(dir, () => now, 0)
    store.set('s', 'old', { hours: [], settledUntil: 0, fetchedAt: now - 8 * 24 * H })
    store.set('s', 'new', { hours: [{ at: now - 8 * 24 * H, count: 1, failed: 0, latency: [] }], settledUntil: 0, fetchedAt: now })
    expect(store.get('s', 'old')).toBeUndefined()
    expect(store.get('s', 'new')?.hours).toEqual([])
    store.flush()
    const file = join(dir, flowHistoryFileName('s'))
    const old = (now - 8 * 24 * H) / 1000
    utimesSync(file, old, old)
    expect(store.prune()).toBe(1)
    expect(existsSync(file)).toBe(false)
  })
})

describe('the map list', () => {
  const summary = (id: string, name: string, group?: string, extra: Partial<FlowMapSummary> = {}): FlowMapSummary => ({ id, name, file: `${id}.json`, nodes: 1, edges: 0, ...(group ? { group } : {}), ...extra })
  const listed = [summary('qr', 'QR payment', 'Payments'), summary('loan', 'Loan', 'Lending'), summary('report', 'Daily report'), summary('card', 'Card payment', 'Payments', { description: 'Pago con tarjeta' })]

  it('groups by heading, headings and maps by name, maps without one last', () => {
    expect(groupFlowMaps(listed).map((g) => [g.name, g.maps.map((m) => m.id)])).toEqual([['Lending', ['loan']], ['Payments', ['card', 'qr']], [null, ['report']]])
  })

  it('searches name, heading and description, ignoring accents and case', () => {
    expect(groupFlowMaps(listed, 'payments qr').flatMap((g) => g.maps.map((m) => m.id))).toEqual(['qr'])
    expect(groupFlowMaps(listed, 'págo').flatMap((g) => g.maps.map((m) => m.id))).toEqual(['card'])
    expect(groupFlowMaps(listed, 'nothing')).toEqual([])
  })

  it('draws the headings, the opened map and a state per map', () => {
    const html = renderToStaticMarkup(createElement(FlowMapList, { maps: listed, states: { qr: 'alert', card: 'ok' }, opened: 'card', query: '', onQuery: () => {}, onOpen: () => {} }))
    expect(html).toContain('Payments')
    expect(html).toContain('Other')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('over its limits in the last hour')
    expect(html).toContain('bg-danger')
  })
})
