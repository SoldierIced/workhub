import { createHash } from 'node:crypto'
import {
  DemoHealthProvider,
  DEMO_HEALTH_SETTINGS,
  ElasticClient,
  ElasticHealthProvider,
  createElasticTransport,
  isFingerprint,
  kibanaDiscoverUrl,
  kibanaEnvironmentUrl,
  kibanaErrorGroupUrl,
  kibanaServiceErrorsUrl,
  kibanaServiceUrl,
  usernameProblem,
  type TlsPolicy
} from '@workhub/adapters/health-elastic'
import type { HttpClient } from '@workhub/adapters/http'
import {
  appOptions,
  secretForConnectionTest,
  DEFAULT_HEALTH_REFRESH_MINUTES,
  HEALTH_CONNECTION_SETTINGS,
  moduleScreens,
  pendingSnapshot,
  refreshEnvironment,
  type ConfigurationService,
  type Connection,
  type ConnectionTest,
  type EnvironmentReading,
  type HealthDetailRequest,
  type HealthEnvironment,
  type HealthProvider,
  type HealthTlsMode,
  type SecretChange,
  type SecretStore
} from '@workhub/core'
import type { HealthDetail, HealthDetailResult, HealthEnvironmentView, HealthState, HealthView } from '../shared/health-api'

/** The least time between two real reads of a profile or of one row's details, however often the screen asks. */
export const HEALTH_MIN_GAP_MS = 30_000
/** A read that failed at the connection (VPN down, refused credentials) may be retried this soon. */
export const HEALTH_RETRY_GAP_MS = 5_000
/** How long the details of an expanded row stay valid; its refresh button reads them again. */
export const HEALTH_DETAIL_LIFETIME_MS = 10 * 60_000

export type BuiltProvider = { provider: HealthProvider } | { missing: 'unsupported' | 'incomplete'; detail?: 'url' | 'user' | 'secret' | 'fingerprint' }

/** The TLS policy a health connection stores. */
export function tlsOf(connection: Connection): TlsPolicy {
  const raw = connection.settings[HEALTH_CONNECTION_SETTINGS.tls]
  const mode: HealthTlsMode = raw === 'pinned' || raw === 'insecure' ? raw : 'system'
  return { mode, fingerprint: connection.settings[HEALTH_CONNECTION_SETTINGS.fingerprint] }
}

/** Builds the provider of a saved or typed connection; `incomplete` names what is missing. */
export function buildHealthProvider(
  connection: Connection,
  secret: string | null,
  testIndex: string | undefined,
  httpFor: (tls: TlsPolicy) => HttpClient = createElasticTransport
): BuiltProvider {
  if (connection.provider !== 'elastic-apm') return { missing: 'unsupported' }
  if (!connection.endpoint?.trim()) return { missing: 'incomplete', detail: 'url' }
  const basic = connection.settings[HEALTH_CONNECTION_SETTINGS.auth] === 'basic'
  const username = connection.settings[HEALTH_CONNECTION_SETTINGS.username] ?? ''
  if (basic && usernameProblem(username)) return { missing: 'incomplete', detail: 'user' }
  if (!secret) return { missing: 'incomplete', detail: 'secret' }
  const tls = tlsOf(connection)
  if (tls.mode === 'pinned' && !isFingerprint(tls.fingerprint ?? '')) return { missing: 'incomplete', detail: 'fingerprint' }
  try {
    const client = new ElasticClient({
      baseUrl: connection.endpoint,
      auth: basic ? { mode: 'basic', username: username.trim(), secret } : { mode: 'apiKey', secret },
      http: httpFor(tls)
    })
    return { provider: new ElasticHealthProvider({ client, testIndex }) }
  } catch {
    return { missing: 'incomplete', detail: 'url' }
  }
}

interface Cached {
  key: string
  at: number
  byEnv: Map<string, EnvironmentReading>
  /** On-demand details by `<environment>|<kind>|<key>`; dropped with the figures when the setup changes. */
  details: Map<string, { at: number; run: Promise<HealthDetailResult> }>
}

type Resolved = { view: HealthView } | { profileId: string; provider: HealthProvider; environments: HealthEnvironment[]; cached: Cached; state: HealthState; connectionName?: string; refreshMinutes: number; floorMinutes: number }

/** The first configured index of an environment, for Test connection. */
const probeIndex = (env: HealthEnvironment | undefined) => env?.apm.errors.trim() || env?.apm.traces.trim() || env?.apm.metrics.trim() || undefined

