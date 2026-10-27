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
/** "Never more often than": app-wide, it also holds Refresh back so a shared cluster is not overloaded (Workhub 1's choices). */
export const HEALTH_FLOOR_CHOICES = [1, 2, 5, 10] as const
export const DEFAULT_HEALTH_FLOOR_MINUTES = 5

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

/** Any other keyed signal with a trend: a container writing to stderr. */
export interface SignalTrend {
  key: string
  stats: TrendStats
  /** The Kubernetes namespace most of its documents come from (container stderr only). */
  namespace?: string
}

// On-demand details: read when a row is expanded or investigated, never polled ---------------------

/** One APM error group (`error.grouping_key`) of a service: errors with the same exception and code path. */
export interface ErrorGroup {
  groupingKey: string
  exceptionType?: string
  /** The exception message, or the logged message of an error without an exception; one line, clipped. */
  message?: string
  culprit?: string
  /** The most common `transaction.name` in the window. */
  endpoint?: string
  /** Errors in the rolling window. */
  recent: number
  /** Errors over the trend window. */
  total: number
  /** Epoch milliseconds, inside the trend window. */
  firstSeen?: number
  lastSeen?: number
  /** Days with errors of this group, out of the days of the trend window. */
  activeDays: number
  daysWithData: number
  typicalDay: number
  /** First seen inside the rolling window: it did not exist before. */
  isNew: boolean
  /** Kibana page of the group; set by the app, null without a Kibana URL. */
  kibanaUrl?: string | null
}

/** The top error groups of one service, most errors in the window first. */
export interface ServiceErrorDetails {
  service: string
  groups: ErrorGroup[]
  fetchedAt: number
}

/** The container status of a pod (`state_container`), for the container with the most restarts. */
export interface PodStatus {
  container?: string
  namespace?: string
  /** Why the container is waiting right now (`CrashLoopBackOff`, `ImagePullBackOff`...). */
  waitingReason?: string
  /** How its previous run ended (`OOMKilled`, `Error`, `Completed`...). */
  lastTerminatedReason?: string
  lastExitCode?: number
  /** Epoch milliseconds. */
  lastTerminatedAt?: number
}

/** One Kubernetes warning reason about one pod, with its latest occurrence. */
export interface PodEvent {
  reason: string
  message?: string
  lastSeen?: number
  /** Event documents in the window. */
  count: number
  /** Kubernetes' own counter of the latest event (`kubernetes.event.count`). */
  occurrences?: number
}

/** One line a container wrote, trimmed. */
export interface LogLine {
  timestamp?: number
  container?: string
  text: string
}

/** What an expanded pod row shows. Each part is read on its own; one that fails says why and the others still show. */
export interface PodDetails {
  pod: string
  status?: PodStatus
  events: PodEvent[]
  eventsError?: string
  /** Oldest first. */
  stderr: LogLine[]
  stderrError?: string
  fetchedAt: number
}

/** Where the time of a slow transaction goes: spans grouped by destination. */
export interface SpanBreakdown {
  /** `span.destination.service.resource` (a database, a host:port), or the span type when absent. */
  resource: string
  type: string
  subtype?: string
  calls: number
  totalMs: number
  averageMs: number
  /** Calls per sampled transaction: well above 1 for a chatty loop (N+1). */
  callsPerTransaction: number
  /** Total span time over total wall time of the sampled transactions; above 1 the calls ran in parallel. */
  shareOfWallTime: number
}

/** One side of a window comparison. */
export interface WindowStats {
  errors: number
  transactions: number
  failedTransactions: number
  p95Ms?: number
}

/** An error type (`error.grouping_key`) first seen inside the current window. */
export interface NewErrorType {
  groupingKey: string
  exceptionType?: string
  culprit?: string
  firstSeen: number
  count: number
}

/** Why a window is worse than the one before it, as data so each language words it. */
export type WindowRegression =
  | { code: 'errors'; before: number; after: number }
  | { code: 'failureRate'; before: number; after: number }
  | { code: 'latency'; before: number; after: number }
  | { code: 'newErrorTypes'; count: number }

export type WindowVerdict = { kind: 'clean' } | { kind: 'regressed'; reasons: WindowRegression[] } | { kind: 'noSignal' }

/** The current window of a flow against the window of the same length before it. */
export interface WindowComparison {
  service: string
  /** Null compares the whole service. */
  transaction: string | null
  windowHours: number
  previous: WindowStats
  current: WindowStats
  newErrorTypes: NewErrorType[]
}

/** The span breakdown of a slow flow's slowest executions and its window comparison. */
export interface FlowDetails {
  service: string
  name: string
  /** Transactions behind `spans` (the slowest ones) and their summed duration. */
  sampledTransactions: number
  sampledWallMs: number
  /** Largest total first. */
  spans: SpanBreakdown[]
  spansError?: string
  comparison?: WindowComparison
  comparisonError?: string
  fetchedAt: number
}

/** What a row can ask the provider for. */
export type HealthDetailRequest = { kind: 'errors'; service: string } | { kind: 'pod'; pod: string } | { kind: 'flow'; service: string; name: string }

/** A kind of read, so a provider can be asked for only what is due. */
export type HealthTier = 'fast' | 'trend' | 'slow'

/** The signals the verdict is made of; a failure is kept per signal. */
export type HealthSignal = 'errors' | 'events' | 'pods' | 'reporting' | 'slow' | 'stderr'
export const HEALTH_SIGNALS: readonly HealthSignal[] = ['errors', 'events', 'pods', 'reporting', 'slow', 'stderr']

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
  /** stderr volume per container, read only while pod metrics are not visible. */
  stderr: SignalTrend[]
  podVisibility: PodVisibility
  /** Why a signal could not be read. */
  failures: Partial<Record<HealthSignal, string>>
  /** Epoch milliseconds per tier. */
  fastFetchedAt?: number
  trendFetchedAt?: number
  slowFetchedAt?: number
}

export function emptySignals(): HealthSignals {
  return { errors: [], events: [], notReady: [], restarts: [], backOff: [], reporting: [], slow: [], stderr: [], podVisibility: 'notExpected', failures: {} }
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
  /** stderr per container while pod metrics are not visible: a rough proxy, never a verdict. */
  containerStderr: SignalTrend[]
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
