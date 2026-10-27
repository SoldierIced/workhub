import { describe, expect, it } from 'vitest'
import { DEFAULT_HEALTH_THRESHOLDS, emptySignals, HealthConnectionError, makeSnapshot, refreshEnvironment, type HealthEnvironment } from '@workhub/core'
import {
  authorizationHeader,
  DemoHealthProvider,
  DEMO_HEALTH_SETTINGS,
  ElasticClient,
  ElasticError,
  ElasticHealthProvider,
  elasticQueries as q,
  indexPath,
  isFingerprint,
  kibanaEnvironmentUrl,
  kibanaServiceUrl,
  normalizeElasticUrl,
  normalizeFingerprint,
  classifyNetworkError
} from '../src/health-elastic'
import type { HttpClient, HttpRequest } from '../src/shared/http'

const env = (over: Partial<HealthEnvironment> = {}): HealthEnvironment => ({
  id: 'dev',
  name: 'Develop',
  apmEnvironments: ['dev', ' develop ', ''],
  k8sIndexSuffix: 'dev',
  hasKubeState: true,
  apm: { errors: 'errors-*', traces: 'traces-*', metrics: 'metrics-*' },
  kibanaUrl: 'https://kibana.example.test/',
  thresholds: { ...DEFAULT_HEALTH_THRESHOLDS },
  ...over
})

/** The bucket shape of `dailyTrend`: daily counts oldest first and the rolling count. */
const trendBucket = (key: string, daily: number[], recent: number, extra: Record<string, unknown> = {}) => ({
  key,
  doc_count: daily.reduce((a, b) => a + b, 0),
  daily: { buckets: daily.map((doc_count, i) => ({ key: i, doc_count })) },
  recent: { doc_count: recent },
  ...extra
})

describe('query building', () => {
  it('filters errors by every service.environment value, trimmed, and asks for no hits', () => {
    const r = q.errorsByService(env())
    expect(r.index).toBe('errors-*')
    expect(r.body).toMatchObject({ size: 0, track_total_hits: false })
    const filters = (r.body['query'] as { bool: { filter: unknown[] } }).bool.filter
    expect(filters).toContainEqual({ terms: { 'service.environment': ['dev', 'develop'] } })
    expect(filters).toContainEqual({ range: { '@timestamp': { gte: 'now-14d/d' } } })
    expect(JSON.stringify(r.body)).toContain('"recent":{"filter":{"range":{"@timestamp":{"gte":"now-24h"}}}}')
  })

  it('uses the thresholds for windows', () => {
    const r = q.errorsByService(env({ thresholds: { ...DEFAULT_HEALTH_THRESHOLDS, trendWindowDays: 7, errorWindowHours: 6 } }))
    expect(JSON.stringify(r.body)).toContain('now-7d/d')
    expect(JSON.stringify(r.body)).toContain('now-6h')
  })

  it('builds Kubernetes indices from the namespace suffix', () => {
    expect(q.k8sIndex('statePod', env())).toBe('metrics-kubernetes.state_pod-dev')
    expect(q.k8sIndex('event', env({ k8sIndexSuffix: ' prod ' }))).toBe('metrics-kubernetes.event-prod')
    expect(q.warningEvents(env()).index).toBe('metrics-kubernetes.event-dev')
  })

  it('looks for running pods that are not ready inside the restart window', () => {
    const r = q.podsNotReady(env({ thresholds: { ...DEFAULT_HEALTH_THRESHOLDS, restartWindowMinutes: 30 } }))
    const text = JSON.stringify(r.body)
    expect(text).toContain('now-30m')
    expect(text).toContain('"kubernetes.pod.status.ready":false')
    expect(text).toContain('"kubernetes.pod.status.phase":"running"')
  })

  it('asks the slow flows for percentiles in microseconds over the configured window', () => {
    const r = q.slowTransactions(env({ thresholds: { ...DEFAULT_HEALTH_THRESHOLDS, slowFlowHours: 12 } }))
    const text = JSON.stringify(r.body)
    expect(text).toContain('now-12h')
    expect(text).toContain('"percents":[50,95,99]')
    expect(text).toContain('"processor.event":"transaction"')
  })

  it('knows which signals an environment can read', () => {
    expect(q.readsErrors(env())).toBe(true)
    expect(q.readsErrors(env({ apmEnvironments: ['  '] }))).toBe(false)
    expect(q.readsErrors(env({ apm: { errors: ' ', traces: 't', metrics: 'm' } }))).toBe(false)
    expect(q.readsTraces(env({ apm: { errors: 'e', traces: '', metrics: 'm' } }))).toBe(false)
  })
})