export interface HealthServiceDeps {
  configuration: ConfigurationService
  secrets: SecretStore
  /** WORKHUB_DEMO_HEALTH=1: synthetic data instead of a cluster. */
  demo: boolean
  httpFor?: (tls: TlsPolicy) => HttpClient
  now?: () => number
}

/** Resolves the health provider of a profile, keeps what each environment last read and serves the Health screen. */
export class HealthService {
  private readonly cache = new Map<string, Cached>()
  private readonly inflight = new Map<string, Promise<HealthView>>()
  private readonly now: () => number

  constructor(private readonly deps: HealthServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  async get(profileId: string | null, force = false): Promise<HealthView> {
    const id = profileId ?? ''
    const running = this.inflight.get(id)
    if (running) return running
    const run = this.load(profileId, force).finally(() => this.inflight.delete(id))
    this.inflight.set(id, run)
    return run
  }

  /** The provider, environments and cache of a profile, or the view that says why there are none. */
  private async resolve(profileId: string | null): Promise<Resolved> {
    const config = await this.deps.configuration.current()
    const profile = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId))
    const refreshMinutes = profile?.health?.refreshMinutes ?? DEFAULT_HEALTH_REFRESH_MINUTES
    const view = (state: HealthState, extra: Partial<HealthView> = {}): Resolved => ({ view: { state, refreshMinutes, environments: [], ...extra } })
    if (!profile || !moduleScreens(profile.modules).includes('health')) return view('moduleOff')

    const configured = profile.health?.environments ?? []
    const connection = config.connections.find((c) => c.id === profile.connections.health)
    const connectionName = connection ? connection.name || connection.id : undefined

    let provider: HealthProvider
    let environments = configured
    let secretHash = ''
    if (this.deps.demo) {
      provider = new DemoHealthProvider()
      if (environments.length === 0) environments = DEMO_HEALTH_SETTINGS.environments
    } else {
      if (!connection) return view('noConnection')
      const secret = connection.secretRef ? await this.deps.secrets.get(connection.secretRef) : null
      const built = buildHealthProvider(connection, secret, probeIndex(configured[0]), this.deps.httpFor)
      if ('missing' in built) return view(built.missing, { connectionName })
      if (configured.length === 0) return view('noEnvironments', { connectionName })
      provider = built.provider
      secretHash = createHash('sha256').update(secret ?? '').digest('hex')
    }

