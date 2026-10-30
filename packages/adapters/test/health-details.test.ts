import { describe, expect, it } from 'vitest'
import { DEFAULT_HEALTH_THRESHOLDS, HealthConnectionError, refreshEnvironment, windowVerdict, type HealthEnvironment } from '@workhub/core'
import { DemoHealthProvider, DEMO_HEALTH_SETTINGS, ElasticClient, ElasticHealthProvider, elasticQueries as q, kibanaDiscoverUrl, kibanaErrorGroupUrl, kibanaServiceErrorsUrl } from '../src/health-elastic'
import type { HttpClient } from '../src/shared/http'

const env = (over: Partial<HealthEnvironment> = {}): HealthEnvironment => ({
  id: 'dev',
  name: 'Develop',
  apmEnvironments: ['dev'],
  k8sIndexSuffix: 'dev',
  hasKubeState: true,
  apm: { errors: 'errors-*', traces: 'traces-*', metrics: 'metrics-*' },
  kibanaUrl: 'https://kibana.example.test/',
  thresholds: { ...DEFAULT_HEALTH_THRESHOLDS },
  ...over
})

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const json = (v: unknown) => JSON.stringify(v)

function cluster(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const seen: { path: string; body: Record<string, unknown> }[] = []
  const http: HttpClient = async (req) => {
    const path = new URL(req.url).pathname.slice(1)
    const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>
    seen.push({ path, body })
    const handler = handlers[path]
    if (!handler) return { status: 404, text: json({ error: { reason: `no such index ${path}` } }) }
    const out = handler(body)
    if (out instanceof Error) throw out
    return { status: 200, text: json(out) }
  }
  return { provider: new ElasticHealthProvider({ client: new ElasticClient({ baseUrl: 'https://es.example.test', auth: { mode: 'apiKey', secret: 'k' }, http }) }), seen }
}

