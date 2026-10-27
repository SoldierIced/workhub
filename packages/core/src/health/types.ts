/**
 * Environment health (PLAN section 4, `HealthProvider`): the domain every health provider fills
 * and the Health screen reads. Nothing here is specific to a company, a cluster or an index name:
 * all of that comes from the profile's configuration.
 */

/** Limits that turn raw numbers into a state. All are tunable; the defaults are starting points. */
export interface HealthThresholds {
  /** Rolling window of the "errors" count, in hours. */
  errorWindowHours: number
  /** Days of history behind the trend verdict (new / worsening / ongoing / chronic). */
  trendWindowDays: number
  /** A new or worsening error signal counts toward `degraded` only from this many errors. */
  minErrorsToFlag: number
  /** Container restarts inside `restartWindowMinutes` that flag a pod. */
  restartsToFlag: number
  restartWindowMinutes: number
  /** A service whose agent metrics are older than this "stopped reporting". */
  silentAfterMinutes: number
  /** Whether a service that stopped reporting makes the environment `degraded` (it is always listed). */
  silentServicesDegrade: boolean
  /** Slow flows: the window, the minimum calls to count a transaction and the list length. */
  slowFlowHours: number
  slowFlowMinCalls: number
  slowFlowCount: number
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  errorWindowHours: 24,
  trendWindowDays: 14,
  minErrorsToFlag: 10,
  restartsToFlag: 3,
  restartWindowMinutes: 15,
  silentAfterMinutes: 10,
  silentServicesDegrade: false,
  slowFlowHours: 24,
  slowFlowMinCalls: 50,
  slowFlowCount: 10
}

/** Allowed range of each threshold; the settings form and the config schema clamp to it. */
export const HEALTH_THRESHOLD_RANGES: Record<Exclude<keyof HealthThresholds, 'silentServicesDegrade'>, readonly [number, number]> = {
  errorWindowHours: [1, 168],
  trendWindowDays: [2, 30],
  minErrorsToFlag: [1, 100_000],
  restartsToFlag: [1, 1000],
  restartWindowMinutes: [5, 240],
  silentAfterMinutes: [2, 1440],
  slowFlowHours: [1, 168],
  slowFlowMinCalls: [1, 1_000_000],
  slowFlowCount: [1, 50]
}

/** The APM data streams. They are shared by every environment of a cluster (`service.environment` splits them). A blank entry turns that signal off. */
export interface ApmIndices {
  /** Error documents (`processor.event: error`). */
  errors: string
  /** Transactions and spans. */
  traces: string
  /** Agent metrics: they prove a service is still reporting. */
  metrics: string
}

/** Elastic's stock data stream names for APM Server 8+, with the namespace as a wildcard. Offered as a starting point only. */
export const ELASTIC_STOCK_APM: ApmIndices = { errors: 'logs-apm.error-*', traces: 'traces-apm-*', metrics: 'metrics-apm.internal-*' }

/** One environment to watch ("develop", "production"...). */
export interface HealthEnvironment {
  /** Stable key inside the profile. */
  id: string
  name: string
  /** Values of `service.environment` that belong to it (services do not tag consistently: `prod` and `production`). */
  apmEnvironments: string[]
  /** Namespace of the Kubernetes data streams; blank turns the Kubernetes signals off. */
  k8sIndexSuffix: string
  /** Whether the environment is expected to ship kube-state metrics. */
  hasKubeState: boolean
  apm: ApmIndices
  /** Base URL of Kibana for deep links; blank hides the links. */
  kibanaUrl: string
  thresholds: HealthThresholds
}

/** Settings keys of a `health` connection (Elastic APM); the secret (API key or password) is in the SecretStore. */
export const HEALTH_CONNECTION_SETTINGS = { auth: 'auth', username: 'username', tls: 'tls', fingerprint: 'tlsFingerprint' } as const
/** How to authenticate against Elasticsearch, and how its TLS certificate is validated. */
export type HealthAuthMode = 'apiKey' | 'basic'
export type HealthTlsMode = 'system' | 'pinned' | 'insecure'

/** The Health module setup of one profile. The cluster URL and credentials live in its `health` connection. */
export interface HealthSettings {
  /** Minutes between refreshes: 5 to 60. */
  refreshMinutes: number
  environments: HealthEnvironment[]
}

export const HEALTH_REFRESH_CHOICES = [5, 10, 15, 30, 60] as const
export const MIN_HEALTH_REFRESH_MINUTES = 5
export const MAX_HEALTH_REFRESH_MINUTES = 60
export const DEFAULT_HEALTH_REFRESH_MINUTES = 15

export const EMPTY_HEALTH_SETTINGS: HealthSettings = { refreshMinutes: DEFAULT_HEALTH_REFRESH_MINUTES, environments: [] }

