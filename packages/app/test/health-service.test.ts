import { describe, expect, it } from 'vitest'
import { emptyConfig, type Connection, type HealthEnvironment, type Profile, type SecretStore, type WorkhubConfig, DEFAULT_HEALTH_THRESHOLDS } from '@workhub/core'
import type { HttpClient, HttpRequest } from '@workhub/adapters/http'
import { buildHealthProvider, HEALTH_MIN_GAP_MS, HealthService, tlsOf } from '../src/main/health-service'

const elastic: Connection = { id: 'es', kind: 'health', provider: 'elastic-apm', endpoint: 'https://es.example.test:9200', secretRef: 'connection/es', settings: {} }
const env: HealthEnvironment = {
  id: 'dev',
  name: 'Develop',
  apmEnvironments: ['dev'],
  k8sIndexSuffix: '',
  hasKubeState: false,
  apm: { errors: 'errors-*', traces: 'traces-*', metrics: 'metrics-*' },
  kibanaUrl: 'https://kibana.example.test',
  thresholds: { ...DEFAULT_HEALTH_THRESHOLDS }
}
const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'work',
  name: 'Work',
  connections: { health: 'es' },
  accountIds: [],
  modules: { flows: false, health: true, chatWatcher: false, automations: false },
  health: { refreshMinutes: 15, environments: [env] },
  ...over
})

/** A cluster that answers every aggregation with no buckets, counting the requests. */
function cluster() {
  const calls: HttpRequest[] = []
  const http: HttpClient = async (req) => {
    calls.push(req)
    return { status: 200, text: JSON.stringify({ count: 7, aggregations: { by_key: { buckets: [{ key: 'api', doc_count: 5, daily: { buckets: [{ doc_count: 0 }, { doc_count: 5 }] }, recent: { doc_count: 5 } }] }, by_service: { buckets: [{ key: 'api', last_seen: { value: Date.now() } }] }, by_transaction: { buckets: [] } } }) }
  }
  return { http, calls }
}

function service(opts: { profile?: Profile; connections?: Connection[]; secrets?: Record<string, string>; demo?: boolean; http?: HttpClient; now?: () => number }) {
  const config: WorkhubConfig = { ...emptyConfig(), connections: opts.connections ?? [elastic], profiles: [opts.profile ?? profile()], activeProfileId: 'work' }
  const secrets: SecretStore = { get: async (ref) => opts.secrets?.[ref] ?? null, set: async () => {}, delete: async () => {}, has: async (ref) => ref in (opts.secrets ?? {}) }
  return new HealthService({ configuration: { current: async () => config } as never, secrets, demo: opts.demo ?? false, httpFor: () => opts.http ?? cluster().http, now: opts.now })
}

describe('buildHealthProvider', () => {
  it('needs the URL, a valid user in basic mode, the secret and a fingerprint when pinning', () => {
    expect(buildHealthProvider({ ...elastic, endpoint: undefined }, 'k', undefined)).toEqual({ missing: 'incomplete', detail: 'url' })
    expect(buildHealthProvider(elastic, null, undefined)).toEqual({ missing: 'incomplete', detail: 'secret' })
    expect(buildHealthProvider({ ...elastic, settings: { auth: 'basic', username: '' } }, 'p', undefined)).toEqual({ missing: 'incomplete', detail: 'user' })
    expect(buildHealthProvider({ ...elastic, settings: { auth: 'basic', username: 'a:b' } }, 'p', undefined)).toEqual({ missing: 'incomplete', detail: 'user' })
    expect(buildHealthProvider({ ...elastic, settings: { tls: 'pinned', tlsFingerprint: 'abcd' } }, 'k', undefined)).toEqual({ missing: 'incomplete', detail: 'fingerprint' })
    expect('provider' in buildHealthProvider(elastic, 'k', undefined)).toBe(true)
    expect(buildHealthProvider({ ...elastic, provider: 'sentry' }, 'k', undefined)).toEqual({ missing: 'unsupported' })
  })
  it('refuses a plain http URL that is not localhost', () => {
    expect(buildHealthProvider({ ...elastic, endpoint: 'http://es.example.test' }, 'k', undefined)).toEqual({ missing: 'incomplete', detail: 'url' })
    expect('provider' in buildHealthProvider({ ...elastic, endpoint: 'http://localhost:9200' }, 'k', undefined)).toBe(true)
  })
  it('reads the TLS policy of a connection', () => {
    expect(tlsOf(elastic)).toEqual({ mode: 'system', fingerprint: undefined })
    expect(tlsOf({ ...elastic, settings: { tls: 'insecure' } }).mode).toBe('insecure')
    expect(tlsOf({ ...elastic, settings: { tls: 'weird' } }).mode).toBe('system')
  })
})