describe('detail queries', () => {
  it('ranks a service error groups by the rolling window and filters by service and environment', () => {
    const r = q.errorGroups(env(), 'checkout')
    const body = json(r.body)
    expect(r.index).toBe('errors-*')
    expect(body).toContain('"field":"error.grouping_key"')
    expect(body).toContain('"order":{"recent":"desc"}')
    expect(body).toContain('{"term":{"service.name":"checkout"}}')
    expect(body).toContain('"transaction.name"')
  })

  it('parses error groups, newest-in-window as new, most errors first', () => {
    const bucket = (key: string, recent: number, firstSeen: number, daily: number[]) => ({
      key,
      doc_count: daily.reduce((a, b) => a + b, 0),
      daily: { buckets: daily.map((doc_count) => ({ doc_count })) },
      recent: { doc_count: recent, endpoint: { buckets: [{ key: 'POST /orders' }] } },
      first_seen: { value: firstSeen },
      last_seen: { value: NOW - 60_000 },
      sample: { hits: { hits: [{ fields: { 'error.exception.type': ['System.NullReferenceException'], 'error.exception.message': ['boom\n  at line'], 'error.culprit': ['Handler'] } }] } }
    })
    const groups = q.parseErrorGroups(
      { aggregations: { by_key: { buckets: [bucket('old', 10, NOW - 5 * 24 * HOUR, [4, 0, 6, 8, 10]), bucket('fresh', 50, NOW - 2 * HOUR, [0, 0, 0, 0, 50]), bucket('quiet', 0, NOW - 9 * 24 * HOUR, [1, 0, 0, 0, 0])] } } },
      NOW,
      24
    )
    expect(groups.map((g) => g.groupingKey)).toEqual(['fresh', 'old'])
    expect(groups[0]).toMatchObject({ isNew: true, endpoint: 'POST /orders', message: 'boom at line', culprit: 'Handler', exceptionType: 'System.NullReferenceException' })
    expect(groups[1]).toMatchObject({ isNew: false, activeDays: 4, daysWithData: 5, typicalDay: 6 })
  })

  it('parses a pod status, its events (newest first) and its stderr (oldest first)', () => {
    const status = q.parsePodStatus({
      aggregations: {
        by_pod_status: {
          buckets: [
            {
              key: 'api-7f9c5d-xk2lp',
              waiting: { reason: { buckets: [{ key: 'CrashLoopBackOff' }] } },
              latest: { hits: { hits: [{ fields: { 'kubernetes.container.name': ['api'], 'kubernetes.container.status.last_terminated_reason': ['OOMKilled'], 'kubernetes.container.status.last_terminated_exitcode': [137], 'kubernetes.container.status.last_terminated_timestamp': [1.79e9] } }] } }
            }
          ]
        }
      }
    })
    expect(status['api-7f9c5d-xk2lp']).toMatchObject({ container: 'api', waitingReason: 'CrashLoopBackOff', lastTerminatedReason: 'OOMKilled', lastExitCode: 137, lastTerminatedAt: 1.79e12 })
    const events = q.parsePodEvents({
      aggregations: {
        by_reason: {
          buckets: [
            { key: 'Unhealthy', doc_count: 3, last_seen: { value: NOW - HOUR }, latest: { hits: { hits: [{ fields: { 'kubernetes.event.message': ['probe failed'] } }] } } },
            { key: 'BackOff', doc_count: 9, last_seen: { value: NOW - 60_000 }, latest: { hits: { hits: [{ fields: { 'kubernetes.event.count': [41] } }] } } }
          ]
        }
      }
    })
    expect(events.map((e) => e.reason)).toEqual(['BackOff', 'Unhealthy'])
    expect(events[0]?.occurrences).toBe(41)
    const lines = q.parsePodStderr({ hits: { hits: [{ fields: { message: ['second'], '@timestamp': ['2'] } }, { fields: { message: ['first'], '@timestamp': ['1'] } }, { fields: {} }] } })
    expect(lines.map((l) => l.text)).toEqual(['first', 'second'])
    expect(json(q.podStderr(env(), 'p', 24).body)).toContain('"stream":"stderr"')
    expect(q.podStderr(env(), 'p', 24).index).toBe('logs-kubernetes.container-dev')
  })

  it('breaks the slowest executions of a flow down by resource', () => {
    const sample = q.parseExecutions({ hits: { hits: [{ fields: { 'transaction.id': ['a'], 'transaction.duration.us': [3_000_000] } }, { fields: { 'transaction.id': ['b'], 'transaction.duration.us': [1_000_000] } }] } })
    expect(sample).toEqual({ ids: ['a', 'b'], wallMs: 4000 })
    expect(json(q.spanBreakdown(env(), sample).body)).toContain('{"terms":{"transaction.id":["a","b"]}}')
    const spans = q.parseSpanBreakdown(
      {
        aggregations: {
          by_resource: {
            buckets: [
              { key: ['n/a', 'app', 'n/a'], doc_count: 2, total: { value: 200_000 } },
              { key: ['postgresql', 'db', 'postgresql'], doc_count: 40, total: { value: 3_000_000 } }
            ]
          }
        }
      },
      sample
    )
    expect(spans[0]).toEqual({ resource: 'postgresql', type: 'db', subtype: 'postgresql', calls: 40, totalMs: 3000, averageMs: 75, callsPerTransaction: 20, shareOfWallTime: 0.75 })
    expect(spans[1]).toMatchObject({ resource: 'app', subtype: undefined })
  })

  it('compares the current window with the one before it', () => {
    const w = q.comparisonWindows(NOW, 24)
    expect(w.current).toEqual([NOW - 24 * HOUR, NOW])
    expect(w.previous).toEqual([NOW - 48 * HOUR, NOW - 24 * HOUR])
    const tx = json(q.windowTransactions(env(), 'checkout', 'POST /orders', NOW, 24).body)
    expect(tx).toContain('"transaction.name":"POST /orders"')
    expect(tx).toContain(`"gte":${NOW - 24 * HOUR}`)
    const comparison = q.parseWindowComparison(
      { aggregations: { windows: { buckets: { previous: { doc_count: 4 }, current: { doc_count: 40 } } } } },
      { aggregations: { windows: { buckets: { previous: { doc_count: 100, failed: { doc_count: 1 }, latency: { values: { '95.0': 500_000 } } }, current: { doc_count: 100, failed: { doc_count: 9 }, latency: { values: { '95.0': 1_200_000 } } } } } } },
      { aggregations: { by_group: { buckets: [{ key: 'g-new', doc_count: 7, first_seen: { value: NOW - HOUR } }, { key: 'g-old', doc_count: 70, first_seen: { value: NOW - 30 * HOUR } }] } } },
      'checkout',
      'POST /orders',
      NOW,
      24
    )
    expect(comparison.previous).toEqual({ errors: 4, transactions: 100, failedTransactions: 1, p95Ms: 500 })
    expect(comparison.newErrorTypes.map((n) => n.groupingKey)).toEqual(['g-new'])
    const verdict = windowVerdict(comparison)
    expect(verdict.kind === 'regressed' && verdict.reasons.map((r) => r.code)).toEqual(['errors', 'failureRate', 'latency', 'newErrorTypes'])
  })

  it('reads container stderr per container with its namespace', () => {
    expect(q.containerStderr(env()).index).toBe('logs-kubernetes.container-dev')
    const trends = q.parseTrends({ aggregations: { by_key: { buckets: [{ key: 'api', doc_count: 9, daily: { buckets: [{ doc_count: 1 }, { doc_count: 8 }] }, recent: { doc_count: 8 }, namespace: { buckets: [{ key: 'shop' }] } }] } } })
    expect(trends[0]).toMatchObject({ key: 'api', namespace: 'shop' })
  })
})

