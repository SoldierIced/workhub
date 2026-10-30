import { createHash } from 'node:crypto'
import { basename } from 'node:path'
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
  type FlowMap,
  type FlowTraceSort,
  type HealthDetailRequest,
  type HealthEnvironment,
  type HealthProvider,
  type HealthTlsMode,
  type SecretChange,
  type SecretStore
} from '@workhub/core'
import type { FlowMapResult, FlowMapSummary, FlowTraceLogsResult, FlowTraceResult, FlowTracesResult, HealthDetail, HealthDetailResult, HealthEnvironmentView, HealthState, HealthView } from '../shared/health-api'
import { flowMapSummaries, readFlowMapFiles } from './flow-maps'

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
  /** Flow-map readings by `<environment>|<map id>|<hours>|<map hash>`, kept like the details. */
  flowMaps: Map<string, { at: number; run: Promise<FlowMapResult> }>
  /** Executions laid over a map by `<environment>|<map id>|<trace id>`, kept like the details. */
  flowTraces: Map<string, { at: number; run: Promise<FlowTraceResult> }>
}

/** How many executions the list shows. */
export const FLOW_TRACE_LIST_SIZE = 50
/** Log lines and errors read for one execution. */
const FLOW_TRACE_LOG_SIZE = 200

/** The window of a flow-map reading: an hour to a week. */
export const FLOW_MAP_HOURS = { min: 1, max: 24 * 7, default: 24 }

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
  /** The folder of the flow-map files; no flow maps without it. */
  flowMapsDir?: string
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
      cached = { key, at: 0, byEnv: new Map(), details: new Map(), flowMaps: new Map(), flowTraces: new Map() }
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

  /** The flow-map files, for the lists (the screen and Settings); none without a folder. */
  async flowMaps(_profileId: string | null): Promise<FlowMapSummary[]> {
    if (!this.deps.flowMapsDir) return []
    return flowMapSummaries(readFlowMapFiles(this.deps.flowMapsDir))
  }

  /**
   * One map measured on an environment, from the cache while the reading is younger than
   * `HEALTH_DETAIL_LIFETIME_MS`; the file is read every time, so an edited map reads again at once.
   */
  async flowMap(profileId: string | null, environmentId: string, mapId: string, hours: number, force = false): Promise<FlowMapResult> {
    if (!this.deps.flowMapsDir) return { ok: false, error: 'Flow maps are not available' }
    const file = readFlowMapFiles(this.deps.flowMapsDir).find((f) => f.map?.id === mapId || (!f.map && basename(f.file) === `${mapId}.json`))
    if (!file) return { ok: false, error: 'This flow map is no longer in the folder' }
    if (!file.map) return { ok: false, error: `The flow map file is invalid: ${file.error ?? 'unreadable'}` }
    const map = file.map
    const r = await this.resolve(profileId)
    if ('view' in r) return { ok: false, error: 'Health is not set up for this profile' }
    const env = r.environments.find((e) => e.id === environmentId)
    if (!env) return { ok: false, error: 'This environment is no longer configured' }
    if (!r.provider.flowMap) return { ok: true, map }
    const window = Math.min(FLOW_MAP_HOURS.max, Math.max(FLOW_MAP_HOURS.min, Math.round(hours) || FLOW_MAP_HOURS.default))
    const key = `${env.id}|${map.id}|${window}|${createHash('sha256').update(JSON.stringify(map)).digest('hex').slice(0, 12)}`
    const now = this.now()
    const hit = r.cached.flowMaps.get(key)
    if (hit && now - hit.at < (force ? HEALTH_MIN_GAP_MS : HEALTH_DETAIL_LIFETIME_MS)) return hit.run
    const provider = r.provider
    const run: Promise<FlowMapResult> = provider
      .flowMap!(env, map, now, window)
      .then((reading): FlowMapResult => ({ ok: true, map, reading }))
      .catch((error: unknown): FlowMapResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    r.cached.flowMaps.set(key, { at: now, run })
    void run.then((result) => {
      if (!result.ok && r.cached.flowMaps.get(key)?.run === run) r.cached.flowMaps.delete(key)
    })
    return run
  }

  /** The map file and the environment a flow-map ask names, or the reason one of them is missing. */
  private async flowMapTarget(profileId: string | null, environmentId: string, mapId: string): Promise<{ ok: true; map: FlowMap; env: HealthEnvironment; provider: HealthProvider; cached: Cached } | { ok: false; error: string }> {
    if (!this.deps.flowMapsDir) return { ok: false, error: 'Flow maps are not available' }
    const file = readFlowMapFiles(this.deps.flowMapsDir).find((f) => f.map?.id === mapId || (!f.map && basename(f.file) === `${mapId}.json`))
    if (!file) return { ok: false, error: 'This flow map is no longer in the folder' }
    if (!file.map) return { ok: false, error: `The flow map file is invalid: ${file.error ?? 'unreadable'}` }
    const r = await this.resolve(profileId)
    if ('view' in r) return { ok: false, error: 'Health is not set up for this profile' }
    const env = r.environments.find((e) => e.id === environmentId)
    if (!env) return { ok: false, error: 'This environment is no longer configured' }
    return { ok: true, map: file.map, env, provider: r.provider, cached: r.cached }
  }

  /** Recent executions of the map's entry transaction; not cached, the list is a handful of hits and the user asks for it. */
  async flowTraces(profileId: string | null, environmentId: string, mapId: string, hours: number, sort: FlowTraceSort): Promise<FlowTracesResult> {
    const t = await this.flowMapTarget(profileId, environmentId, mapId)
    if (!t.ok) return t
    if (!t.provider.flowTraces) return { ok: false, error: 'This provider cannot list executions' }
    const window = Math.min(FLOW_MAP_HOURS.max, Math.max(FLOW_MAP_HOURS.min, Math.round(hours) || FLOW_MAP_HOURS.default))
    const order: FlowTraceSort = sort === 'slowest' || sort === 'failed' ? sort : 'latest'
    try {
      return { ok: true, traces: await t.provider.flowTraces(t.env, t.map, this.now(), window, order, FLOW_TRACE_LIST_SIZE) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** One execution laid over the map, kept `HEALTH_DETAIL_LIFETIME_MS`: a trace does not change once written. */
  async flowTrace(profileId: string | null, environmentId: string, mapId: string, traceId: string): Promise<FlowTraceResult> {
    if (typeof traceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(traceId)) return { ok: false, error: 'This is not a trace id' }
    const t = await this.flowMapTarget(profileId, environmentId, mapId)
    if (!t.ok) return t
    if (!t.provider.flowTrace) return { ok: false, error: 'This provider cannot read an execution' }
    const key = `${t.env.id}|${t.map.id}|${traceId}|${createHash('sha256').update(JSON.stringify(t.map)).digest('hex').slice(0, 12)}`
    const now = this.now()
    const hit = t.cached.flowTraces.get(key)
    if (hit && now - hit.at < HEALTH_DETAIL_LIFETIME_MS) return hit.run
    const run: Promise<FlowTraceResult> = t.provider
      .flowTrace(t.env, t.map, traceId)
      .then((trace): FlowTraceResult => ({ ok: true, trace }))
      .catch((error: unknown): FlowTraceResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    t.cached.flowTraces.set(key, { at: now, run })
    void run.then((result) => {
      if (!result.ok && t.cached.flowTraces.get(key)?.run === run) t.cached.flowTraces.delete(key)
    })
    return run
  }

  /** The APM errors and log lines of one execution; not cached, a handful of hits the user asks for. */
  async flowTraceLogs(profileId: string | null, environmentId: string, mapId: string, traceId: string): Promise<FlowTraceLogsResult> {
    if (typeof traceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(traceId)) return { ok: false, error: 'This is not a trace id' }
    const t = await this.flowMapTarget(profileId, environmentId, mapId)
    if (!t.ok) return t
    if (!t.provider.flowTraceLogs) return { ok: false, error: 'This provider cannot read the logs of an execution' }
    try {
      return { ok: true, logs: await t.provider.flowTraceLogs(t.env, traceId, FLOW_TRACE_LOG_SIZE) }
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