/** How a signal compares with its own history. Declared in the order the lists sort them. */
export type TrendState = 'new' | 'worsening' | 'ongoing' | 'chronic'
export const TREND_ORDER: readonly TrendState[] = ['new', 'worsening', 'ongoing', 'chronic']

export interface TrendStats {
  /** Documents in the rolling window. */
  recent: number
  /** Median of the complete previous days that had any. */
  typicalDay: number
  /** Consecutive days, ending today, with activity. */
  streakDays: number
  /** The streak reaches the start of the history, so it may be longer. */
  streakTruncated: boolean
  daysWithData: number
  state: TrendState
}

export interface ServiceErrorCount {
  service: string
  stats: TrendStats
}

export interface K8sEvent {
  reason: string
  stats: TrendStats
  message?: string
  object?: string
  objectKind?: string
  /** Epoch milliseconds. */
  lastSeen?: number
}

export type PodKind = 'crashLoop' | 'notReady' | 'restarting'

export interface PodIssue {
  pod: string
  notReady: boolean
  /** Cumulative container restarts. */
  restarts: number
  /** Restarts inside the restart window. */
  recentRestarts: number
  /** A `BackOff` warning event for this pod in the window. */
  backOff: boolean
  kind: PodKind
}

export interface ServiceReporting {
  service: string
  /** Epoch milliseconds of its last agent metric. */
  lastSeen: number
  silentMinutes: number
  isReporting: boolean
}

export interface SlowTransaction {
  service: string
  name: string
  type?: string
  calls: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  /** 0 to 1. */
  failureRate: number
}

/** A kind of read, so a provider can be asked for only what is due. */
export type HealthTier = 'fast' | 'trend' | 'slow'

/** The signals the verdict is made of; a failure is kept per signal. */
export type HealthSignal = 'errors' | 'events' | 'pods' | 'reporting' | 'slow'
export const HEALTH_SIGNALS: readonly HealthSignal[] = ['errors', 'events', 'pods', 'reporting', 'slow']

/** Whether Kubernetes metrics (kube-state) are available. */
export type PodVisibility = 'visible' | 'missing' | 'notExpected'

/** Everything read for one environment, as the tiers last filled it. */
export interface HealthSignals {
  errors: ServiceErrorCount[]
  events: K8sEvent[]
  /** Pods running but not ready. */
  notReady: PodIssue[]
  restarts: PodIssue[]
  backOff: PodIssue[]
  reporting: ServiceReporting[]
  slow: SlowTransaction[]
  podVisibility: PodVisibility
  /** Why a signal could not be read. */
  failures: Partial<Record<HealthSignal, string>>
  /** Epoch milliseconds per tier. */
  fastFetchedAt?: number
  trendFetchedAt?: number
  slowFetchedAt?: number
}

export function emptySignals(): HealthSignals {
  return { errors: [], events: [], notReady: [], restarts: [], backOff: [], reporting: [], slow: [], podVisibility: 'notExpected', failures: {} }
}

export type HealthState = 'healthy' | 'degraded' | 'blind' | 'unreachable'

/** Why an environment is degraded, as data so each language words it. */
export type HealthReasonCode = 'podsNotReady' | 'podsCrashLooping' | 'podsRestarting' | 'errorsNew' | 'errorsWorsening' | 'servicesSilent'
export interface HealthReason {
  code: HealthReasonCode
  count: number
}

/** A part of the picture that is missing: a healthy verdict is never claimed without it. */
export type BlindSpotCode = 'notReadYet' | 'noPodMetrics' | 'noKubernetesSuffix' | 'noKubeState' | 'apmOff' | 'errorsOff' | 'unread' | 'connection'
export interface BlindSpot {
  code: BlindSpotCode
  signal?: HealthSignal
  /** The reason a read failed. */
  detail?: string
}

export interface HealthSnapshot {
  environmentId: string
  state: HealthState
  podVisibility: PodVisibility
  reasons: HealthReason[]
  blindSpots: BlindSpot[]
  /** Errors per service, new first, chronic last, then the larger count. */
  errorServices: ServiceErrorCount[]
  pods: PodIssue[]
  events: K8sEvent[]
  silentServices: ServiceReporting[]
  reportingServiceCount: number
  slow: SlowTransaction[]
  fetchedAt?: number
  trendFetchedAt?: number
  slowFetchedAt?: number
  /** Why the state is `unreachable`. */
  errorMessage?: string
  /** The last refresh failed and the figures are from an earlier one. */
  stale: boolean
}

/** Every provider failure that affects the whole connection (DNS, certificate, credentials), so the remaining queries are skipped. */
export class HealthConnectionError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'untrustedCertificate' | 'unauthorized' | 'notConfigured' = 'unreachable'
  ) {
    super(message)
    this.name = 'HealthConnectionError'
  }
}