describe('ElasticHealthProvider details', () => {
  it('reads container stderr instead of nothing when pod metrics are missing', async () => {
    const { provider, seen } = cluster({
      'metrics-kubernetes.state_pod-dev/_count': () => ({ count: 0 }),
      'metrics-kubernetes.event-dev/_search': () => ({ aggregations: { by_key: { buckets: [] } } }),
      'logs-kubernetes.container-dev/_search': () => ({ aggregations: { by_key: { buckets: [{ key: 'api', daily: { buckets: [{ doc_count: 3 }] }, recent: { doc_count: 3 } }] } } }),
      'metrics-*/_search': () => ({ aggregations: { by_service: { buckets: [] } } }),
      'errors-*/_search': () => ({ aggregations: { by_key: { buckets: [] } } }),
      'traces-*/_search': () => ({ aggregations: { by_transaction: { buckets: [] } } })
    })
    const reading = await refreshEnvironment(provider, env(), undefined, NOW)
    expect(reading.snapshot.containerStderr.map((s) => s.key)).toEqual(['api'])
    expect(seen.map((s) => s.path)).toContain('logs-kubernetes.container-dev/_search')
  })

  it('reads a pod detail part by part: a failed part says why and the others still show', async () => {
    const { provider } = cluster({
      'metrics-kubernetes.state_container-dev/_search': () => ({ aggregations: { by_pod_status: { buckets: [{ key: 'p', waiting: { reason: { buckets: [{ key: 'CrashLoopBackOff' }] } } }] } } }),
      'metrics-kubernetes.event-dev/_search': () => ({ aggregations: { by_reason: { buckets: [{ key: 'BackOff', doc_count: 2 }] } } })
      // the container logs index is missing: 404
    })
    const details = await provider.podDetails(env(), 'p', NOW)
    expect(details.status?.waitingReason).toBe('CrashLoopBackOff')
    expect(details.events.map((e) => e.reason)).toEqual(['BackOff'])
    expect(details.stderr).toEqual([])
    expect(details.stderrError).toContain('no such index')
  })

  it('throws a connection failure of a detail instead of showing it as a part', async () => {
    const { provider } = cluster({ 'errors-*/_search': () => new Error('getaddrinfo ENOTFOUND') })
    await expect(provider.errorDetails(env(), 'api', NOW)).rejects.toBeInstanceOf(HealthConnectionError)
    const flaky = cluster({ 'metrics-kubernetes.event-dev/_search': () => new Error('getaddrinfo ENOTFOUND') })
    await expect(flaky.provider.podDetails(env(), 'p', NOW)).rejects.toBeInstanceOf(HealthConnectionError)
  })

  it('reads a flow: its slowest executions, their spans and the window comparison', async () => {
    const { provider, seen } = cluster({
      'traces-*/_search': (body) => {
        const text = json(body)
        if (text.includes('"processor.event":"span"')) return { aggregations: { by_resource: { buckets: [{ key: ['postgresql', 'db', 'postgresql'], doc_count: 10, total: { value: 1_000_000 } }] } } }
        if (text.includes('"windows"')) return { aggregations: { windows: { buckets: { previous: { doc_count: 10 }, current: { doc_count: 12 } } } } }
        return { hits: { hits: [{ fields: { 'transaction.id': ['t1'], 'transaction.duration.us': [2_000_000] } }] } }
      },
      'errors-*/_search': (body) => (json(body).includes('"windows"') ? { aggregations: { windows: { buckets: { previous: { doc_count: 1 }, current: { doc_count: 1 } } } } } : { aggregations: { by_group: { buckets: [] } } })
    })
    const flow = await provider.flowDetails(env(), 'api', 'GET /x', NOW)
    expect(flow.sampledTransactions).toBe(1)
    expect(flow.spans[0]).toMatchObject({ resource: 'postgresql', shareOfWallTime: 0.5 })
    expect(flow.comparison?.current.transactions).toBe(12)
    expect(windowVerdict(flow.comparison!).kind).toBe('clean')
    expect(seen.every((s) => s.path.endsWith('/_search'))).toBe(true)
  })
})