describe('response parsing', () => {
  it('turns error buckets into services with a trend, dropping keys silent in the window', () => {
    const response = {
      aggregations: {
        by_key: {
          buckets: [trendBucket('checkout', [0, 0, 0, 40], 40), trendBucket('quiet', [9, 9, 9, 9], 0), trendBucket('batch', [10, 10, 10, 12], 25), { doc_count: 3 }]
        }
      }
    }
    const parsed = q.parseErrorsByService(response)
    expect(parsed.map((e) => [e.service, e.stats.state, e.stats.recent])).toEqual([
      ['checkout', 'new', 40],
      ['batch', 'worsening', 25]
    ])
  })

  it('reads warning events with their latest occurrence', () => {
    const response = {
      aggregations: {
        by_key: {
          buckets: [
            trendBucket('BackOff', [0, 4, 9], 9, {
              latest: { hits: { hits: [{ fields: { 'kubernetes.event.message': ['Back-off\n restarting   failed container'], 'kubernetes.event.involved_object.name': ['web-1'], 'kubernetes.event.involved_object.kind': ['Pod'], '@timestamp': ['1790000000000'] } }] } }
            })
          ]
        }
      }
    }
    expect(q.parseWarningEvents(response)).toMatchObject([{ reason: 'BackOff', message: 'Back-off restarting failed container', object: 'web-1', objectKind: 'Pod', lastSeen: 1_790_000_000_000 }])
  })

  it('reads pods: not ready, restart movement inside the window, back-off', () => {
    expect(q.parsePodsNotReady({ aggregations: { by_pod: { buckets: [{ key: 'web-1', doc_count: 3 }, { doc_count: 1 }] } } }).map((p) => [p.pod, p.notReady])).toEqual([['web-1', true]])
    const restarts = q.parseContainerRestarts({
      aggregations: { by_pod: { buckets: [{ key: 'api-1', restarts: { value: 14 }, first: { value: 8 } }, { key: 'idle', restarts: { value: 0 }, first: { value: 0 } }] } }
    })
    expect(restarts).toMatchObject([{ pod: 'api-1', restarts: 14, recentRestarts: 6 }])
    expect(q.parseBackOffEvents({ aggregations: { by_object: { buckets: [{ key: 'api-1' }] } } })).toMatchObject([{ pod: 'api-1', backOff: true }])
  })

  it('marks services whose agent metrics are older than the threshold as silent', () => {
    const now = 10_000_000
    const response = { aggregations: { by_service: { buckets: [{ key: 'b', last_seen: { value: now - 3 * 60_000 } }, { key: 'a', last_seen: { value: now - 45 * 60_000 } }, { key: 'broken' }] } } }
    expect(q.parseApmReporting(response, now, 10)).toEqual([
      { service: 'a', lastSeen: now - 45 * 60_000, silentMinutes: 45, isReporting: false },
      { service: 'b', lastSeen: now - 3 * 60_000, silentMinutes: 3, isReporting: true }
    ])
  })

  it('reads slow transactions: microseconds to milliseconds, min calls, slowest first, capped', () => {
    const bucket = (name: string, calls: number, p95us: number, failed = 0) => ({
      key: name,
      doc_count: calls,
      service: { buckets: [{ key: 'svc' }] },
      latency: { values: { '50.0': p95us / 4, '95.0': p95us, '99.0': p95us * 2 } },
      failed: { doc_count: failed },
      kind: { buckets: [{ key: 'request' }] }
    })
    const response = { aggregations: { by_transaction: { buckets: [bucket('GET /a', 100, 500_000), bucket('GET /rare', 10, 9_000_000), bucket('GET /b', 200, 2_000_000, 20), bucket('GET /c', 80, 100_000)] } } }
    const parsed = q.parseSlowTransactions(response, 50, 2)
    expect(parsed.map((t) => t.name)).toEqual(['GET /b', 'GET /a'])
    expect(parsed[0]).toMatchObject({ service: 'svc', type: 'request', calls: 200, p50Ms: 500, p95Ms: 2000, p99Ms: 4000, failureRate: 0.1 })
  })

  it('accepts percentile keys without a decimal and ignores a transaction with no percentiles', () => {
    expect(q.percentileMs({ values: { '95': 3000 } }, 95)).toBe(3)
    expect(q.percentileMs({}, 95)).toBeUndefined()
  })

  it('never throws on an unexpected shape', () => {
    for (const bad of [undefined, null, 'x', 5, [], {}, { aggregations: 7 }]) {
      expect(q.parseErrorsByService(bad)).toEqual([])
      expect(q.parseWarningEvents(bad)).toEqual([])
      expect(q.parseSlowTransactions(bad, 1, 5)).toEqual([])
      expect(q.parseApmReporting(bad, 0, 10)).toEqual([])
    }
  })
})

