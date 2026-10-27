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