describe('Kibana detail links', () => {
  it('links a service errors page, one error group and a pod in Discover', () => {
    expect(kibanaServiceErrorsUrl(env(), 'api')).toBe('https://kibana.example.test/app/apm/services/api/errors?rangeFrom=now-24h&rangeTo=now&environment=dev')
    expect(new URL(kibanaErrorGroupUrl(env(), 'api', 'g 1')!).pathname).toBe('/app/apm/services/api/errors/g%201')
    const discover = kibanaDiscoverUrl(env(), 'kubernetes.pod.name', "api-7f9c5d-xk2lp", 6)!
    expect(discover.startsWith('https://kibana.example.test/app/discover#/')).toBe(true)
    expect(decodeURIComponent(discover)).toContain('kubernetes.pod.name:"api-7f9c5d-xk2lp"')
    expect(discover).toContain('from:now-6h')
    expect(kibanaDiscoverUrl(env({ kibanaUrl: '' }), 'a', 'b')).toBeNull()
    expect(kibanaServiceErrorsUrl(env({ kibanaUrl: '' }), 'a')).toBeNull()
  })
})

describe('demo provider details', () => {
  it('serves error groups, pod details, flow details and container stderr without a cluster', async () => {
    const provider = new DemoHealthProvider()
    const [production, staging] = DEMO_HEALTH_SETTINGS.environments
    expect((await provider.errorDetails(production!, 'checkout-api', NOW)).groups.length).toBeGreaterThan(0)
    expect((await provider.podDetails(production!, 'notifier-worker-7d9f6b5c4-x2k8p', NOW)).status?.waitingReason).toBe('CrashLoopBackOff')
    const flow = await provider.flowDetails(production!, 'checkout-api', 'POST /orders', NOW)
    expect(windowVerdict(flow.comparison!).kind).toBe('regressed')
    const reading = await refreshEnvironment(provider, staging!, undefined, NOW)
    expect(reading.snapshot.containerStderr.length).toBeGreaterThan(0)
  })
})