describe('ElasticClient', () => {
  const fake = (respond: (req: HttpRequest) => { status?: number; body?: unknown } | Error) => {
    const calls: HttpRequest[] = []
    const http: HttpClient = async (req) => {
      calls.push(req)
      const r = respond(req)
      if (r instanceof Error) throw r
      return { status: r.status ?? 200, text: r.body === undefined ? '' : JSON.stringify(r.body) }
    }
    return { http, calls }
  }
  const client = (http: HttpClient, auth: ConstructorParameters<typeof ElasticClient>[0]['auth'] = { mode: 'apiKey', secret: 'k-123' }) => new ElasticClient({ baseUrl: 'https://es.example.test:9200/', auth, http })

  it('posts an aggregation search with an API key and encodes index patterns', async () => {
    const { http, calls } = fake(() => ({ body: { aggregations: {} } }))
    await client(http).search('logs-apm.error-*,traces-apm-*', { size: 0 })
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://es.example.test:9200/logs-apm.error-*,traces-apm-*/_search', headers: { Authorization: 'ApiKey k-123' }, body: '{"size":0}' })
  })

  it('counts with the query wrapped as the body', async () => {
    const { http, calls } = fake(() => ({ body: { count: 42 } }))
    expect(await client(http).count('idx', { range: {} })).toBe(42)
    expect(calls[0]?.url).toBe('https://es.example.test:9200/idx/_count')
    expect(calls[0]?.body).toBe('{"query":{"range":{}}}')
  })

  it('sends HTTP Basic for username and password', async () => {
    const { http, calls } = fake(() => ({ body: { count: 1 } }))
    await client(http, { mode: 'basic', username: 'reader', secret: 'pw' }).count('idx', {})
    expect(calls[0]?.headers['Authorization']).toBe(`Basic ${Buffer.from('reader:pw').toString('base64')}`)
  })

  it('refuses plain http except for localhost, a colon in the user and a missing credential', () => {
    const http = fake(() => ({})).http
    expect(() => new ElasticClient({ baseUrl: 'http://es.example.test', auth: { mode: 'apiKey', secret: 'k' }, http })).toThrow(/https/)
    expect(() => new ElasticClient({ baseUrl: 'http://localhost:9200', auth: { mode: 'apiKey', secret: 'k' }, http })).not.toThrow()
    expect(() => new ElasticClient({ baseUrl: 'https://es.example.test', auth: { mode: 'basic', username: 'a:b', secret: 'k' }, http })).toThrow(/colon/)
    expect(() => new ElasticClient({ baseUrl: 'https://es.example.test', auth: { mode: 'apiKey', secret: '' }, http })).toThrow(/credential/)
  })

  it('classifies failures: credentials, bad response with reason, unreachable, certificate, timeout', async () => {
    const run = async (r: Parameters<typeof fake>[0]): Promise<ElasticError> => {
      try {
        await client(fake(r).http).count('idx', {})
      } catch (e) {
        return e as ElasticError
      }
      throw new Error('expected a failure')
    }
    const denied = await run(() => ({ status: 403 }))
    expect(denied).toMatchObject({ kind: 'unauthorized', status: 403, isConnectionLevel: true })
    expect(denied.message).not.toContain('k-123')
    const bad = await run(() => ({ status: 400, body: { error: { reason: 'failed to parse', type: 'x' } } }))
    expect(bad).toMatchObject({ kind: 'badResponse', status: 400, isConnectionLevel: false })
    expect(bad.message).toContain('failed to parse')
    expect(await run(() => new Error('getaddrinfo ENOTFOUND es.example.test'))).toMatchObject({ kind: 'unreachable' })
    expect(await run(() => Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))).toMatchObject({ kind: 'untrustedCertificate' })
    expect(await run(() => Object.assign(new Error('late'), { name: 'TimeoutError' }))).toMatchObject({ kind: 'timedOut', isConnectionLevel: false })
    expect(await run(() => ({ status: 200 }))).toMatchObject({ kind: 'badResponse' })
  })

  it('has pure helpers for URL, header, index path and fingerprints', () => {
    expect(normalizeElasticUrl('https://es.example.test:9200///')).toBe('https://es.example.test:9200')
    expect(normalizeElasticUrl('ftp://x')).toBeNull()
    expect(normalizeElasticUrl('not a url')).toBeNull()
    expect(authorizationHeader({ mode: 'apiKey', secret: 's' })).toBe('ApiKey s')
    expect(indexPath('a b,c/d*')).toBe('a%20b,c%2Fd*')
    const fp = 'AB:CD:' + 'ef'.repeat(30)
    expect(normalizeFingerprint(fp)).toBe('abcd' + 'ef'.repeat(30))
    expect(isFingerprint(fp)).toBe(true)
    expect(isFingerprint('abcd')).toBe(false)
    expect(classifyNetworkError(new Error('boom'), 20_000).kind).toBe('unreachable')
  })
})

