import { createHash } from 'node:crypto'
import {
  DemoHealthProvider,
  DEMO_HEALTH_SETTINGS,
  ElasticClient,
  ElasticHealthProvider,
  createElasticTransport,
  isFingerprint,
  kibanaEnvironmentUrl,
  kibanaServiceUrl,
  usernameProblem,
  type TlsPolicy
} from '@workhub/adapters/health-elastic'
import type { HttpClient } from '@workhub/adapters/http'
import {
  connectionSecretRef,
  DEFAULT_HEALTH_REFRESH_MINUTES,
  HEALTH_CONNECTION_SETTINGS,
  moduleScreens,
  pendingSnapshot,
  refreshEnvironment,
  type ConfigurationService,
  type Connection,
  type ConnectionTest,
  type EnvironmentReading,
  type HealthEnvironment,
  type HealthProvider,
  type HealthTlsMode,
  type SecretChange,
  type SecretStore
} from '@workhub/core'
import type { HealthEnvironmentView, HealthState, HealthView } from '../shared/health-api'

/** The least time between two real reads of a profile, however often the screen asks. */
export const HEALTH_MIN_GAP_MS = 30_000

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
}

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

  private async load(profileId: string | null, force: boolean): Promise<HealthView> {
    const config = await this.deps.configuration.current()
    const profile = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId))
    const refreshMinutes = profile?.health?.refreshMinutes ?? DEFAULT_HEALTH_REFRESH_MINUTES
    const view = (state: HealthState, extra: Partial<HealthView> = {}): HealthView => ({ state, refreshMinutes, environments: [], ...extra })
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
      cached = { key, at: 0, byEnv: new Map() }
      this.cache.set(profile.id, cached)
    }
    const age = this.now() - cached.at
    const due = cached.at === 0 || age >= refreshMinutes * 60_000 || (force && age >= HEALTH_MIN_GAP_MS)
    const state: HealthState = this.deps.demo ? 'demo' : 'ready'
    if (due) {
      const now = this.now()
      const target = cached
      const results = await Promise.all(environments.map((env) => refreshEnvironment(provider, env, target.byEnv.get(env.id), now)))
      environments.forEach((env, i) => target.byEnv.set(env.id, results[i]!))
      target.at = now
    }
    return view(state, { connectionName, updatedAt: cached.at || undefined, environments: environments.map((env) => this.viewOf(env, cached!)) })
  }

  private viewOf(env: HealthEnvironment, cached: Cached): HealthEnvironmentView {
    const snapshot = cached.byEnv.get(env.id)?.snapshot ?? pendingSnapshot(env.id)
    const services = new Set([...snapshot.errorServices.map((e) => e.service), ...snapshot.silentServices.map((s) => s.service), ...snapshot.slow.map((t) => t.service)])
    const serviceUrls: Record<string, string> = {}
    for (const service of services) {
      const url = kibanaServiceUrl(env, service, env.thresholds.errorWindowHours)
      if (url) serviceUrls[service] = url
    }
    return {
      id: env.id,
      name: env.name,
      snapshot,
      kibanaUrl: kibanaEnvironmentUrl(env, env.thresholds.errorWindowHours),
      serviceUrls,
      slowFlowHours: env.thresholds.slowFlowHours,
      errorWindowHours: env.thresholds.errorWindowHours
    }
  }

  /** Checks a connection as typed in the form: one `_count`, with the typed or the stored secret. */
  async test(connection: Connection, change: SecretChange, indexToProbe?: string): Promise<ConnectionTest> {
    if (this.deps.demo) return new DemoHealthProvider().test()
    const ref = connection.secretRef ?? connectionSecretRef(connection.id)
    const secret = change.action === 'set' ? change.value : change.action === 'keep' ? await this.deps.secrets.get(ref) : null
    const built = buildHealthProvider(connection, secret, indexToProbe, this.deps.httpFor)
    if ('missing' in built) {
      if (built.missing === 'unsupported') return { ok: false, error: 'This health provider is not supported yet' }
      return { ok: false, error: `The ${built.detail ?? 'connection'} is missing or invalid` }
    }
    return built.provider.test()
  }
}