describe('flow maps', () => {
  const map = {
    version: 1 as const,
    id: 'checkout',
    name: 'Checkout',
    phases: [],
    lanes: [{ id: 'app', label: 'App', kind: 'normal' as const }],
    nodes: [{ id: 'bff', lane: 'app', label: 'shop-bff', kind: 'app' as const, measure: { type: 'apm.transaction' as const, service: 'shop-bff', transaction: 'POST /checkout' } }, { id: 'orders', lane: 'app', label: 'orders', kind: 'service' as const }],
    edges: [{ from: 'bff', to: 'orders', kind: 'sync' as const, emphasis: false, entry: 'side' as const, measure: { type: 'apm.span' as const, service: 'shop-bff', destination: 'orders:8080' } }],
    stages: []
  }
  const now = Date.UTC(2026, 0, 2, 12)

  it('builds ONE request per measure over 7 days: current, previous and weekly filters', () => {
    const tx = q.flowMeasure(env(), map.nodes[0]!.measure!, now, 24)
    expect(tx.index).toBe('traces-*')
    expect(tx.body.size).toBe(0)
    const filter = (tx.body.query as { bool: { filter: unknown[] } }).bool.filter
    expect(filter).toEqual(expect.arrayContaining([{ term: { 'processor.event': 'transaction' } }, { term: { 'service.name': 'shop-bff' } }, { term: { 'transaction.name': 'POST /checkout' } }, { terms: { 'service.environment': ['dev'] } }]))
    expect(filter[0]).toEqual({ range: { '@timestamp': { gte: now - 7 * 86_400_000, lt: now, format: 'epoch_millis' } } })
    const aggs = tx.body.aggs as Record<string, { filter: unknown; aggs: Record<string, Record<string, unknown>> }>
    expect(aggs.current?.filter).toEqual(q.es.between(now - 24 * 3_600_000, now))
    expect(aggs.previous?.filter).toEqual(q.es.between(now - 48 * 3_600_000, now - 24 * 3_600_000))
    expect(aggs.weekly?.filter).toEqual(q.es.between(now - 7 * 86_400_000, now))
    expect(aggs.current?.aggs.latency).toEqual({ percentiles: { field: 'transaction.duration.us', percents: [50, 95, 99] } })
    expect(aggs.current?.aggs.failed).toEqual({ filter: { term: { 'event.outcome': 'failure' } } })
    expect(aggs.current?.aggs.codes).toEqual({ terms: { field: 'transaction.result', size: 6 } })
    expect(aggs.current?.aggs.hourly?.date_histogram).toMatchObject({ field: '@timestamp', fixed_interval: '1h', extended_bounds: { min: now - 24 * 3_600_000, max: now } })
    expect(aggs.previous?.aggs.latency).toEqual({ percentiles: { field: 'transaction.duration.us', percents: [50, 95] } })
    const span = q.flowMeasure(env(), map.edges[0]!.measure!, now, 6)
    const spanFilter = (span.body.query as { bool: { filter: unknown[] } }).bool.filter
    expect(spanFilter).toEqual(expect.arrayContaining([{ term: { 'processor.event': 'span' } }, { term: { 'span.destination.service.resource': 'orders:8080' } }]))
    const spanAggs = span.body.aggs as typeof aggs
    expect(spanAggs.current?.aggs.failed).toEqual({ filter: { term: { 'event.outcome': 'failure' } } })
    expect(spanAggs.current?.aggs.codes).toBeUndefined()
    expect(spanAggs.current?.aggs.latency).toEqual({ percentiles: { field: 'span.duration.us', percents: [50, 95, 99] } })
  })

  it('parses percentiles, failures, rate, codes and both baselines', () => {
    const response = {
      aggregations: {
        current: {
          latency: { values: { '50.0': 120_000, '95.0': 900_000, '99.0': 1_500_000 } },
          failed: { doc_count: 5 },
          codes: { buckets: [{ key: 'HTTP 4xx', doc_count: 10 }, { key: 'HTTP 2xx', doc_count: 85 }, { key: 'HTTP 5xx', doc_count: 5 }] },
          hourly: { buckets: [{ key: now - 7_200_000, doc_count: 40, latency: { values: { '50.0': 100_000, '95.0': 800_000 } } }, { key: now - 3_600_000, doc_count: 0, latency: { values: { '50.0': null, '95.0': null } } }, { key: now, doc_count: 60, latency: { values: { '50.0': 130_000, '95.0': 1_000_000 } } }] }
        },
        previous: { doc_count: 50, latency: { values: { '50.0': 90_000, '95.0': 400_000 } }, failed: { doc_count: 1 } },
        weekly: { doc_count: 700, latency: { values: { '50.0': 80_000, '95.0': 360_000 } }, failed: { doc_count: 7 } }
      }
    }
    const timing = q.parseFlowMeasure(response, map.nodes[0]!.measure!, 1)
    expect(timing).toMatchObject({ count: 100, p50Ms: 120, p95Ms: 900, p99Ms: 1500, failed: 5, errorRate: 0.05, perMinute: 1.67 })
    expect(timing.codes).toEqual([{ code: 'HTTP 2xx', count: 85 }, { code: 'HTTP 4xx', count: 10 }, { code: 'HTTP 5xx', count: 5 }])
    expect(timing.previous).toEqual({ count: 50, p50Ms: 90, p95Ms: 400, errorRate: 0.02 })
    expect(timing.weekly).toEqual({ count: 700, p50Ms: 80, p95Ms: 360, errorRate: 0.01 })
    expect(timing.hourly).toEqual([{ at: now - 7_200_000, count: 40, p50Ms: 100, p95Ms: 800 }, { at: now - 3_600_000, count: 0, p50Ms: 0, p95Ms: 0 }, { at: now, count: 60, p50Ms: 130, p95Ms: 1000 }])
    const spanTiming = q.parseFlowMeasure(response, map.edges[0]!.measure!, 1)
    expect(spanTiming.errorRate).toBe(0.05)
    expect(spanTiming.codes).toBeUndefined()
  })

  it('builds and parses the trace logs: APM errors and container lines', () => {
    const errors = q.flowTraceErrors(env(), 'abc123', 50)
    expect(errors.index).toBe('errors-*')
    expect(errors.body).toMatchObject({ size: 50, sort: [{ '@timestamp': 'asc' }] })
    expect((errors.body.query as { bool: { filter: unknown[] } }).bool.filter).toEqual([{ term: { 'trace.id': 'abc123' } }, { terms: { 'service.environment': ['dev'] } }])
    const parsed = q.parseFlowTraceErrors({ hits: { hits: [
      { fields: { '@timestamp': ['1000'], 'service.name': ['shop-bff'], 'error.exception.type': ['TimeoutError', 'Other'], 'error.exception.message': ['timed out'], 'error.culprit': ['Handler.run'] } },
      { fields: { '@timestamp': ['2000'], 'service.name': ['shop-bff'], 'error.grouping_name': ['bad input'] } }
    ] } })
    expect(parsed).toEqual([
      { at: 1000, service: 'shop-bff', level: 'error', message: 'timed out', type: 'TimeoutError', culprit: 'Handler.run', source: 'apm.error' },
      { at: 2000, service: 'shop-bff', level: 'error', message: 'bad input', source: 'apm.error' }
    ])
    const logs = q.flowTraceContainerLogs(env(), 'abc123', 20, now)
    expect(logs.index).toBe('logs-kubernetes.container-dev')
    expect((logs.body.query as { bool: { filter: unknown[] } }).bool.filter).toContainEqual({ match_phrase: { message: 'abc123' } })
    const lines = q.parseFlowTraceContainerLogs({ hits: { hits: [
      { fields: { '@timestamp': ['3000'], message: [JSON.stringify({ 'log.level': 'x', log: { level: 'warn' }, message: 'slow call abc123', service: { name: 'orders' } })], 'kubernetes.container.name': ['orders-c'] } },
      { fields: { '@timestamp': ['4000'], message: ['plain text abc123 ' + 'x'.repeat(500)], 'kubernetes.container.name': ['shop-bff'], 'log.level': ['info'] } },
      { fields: { '@timestamp': ['5000'], message: [JSON.stringify({ err: { message: 'boom' } })], 'kubernetes.container.name': ['shop-bff'] } }
    ] } })
    expect(lines[0]).toEqual({ at: 3000, service: 'orders', level: 'warn', message: 'slow call abc123', source: 'logs' })
    expect(lines[1]?.service).toBe('shop-bff')
    expect(lines[1]?.level).toBe('info')
    expect(lines[1]?.message.length).toBe(400)
    expect(lines[2]?.message).toContain('boom')
  })

  it('merges trace log sources, skips a failed one and throws when both fail', async () => {
    const mk = (fail: (url: string) => boolean): ElasticHealthProvider => {
      const http: HttpClient = async (req) => {
        if (fail(req.url)) return { status: 500, text: JSON.stringify({ error: { type: 'x', reason: 'shards failed' } }) }
        const apm = req.url.includes('errors-')
        const hit = apm ? { fields: { '@timestamp': ['2000'], 'service.name': ['shop-bff'], 'error.exception.type': ['E'] } } : { fields: { '@timestamp': ['1000'], message: ['hello abc123'], 'kubernetes.container.name': ['shop-bff'] } }
        return { status: 200, text: JSON.stringify({ hits: { hits: [hit] } }) }
      }
      return new ElasticHealthProvider({ client: new ElasticClient({ baseUrl: 'https://es.example.test', auth: { mode: 'apiKey', secret: 'k' }, http }) })
    }
    const both = await mk(() => false).flowTraceLogs(env(), 'abc123', 10)
    expect(both.map((l) => l.source)).toEqual(['logs', 'apm.error'])
    expect(await mk((u) => u.includes('errors-')).flowTraceLogs(env(), 'abc123', 10)).toHaveLength(1)
    await expect(mk(() => true).flowTraceLogs(env(), 'abc123', 10)).rejects.toThrow(/abc123/)
  })

  it('reads every measure of a map at once and reports the ones that failed under their key', async () => {
    const calls: string[] = []
    const http: HttpClient = async (req) => {
      calls.push(req.url)
      const body = JSON.parse(req.body ?? '{}') as { query: { bool: { filter: Record<string, unknown>[] } } }
      const span = body.query.bool.filter.some((c) => JSON.stringify(c).includes('"span"'))
      if (span) return { status: 500, text: JSON.stringify({ error: { type: 'search_phase_execution_exception', reason: 'shards failed' } }) }
      return { status: 200, text: JSON.stringify({ aggregations: { current: { latency: { values: { '50.0': 50_000, '95.0': 70_000 } }, failed: { doc_count: 0 }, hourly: { buckets: [] } } } }) }
    }
    const provider = new ElasticHealthProvider({ client: new ElasticClient({ baseUrl: 'https://es.example.test', auth: { mode: 'apiKey', secret: 'k' }, http }) })
    const reading = await provider.flowMap(env(), map, now, 24)
    expect(calls).toHaveLength(2)
    expect(reading.nodes.bff).toMatchObject({ count: 0, p50Ms: 50, p95Ms: 70 })
    expect(reading.edges['bff->orders']).toBeUndefined()
    expect(reading.errors['bff->orders']).toMatch(/shards failed|500/)
    // Without a traces index nothing is asked and every measure says why.
    const blind = await provider.flowMap(env({ apm: { errors: 'errors-*', traces: '', metrics: '' } }), map, now, 24)
    expect(calls).toHaveLength(2)
    expect(Object.keys(blind.errors)).toEqual(['bff->orders', 'bff'])
  })

  it('demo: made-up numbers per measure, with one hour per hour of the window', async () => {
    const reading = await new DemoHealthProvider().flowMap(env(), map, now, 48)
    expect(reading.nodes.bff?.hourly).toHaveLength(48)
    expect(reading.edges['bff->orders']?.count).toBeGreaterThan(0)
    expect(reading.nodes.bff?.errorRate).toBeDefined()
    expect(reading.edges['bff->orders']?.errorRate).toBeDefined()
    expect(reading.nodes.bff?.codes?.length).toBeGreaterThan(0)
    expect(reading.edges['bff->orders']?.codes).toBeUndefined()
    const slow = reading.edges['bff->orders']!
    expect(slow.p95Ms / slow.weekly!.p95Ms).toBeCloseTo(2.5, 0)
    expect(slow.p99Ms).toBeGreaterThan(slow.p95Ms)
    expect(slow.previous).toBeDefined()
    const logs = await new DemoHealthProvider().flowTraceLogs(env(), 'demo-abc', 10)
    expect(logs.filter((l) => l.source === 'apm.error')).toHaveLength(1)
    expect(logs.length).toBeGreaterThanOrEqual(3)
  })
})