describe('ElasticHealthProvider', () => {
  /** Routes by index and endpoint, like a cluster would. */
  function cluster(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
    const seen: string[] = []
    const http: HttpClient = async (req) => {
      const path = new URL(req.url).pathname.slice(1)
      seen.push(path)
      const handler = handlers[path]
      if (!handler) return { status: 404, text: JSON.stringify({ error: { reason: `no such index ${path}` } }) }
      const out = handler(JSON.parse(req.body ?? '{}'))
      if (out instanceof Error) throw out
      return { status: 200, text: JSON.stringify(out) }
    }
    const provider = new ElasticHealthProvider({ client: new ElasticClient({ baseUrl: 'https://es.example.test', auth: { mode: 'apiKey', secret: 'k' }, http }), testIndex: 'errors-*' })
    return { provider, seen }
  }
  const NOW = 1_800_000_000_000

  it('reads every tier of a healthy environment and builds a healthy snapshot', async () => {
    const { provider, seen } = cluster({
      'metrics-kubernetes.state_pod-dev/_count': () => ({ count: 1000 }),
      'metrics-kubernetes.state_pod-dev/_search': () => ({ aggregations: { by_pod: { buckets: [] } } }),
      'metrics-kubernetes.state_container-dev/_search': () => ({ aggregations: { by_pod: { buckets: [] } } }),
      'metrics-kubernetes.event-dev/_search': () => ({ aggregations: { by_object: { buckets: [] }, by_key: { buckets: [] } } }),
      'metrics-*/_search': () => ({ aggregations: { by_service: { buckets: [{ key: 'api', last_seen: { value: NOW - 30_000 } }] } } }),
      'errors-*/_search': () => ({ aggregations: { by_key: { buckets: [] } } }),
      'traces-*/_search': () => ({ aggregations: { by_transaction: { buckets: [] } } })
    })
    const reading = await refreshEnvironment(provider, env(), undefined, NOW)
    expect(reading.snapshot.state).toBe('healthy')
    expect(reading.snapshot.reportingServiceCount).toBe(1)
    expect(seen).toContain('metrics-kubernetes.state_pod-dev/_count')
    // Read-only: only _search and _count are ever called.
    expect(seen.every((p) => p.endsWith('/_search') || p.endsWith('/_count'))).toBe(true)
  })

  it('reads blind, not healthy, when the cluster ships no pod metrics', async () => {
    const { provider } = cluster({
      'metrics-kubernetes.state_pod-dev/_count': () => ({ count: 0 }),
      'metrics-kubernetes.event-dev/_search': () => ({ aggregations: { by_key: { buckets: [] } } }),
      'metrics-*/_search': () => ({ aggregations: { by_service: { buckets: [] } } }),
      'errors-*/_search': () => ({ aggregations: { by_key: { buckets: [] } } }),
      'traces-*/_search': () => ({ aggregations: { by_transaction: { buckets: [] } } })
    })
    const reading = await refreshEnvironment(provider, env(), undefined, NOW)
    expect(reading.snapshot.state).toBe('blind')
    expect(reading.snapshot.blindSpots.map((b) => b.code)).toContain('noPodMetrics')
  })

  it('reports one failed query as that signal failing, not as zero, and keeps reading the rest', async () => {
    const { provider } = cluster({
      'metrics-kubernetes.state_pod-dev/_count': () => ({ count: 5 }),
      'metrics-kubernetes.state_pod-dev/_search': () => ({ aggregations: { by_pod: { buckets: [] } } }),
      'metrics-kubernetes.state_container-dev/_search': () => ({ aggregations: { by_pod: { buckets: [] } } }),
      'metrics-kubernetes.event-dev/_search': () => ({ aggregations: { by_object: { buckets: [] }, by_key: { buckets: [] } } }),
      'metrics-*/_search': () => ({ aggregations: { by_service: { buckets: [] } } }),
      // errors-* has no handler: 404
      'traces-*/_search': () => ({ aggregations: { by_transaction: { buckets: [] } } })
    })
    const reading = await refreshEnvironment(provider, env(), undefined, NOW)
    expect(reading.snapshot.state).toBe('blind')
    expect(reading.snapshot.blindSpots).toContainEqual({ code: 'unread', signal: 'errors', detail: expect.stringContaining('no such index') })
  })

  it('throws a connection error when the credentials are refused or the host is down', async () => {
    const down = cluster({ 'metrics-kubernetes.state_pod-dev/_count': () => new Error('getaddrinfo ENOTFOUND') })
    await expect(down.provider.read(env(), ['fast'], NOW)).rejects.toBeInstanceOf(HealthConnectionError)
    const reading = await refreshEnvironment(down.provider, env(), undefined, NOW)
    expect(reading.snapshot.state).toBe('unreachable')
  })

  it('skips the signals an environment does not configure', async () => {
    const { provider, seen } = cluster({})
    const bare = env({ k8sIndexSuffix: '', hasKubeState: false, apm: { errors: '', traces: '', metrics: '' } })
    const out = await provider.read(bare, ['fast', 'trend', 'slow'], NOW)
    expect(seen).toEqual([])
    expect(out.podVisibility).toBe('notExpected')
    expect(makeSnapshot(bare, { ...emptySignals(), ...out }).state).toBe('blind')
  })

  it('tests the connection with one _count and never leaks the credential', async () => {
    const ok = cluster({ 'errors-*/_count': () => ({ count: 1234 }) })
    expect(await ok.provider.test()).toEqual({ ok: true, account: '1,234 documents in errors-*' })
    const denied = new ElasticHealthProvider({
      client: new ElasticClient({ baseUrl: 'https://es.example.test', auth: { mode: 'apiKey', secret: 'super-secret' }, http: async () => ({ status: 401, text: '' }) })
    })
    const r = await denied.test()
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('super-secret')
  })
})