    // Anything that changes what is read (connection, secret, environments) drops the old figures.
    const key = JSON.stringify([connection?.id, connection?.endpoint, connection?.settings, secretHash, environments])
    let cached = this.cache.get(profile.id)
    if (!cached || cached.key !== key) {
      cached = { key, at: 0, byEnv: new Map(), details: new Map() }
      this.cache.set(profile.id, cached)
    }
    const state: HealthState = this.deps.demo ? 'demo' : 'ready'
    return { profileId: profile.id, provider, environments, cached, state, connectionName, refreshMinutes, floorMinutes: appOptions(config).healthRefreshFloorMinutes }
  }

  private async load(profileId: string | null, force: boolean): Promise<HealthView> {
    const r = await this.resolve(profileId)
    if ('view' in r) return r.view
    const { provider, environments, cached, refreshMinutes } = r
    const age = this.now() - cached.at
    // A forced read still waits for the floor: a shared cluster is not read on every click. A read
    // that never reached the cluster cost it nothing, so Retry after a failure is honoured quickly.
    const failed = [...cached.byEnv.values()].some((reading) => reading.snapshot.state === 'unreachable')
    const floor = failed ? HEALTH_RETRY_GAP_MS : Math.max(HEALTH_MIN_GAP_MS, r.floorMinutes * 60_000)
    const due = cached.at === 0 || age >= refreshMinutes * 60_000 || (force && age >= floor)
    if (due) {
      const now = this.now()
      const results = await Promise.all(environments.map((env) => refreshEnvironment(provider, env, cached.byEnv.get(env.id), now)))
      environments.forEach((env, i) => cached.byEnv.set(env.id, results[i]!))
      cached.at = now
    }
    return { state: r.state, refreshMinutes, connectionName: r.connectionName, updatedAt: cached.at || undefined, environments: environments.map((env) => this.viewOf(env, cached)) }
  }

  /**
   * The details of one row, from the cache while they are younger than `HEALTH_DETAIL_LIFETIME_MS`.
   * Two callers asking at once share one read. A failure is answered, never thrown, and never
   * touches the environment's snapshot.
   */
  async details(profileId: string | null, environmentId: string, request: HealthDetailRequest, force = false): Promise<HealthDetailResult> {
    const r = await this.resolve(profileId)
    if ('view' in r) return { ok: false, error: 'Health is not set up for this profile' }
    const env = r.environments.find((e) => e.id === environmentId)
    if (!env) return { ok: false, error: 'This environment is no longer configured' }
    const key = `${env.id}|${request.kind}|${request.kind === 'errors' ? request.service : request.kind === 'pod' ? request.pod : `${request.service}|${request.name}`}`
    const now = this.now()
    const hit = r.cached.details.get(key)
    if (hit && (now - hit.at < (force ? HEALTH_MIN_GAP_MS : HEALTH_DETAIL_LIFETIME_MS))) return hit.run
    const run = this.readDetail(r.provider, env, request, now)
    r.cached.details.set(key, { at: now, run })
    // A failure is not kept: the next ask tries again.
    void run.then((result) => {
      if (!result.ok && r.cached.details.get(key)?.run === run) r.cached.details.delete(key)
    })
    return run
  }

  private async readDetail(provider: HealthProvider, env: HealthEnvironment, request: HealthDetailRequest, now: number): Promise<HealthDetailResult> {
    try {
      let value: HealthDetail | undefined
      if (request.kind === 'errors' && provider.errorDetails) {
        const details = await provider.errorDetails(env, request.service, now)
        const hours = env.thresholds.errorWindowHours
        value = { ...details, groups: details.groups.map((g) => ({ ...g, kibanaUrl: kibanaErrorGroupUrl(env, request.service, g.groupingKey, hours) })) }
      } else if (request.kind === 'pod' && provider.podDetails) value = await provider.podDetails(env, request.pod, now)
      else if (request.kind === 'flow' && provider.flowDetails) value = await provider.flowDetails(env, request.service, request.name, now)
      return value ? { ok: true, value } : { ok: false, error: 'This health provider has no details' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private viewOf(env: HealthEnvironment, cached: Cached): HealthEnvironmentView {
    const snapshot = cached.byEnv.get(env.id)?.snapshot ?? pendingSnapshot(env.id)
    const services = new Set([...snapshot.errorServices.map((e) => e.service), ...snapshot.silentServices.map((s) => s.service), ...snapshot.slow.map((t) => t.service)])
    const hours = env.thresholds.errorWindowHours
    const serviceUrls: Record<string, string> = {}
    for (const service of services) {
      const url = kibanaServiceUrl(env, service, hours)
      if (url) serviceUrls[service] = url
    }
    const errorUrls: Record<string, string> = {}
    for (const e of snapshot.errorServices) {
      const url = kibanaServiceErrorsUrl(env, e.service, hours)
      if (url) errorUrls[e.service] = url
    }
    const podUrls: Record<string, string> = {}
    for (const p of snapshot.pods) {
      const url = kibanaDiscoverUrl(env, 'kubernetes.pod.name', p.pod, hours)
      if (url) podUrls[p.pod] = url
    }
    return {
      id: env.id,
      name: env.name,
      snapshot,
      kibanaUrl: kibanaEnvironmentUrl(env, env.thresholds.errorWindowHours),
      serviceUrls,
      errorUrls,
      podUrls,
      slowFlowHours: env.thresholds.slowFlowHours,
      errorWindowHours: env.thresholds.errorWindowHours,
      thresholds: env.thresholds,
      hasKubeState: env.hasKubeState,
      k8sIndexSuffix: env.k8sIndexSuffix.trim()
    }
  }

  /** Checks a connection as typed in the form: one `_count`, with the typed or the stored secret. */
  async test(connection: Connection, change: SecretChange, indexToProbe?: string): Promise<ConnectionTest> {
    if (this.deps.demo) return new DemoHealthProvider().test()
    const resolved = await secretForConnectionTest(await this.deps.configuration.current(), this.deps.secrets, connection, change)
    if (!resolved.ok) return resolved
    const { secret } = resolved
    const built = buildHealthProvider(connection, secret, indexToProbe, this.deps.httpFor)
    if ('missing' in built) {
      if (built.missing === 'unsupported') return { ok: false, error: 'This health provider is not supported yet' }
      return { ok: false, error: `The ${built.detail ?? 'connection'} is missing or invalid` }
    }
    return built.provider.test()
  }
}