describe('flow map executions', () => {
  const map = {
    version: 1 as const,
    id: 'checkout',
    name: 'Checkout',
    phases: [],
    lanes: [{ id: 'app', label: 'App', kind: 'normal' as const }],
    nodes: [{ id: 'bff', lane: 'app', label: 'shop-bff', kind: 'app' as const, measure: { type: 'apm.transaction' as const, service: 'shop-bff', transaction: 'POST /checkout' } }, { id: 'orders', lane: 'app', label: 'orders', kind: 'service' as const }],
    edges: [{ from: 'bff', to: 'orders', kind: 'sync' as const, emphasis: false, entry: 'side' as const, measure: { type: 'apm.span' as const, service: 'shop-bff', destination: 'orders:8080' } }],
    stages: []
  }
  const now = Date.UTC(2026, 0, 2, 12)
  const entry = map.nodes[0]!.measure!

  it('lists the entry transaction\'s traces newest, slowest or failed-only, a handful of hits with the trace id', () => {
    const latest = q.flowTraces(env(), entry, now, 24, 'latest', 50)
    expect(latest.index).toBe('traces-*')
    expect(latest.body).toMatchObject({ size: 50, sort: [{ '@timestamp': 'desc' }], _source: false })
    const filter = (latest.body.query as { bool: { filter: unknown[] } }).bool.filter
    expect(filter).toEqual(expect.arrayContaining([{ term: { 'processor.event': 'transaction' } }, { term: { 'service.name': 'shop-bff' } }, { term: { 'transaction.name': 'POST /checkout' } }]))
    expect(filter.some((c) => JSON.stringify(c).includes('event.outcome'))).toBe(false)
    expect(q.flowTraces(env(), entry, now, 24, 'slowest', 10).body.sort).toEqual([{ 'transaction.duration.us': 'desc' }])
    const failed = q.flowTraces(env(), entry, now, 24, 'failed', 10)
    expect((failed.body.query as { bool: { filter: unknown[] } }).bool.filter).toEqual(expect.arrayContaining([{ term: { 'event.outcome': 'failure' } }]))
    const hits = { hits: { hits: [
      { fields: { 'trace.id': ['t1'], '@timestamp': [String(now - 1000)], 'transaction.duration.us': [1_200_000], 'event.outcome': ['success'] } },
      { fields: { 'trace.id': ['t1'], '@timestamp': [String(now - 1000)], 'transaction.duration.us': [1_200_000], 'event.outcome': ['success'] } },
      { fields: { 'trace.id': ['t2'], '@timestamp': [String(now - 5000)], 'transaction.duration.us': [300_000], 'event.outcome': ['failure'] } },
      { fields: { '@timestamp': [String(now)] } }
    ] } }
    expect(q.parseFlowTraces(hits)).toEqual([
      { traceId: 't1', at: now - 1000, durationMs: 1200, outcome: 'success' },
      { traceId: 't2', at: now - 5000, durationMs: 300, outcome: 'failure' }
    ])
  })

  it('reads every transaction and span of one trace, oldest first, into provider-neutral documents', () => {
    const req = q.flowTraceDocs(env(), 'abc')
    expect(req.body).toMatchObject({ size: 2000, sort: [{ '@timestamp': 'asc' }] })
    expect((req.body.query as { bool: { filter: unknown[] } }).bool.filter).toEqual([{ term: { 'trace.id': 'abc' } }, { terms: { 'processor.event': ['transaction', 'span'] } }])
    const docs = q.parseFlowTraceDocs({ hits: { hits: [
      { fields: { 'processor.event': ['transaction'], 'service.name': ['shop-bff'], 'transaction.name': ['POST /checkout'], 'transaction.duration.us': [900_000], '@timestamp': [String(now)], 'event.outcome': ['success'] } },
      { fields: { 'processor.event': ['span'], 'service.name': ['shop-bff'], 'span.name': ['POST orders'], 'span.duration.us': [300_000], 'span.destination.service.resource': ['orders:8080'], '@timestamp': [String(now + 20)] } },
      { fields: { 'processor.event': ['error'], 'service.name': ['shop-bff'], '@timestamp': [String(now + 30)] } }
    ] } })
    expect(docs).toEqual([
      { event: 'transaction', service: 'shop-bff', name: 'POST /checkout', at: now, durationMs: 900, outcome: 'success' },
      { event: 'span', service: 'shop-bff', name: 'POST orders', destination: 'orders:8080', at: now + 20, durationMs: 300 }
    ])
  })

  it('provider: lists and lays an execution over the map; says why when the map has no entry or the trace is gone', async () => {
    const http: HttpClient = async (req) => {
      const body = JSON.parse(req.body ?? '{}') as { query: { bool: { filter: Record<string, unknown>[] } } }
      const byTrace = body.query.bool.filter.some((c) => JSON.stringify(c).includes('trace.id'))
      if (byTrace) {
        const gone = body.query.bool.filter.some((c) => JSON.stringify(c).includes('"gone"'))
        return { status: 200, text: JSON.stringify({ hits: { hits: gone ? [] : [
          { fields: { 'processor.event': ['transaction'], 'service.name': ['shop-bff'], 'transaction.name': ['POST /checkout'], 'transaction.duration.us': [900_000], '@timestamp': [String(now)], 'event.outcome': ['success'] } },
          { fields: { 'processor.event': ['span'], 'service.name': ['shop-bff'], 'span.name': ['POST orders'], 'span.duration.us': [300_000], 'span.destination.service.resource': ['orders:8080'], '@timestamp': [String(now + 20)] } }
        ] } }) }
      }
      return { status: 200, text: JSON.stringify({ hits: { hits: [{ fields: { 'trace.id': ['t1'], '@timestamp': [String(now)], 'transaction.duration.us': [900_000], 'event.outcome': ['success'] } }] } }) }
    }
    const provider = new ElasticHealthProvider({ client: new ElasticClient({ baseUrl: 'https://es.example.test', auth: { mode: 'apiKey', secret: 'k' }, http }) })
    expect(await provider.flowTraces(env(), map, now, 24, 'latest', 50)).toEqual([{ traceId: 't1', at: now, durationMs: 900, outcome: 'success' }])
    const trace = await provider.flowTrace(env(), map, 't1')
    expect(trace.hops.bff).toMatchObject({ durationMs: 900, startMs: 0 })
    expect(trace.hops['bff->orders']).toMatchObject({ durationMs: 300, startMs: 20 })
    expect(trace.unmapped).toEqual([])
    await expect(provider.flowTrace(env(), map, 'gone')).rejects.toThrow(/not found/)
    await expect(provider.flowTraces(env(), { ...map, nodes: map.nodes.map((n) => ({ ...n, measure: undefined })) }, now, 24, 'latest', 50)).rejects.toThrow(/no entry transaction/)
    await expect(provider.flowTraces(env({ apm: { errors: 'errors-*', traces: '', metrics: '' } }), map, now, 24, 'latest', 50)).rejects.toThrow(/traces index/)
  })

  it('demo: made-up executions in every order, each one walking the measured parts plus one unmapped call', async () => {
    const demo = new DemoHealthProvider()
    const latest = await demo.flowTraces(env(), map, now, 24, 'latest', 20)
    expect(latest).toHaveLength(20)
    expect(latest[0]!.at).toBeGreaterThan(latest[1]!.at)
    const slowest = await demo.flowTraces(env(), map, now, 24, 'slowest', 5)
    expect(slowest[0]!.durationMs).toBeGreaterThanOrEqual(slowest[4]!.durationMs)
    expect((await demo.flowTraces(env(), map, now, 24, 'failed', 50)).every((t) => t.outcome === 'failure')).toBe(true)
    const trace = await demo.flowTrace(env(), map, latest[0]!.traceId)
    expect(trace.at).toBe(latest[0]!.at)
    expect(Object.keys(trace.hops).sort()).toEqual(['bff', 'bff->orders'])
    expect(trace.unmapped).toHaveLength(1)
  })
})