describe('Kibana links', () => {
  it('links one service over the last 24 hours with the first environment value', () => {
    const url = new URL(kibanaServiceUrl(env(), 'checkout api')!)
    expect(url.origin + url.pathname).toBe('https://kibana.example.test/app/apm/services/checkout%20api/overview')
    expect(url.searchParams.get('rangeFrom')).toBe('now-24h')
    expect(url.searchParams.get('environment')).toBe('dev')
  })
  it('keeps a base path and links the environment', () => {
    const url = new URL(kibanaEnvironmentUrl(env({ kibanaUrl: 'https://example.test/kibana/' }))!)
    expect(url.pathname).toBe('/kibana/app/apm/services')
  })
  it('gives no link without a usable Kibana URL', () => {
    expect(kibanaServiceUrl(env({ kibanaUrl: '' }), 'x')).toBeNull()
    expect(kibanaServiceUrl(env({ kibanaUrl: 'javascript:alert(1)' }), 'x')).toBeNull()
    expect(kibanaEnvironmentUrl(env({ kibanaUrl: 'nope' }))).toBeNull()
  })
})

describe('demo provider', () => {
  it('gives each demo environment its own verdict, with no cluster involved', async () => {
    const provider = new DemoHealthProvider()
    const states: Record<string, string> = {}
    for (const e of DEMO_HEALTH_SETTINGS.environments) {
      const reading = await refreshEnvironment(provider, e, undefined, Date.now())
      states[e.id] = reading.snapshot.state
    }
    expect(states).toEqual({ production: 'healthy', staging: 'blind', develop: 'degraded' })
  })
})