describe('HealthService', () => {
  it('says why there is nothing to show', async () => {
    expect((await service({ profile: profile({ modules: { flows: false, health: false, chatWatcher: false, automations: false } }) }).get('work')).state).toBe('moduleOff')
    expect((await service({ connections: [], profile: profile({ connections: {} }) }).get('work')).state).toBe('noConnection')
    expect((await service({}).get('work')).state).toBe('incomplete')
    expect((await service({ secrets: { 'connection/es': 'k' }, profile: profile({ health: { refreshMinutes: 15, environments: [] } }) }).get('work')).state).toBe('noEnvironments')
    expect((await service({ connections: [{ ...elastic, provider: 'sentry' }], secrets: { 'connection/es': 'k' } }).get('work')).state).toBe('unsupported')
  })

  it('reads a configured cluster once and answers from its cache until the interval passes', async () => {
    const c = cluster()
    let now = 1_000_000
    const s = service({ secrets: { 'connection/es': 'k' }, http: c.http, now: () => now })
    const first = await s.get('work')
    expect(first.state).toBe('ready')
    expect(first.environments).toHaveLength(1)
    const reads = c.calls.length
    expect(reads).toBeGreaterThan(0)
    now += 5 * 60_000
    await s.get('work')
    expect(c.calls.length).toBe(reads)
    now += 15 * 60_000
    await s.get('work')
    expect(c.calls.length).toBeGreaterThan(reads)
  })

  it('never reads more often than every 30 seconds, even when forced', async () => {
    const c = cluster()
    let now = 1_000_000
    const s = service({ secrets: { 'connection/es': 'k' }, http: c.http, now: () => now })
    await s.get('work')
    const reads = c.calls.length
    now += HEALTH_MIN_GAP_MS - 1
    await s.get('work', true)
    expect(c.calls.length).toBe(reads)
    now += 2
    await s.get('work', true)
    expect(c.calls.length).toBeGreaterThan(reads)
  })

  it('reads again at once when the connection or the environments change', async () => {
    const c = cluster()
    const secrets = { 'connection/es': 'k' }
    const config: WorkhubConfig = { ...emptyConfig(), connections: [elastic], profiles: [profile()], activeProfileId: 'work' }
    const store: SecretStore = { get: async (ref) => (secrets as Record<string, string>)[ref] ?? null, set: async () => {}, delete: async () => {}, has: async () => true }
    const s = new HealthService({ configuration: { current: async () => config } as never, secrets: store, demo: false, httpFor: () => c.http })
    await s.get('work')
    const reads = c.calls.length
    config.profiles = [profile({ health: { refreshMinutes: 15, environments: [{ ...env, name: 'Renamed' }] } })]
    expect((await s.get('work')).environments[0]?.name).toBe('Renamed')
    expect(c.calls.length).toBeGreaterThan(reads)
  })

  it('turns an unreachable cluster into an unreachable verdict, not zeros', async () => {
    const s = service({ secrets: { 'connection/es': 'k' }, http: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND es.example.test')) })
    const view = await s.get('work')
    expect(view.environments[0]?.snapshot.state).toBe('unreachable')
  })

  it('adds Kibana links per service and for the environment', async () => {
    const s = service({ secrets: { 'connection/es': 'k' } })
    const view = await s.get('work')
    const e = view.environments[0]!
    expect(e.kibanaUrl).toContain('https://kibana.example.test/app/apm/services')
    expect(e.serviceUrls['api']).toContain('/app/apm/services/api/overview')
  })

  it('serves synthetic environments in demo mode with no connection or secret', async () => {
    const view = await service({ demo: true, connections: [], profile: profile({ connections: {}, health: undefined }) }).get('work')
    expect(view.state).toBe('demo')
    expect(view.environments.map((e) => [e.id, e.snapshot.state])).toEqual([
      ['production', 'healthy'],
      ['staging', 'blind'],
      ['develop', 'degraded']
    ])
  })

  it('tests a typed connection with the typed secret and never sends it anywhere else', async () => {
    const c = cluster()
    const s = service({ http: c.http, connections: [] })
    const ok = await s.test(elastic, { action: 'set', value: 'typed-key' }, 'errors-*')
    expect(ok).toEqual({ ok: true, account: '7 documents in errors-*' })
    expect(c.calls[0]?.headers['Authorization']).toBe('ApiKey typed-key')
    const missing = await s.test(elastic, { action: 'keep' })
    expect(missing.ok).toBe(false)
  })
})
