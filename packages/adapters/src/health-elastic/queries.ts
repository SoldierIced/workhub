import {
  median,
  trendStats,
  type ErrorGroup,
  type HealthEnvironment,
  type K8sEvent,
  type LogLine,
  type NewErrorType,
  type PodEvent,
  type PodIssue,
  type PodStatus,
  type ServiceErrorCount,
  type ServiceReporting,
  type SignalTrend,
  type SlowTransaction,
  type SpanBreakdown,
  type WindowComparison,
  type WindowStats
} from '@workhub/core'
import { at, clip, field, list, num, str, type Json } from './json'

/**
 * The read-only queries behind the Health screen. Every builder is pure: it turns an environment
 * into an `EsRequest` and never touches the network; every parser turns a response into core
 * types. Rules: every request is `size: 0` (or a handful of hits), ranges are narrow, APM
 * documents are always filtered by `service.environment`, and trends are measured against a daily
 * baseline instead of against yesterday. Index names are the data stream names configured for the
 * environment, never hard-coded.
 */

/** One Elasticsearch request: where to search and the body (for `_count` the body is the query). */
export interface EsRequest {
  index: string
  body: Record<string, unknown>
}

type Clause = Record<string, unknown>

/** Small builders for the clauses every query repeats. */
export const es = {
  /** `@timestamp >= expression`, an Elasticsearch date-math expression such as `now-15m`. */
  since: (expression: string): Clause => ({ range: { '@timestamp': { gte: expression } } }),
  term: (fieldName: string, value: string | number | boolean): Clause => ({ term: { [fieldName]: value } }),
  terms: (fieldName: string, values: string[]): Clause => ({ terms: { [fieldName]: values } }),
  filter: (clauses: Clause[]): Clause => ({ bool: { filter: clauses } }),
  /** `from <= @timestamp < to`, both epoch milliseconds. */
  between: (from: number, to: number): Clause => ({ range: { '@timestamp': { gte: from, lt: to, format: 'epoch_millis' } } }),
  /** An aggregation-only search: no hits, no total count. Both keep the load on the cluster down. */
  aggregations: (query: Clause, aggs: Record<string, unknown>): Record<string, unknown> => ({ size: 0, track_total_hits: false, query, aggs })
}

/** The `service.environment` values of an environment, trimmed and without blanks. */
export const apmEnvironmentValues = (env: Pick<HealthEnvironment, 'apmEnvironments'>): string[] => env.apmEnvironments.map((v) => v.trim()).filter(Boolean)

export const kubernetesSuffix = (env: Pick<HealthEnvironment, 'k8sIndexSuffix'>): string => env.k8sIndexSuffix.trim()

/** Whether APM errors can be read: service.environment values and an errors index. */
export const readsErrors = (env: HealthEnvironment): boolean => apmEnvironmentValues(env).length > 0 && env.apm.errors.trim() !== ''
export const readsTraces = (env: HealthEnvironment): boolean => apmEnvironmentValues(env).length > 0 && env.apm.traces.trim() !== ''
export const readsMetrics = (env: HealthEnvironment): boolean => apmEnvironmentValues(env).length > 0 && env.apm.metrics.trim() !== ''

/** Datasets of Elastic's Kubernetes integration; the namespace (the environment's suffix) follows. */
export const K8S_DATASETS = {
  statePod: 'metrics-kubernetes.state_pod',
  stateContainer: 'metrics-kubernetes.state_container',
  event: 'metrics-kubernetes.event',
  containerLogs: 'logs-kubernetes.container'
} as const

export const k8sIndex = (dataset: keyof typeof K8S_DATASETS, env: HealthEnvironment): string => `${K8S_DATASETS[dataset]}-${kubernetesSuffix(env)}`

// Trend model ----------------------------------------------------------------------------------

interface TrendOptions {
  index: string
  keyField: string
  filters: Clause[]
  windowDays: number
  recentHours: number
  limit: number
  extraAggs?: Record<string, unknown>
  /** Rank the keys by their rolling-window count instead of the whole window. */
  byRecent?: boolean
}

/**
 * Daily counts per key over `windowDays`, plus a rolling count over `recentHours` per key. The
 * rolling count is what gets compared: today's calendar bucket is partial and would make
 * everything look like it is improving.
 */
export function dailyTrend({ index, keyField, filters, windowDays, recentHours, limit, extraAggs = {}, byRecent = false }: TrendOptions): EsRequest {
  const perKey = {
    daily: { date_histogram: { field: '@timestamp', calendar_interval: 'day', min_doc_count: 0 } },
    recent: { filter: es.since(`now-${recentHours}h`) },
    ...extraAggs
  }
  const byKey = { terms: { field: keyField, size: limit, ...(byRecent ? { order: { recent: 'desc' } } : {}) }, aggs: perKey }
  return { index, body: es.aggregations(es.filter([es.since(`now-${windowDays}d/d`), ...filters]), { by_key: byKey }) }
}

/** The trend verdict of one `by_key` bucket; null when it had nothing in the rolling window. */
export function trendOfBucket(bucket: Json) {
  const daily = list(at(bucket, 'daily', 'buckets')).map((b) => num(at(b, 'doc_count')) ?? 0)
  return trendStats(daily, num(at(bucket, 'recent', 'doc_count')) ?? 0)
}

// Errors by service ----------------------------------------------------------------------------

/** APM errors per `service.name` for the environment's `service.environment` values. */
export function errorsByService(env: HealthEnvironment, limit = 50): EsRequest {
  const t = env.thresholds
  return dailyTrend({
    index: env.apm.errors,
    keyField: 'service.name',
    filters: [es.terms('service.environment', apmEnvironmentValues(env))],
    windowDays: t.trendWindowDays,
    recentHours: t.errorWindowHours,
    limit
  })
}

export function parseErrorsByService(response: Json): ServiceErrorCount[] {
  return list(at(response, 'aggregations', 'by_key', 'buckets')).flatMap((bucket) => {
    const service = str(at(bucket, 'key'))
    const stats = trendOfBucket(bucket)
    return service && stats ? [{ service, stats }] : []
  })
}

// Kubernetes warning events --------------------------------------------------------------------

/** Warning events by `reason` with their trend; the latest occurrence of each rides along. */
export function warningEvents(env: HealthEnvironment, limit = 25): EsRequest {
  const latest = {
    top_hits: {
      size: 1,
      sort: [{ '@timestamp': 'desc' }],
      _source: false,
      fields: ['kubernetes.event.message', 'kubernetes.event.involved_object.name', 'kubernetes.event.involved_object.kind', { field: '@timestamp', format: 'epoch_millis' }]
    }
  }
  return dailyTrend({
    index: k8sIndex('event', env),
    keyField: 'kubernetes.event.reason',
    filters: [es.term('kubernetes.event.type', 'Warning')],
    windowDays: env.thresholds.trendWindowDays,
    recentHours: env.thresholds.errorWindowHours,
    limit,
    extraAggs: { latest }
  })
}

export function parseWarningEvents(response: Json): K8sEvent[] {
  return list(at(response, 'aggregations', 'by_key', 'buckets')).flatMap((bucket): K8sEvent[] => {
    const reason = str(at(bucket, 'key'))
    const stats = trendOfBucket(bucket)
    if (!reason || !stats) return []
    const hit = at(bucket, 'latest', 'hits', 'hits', 0)
    const seen = Number(field(hit, '@timestamp'))
    return [
      {
        reason,
        stats,
        message: clip(str(field(hit, 'kubernetes.event.message')), 240),
        object: str(field(hit, 'kubernetes.event.involved_object.name')),
        objectKind: str(field(hit, 'kubernetes.event.involved_object.kind')),
        lastSeen: Number.isFinite(seen) ? seen : undefined
      }
    ]
  })
}

// Pods -----------------------------------------------------------------------------------------

const blankPod = (pod: string): PodIssue => ({ pod, notReady: false, restarts: 0, recentRestarts: 0, backOff: false, kind: 'restarting' })

/**
 * Documents of the pod state metrics in the last 24 hours (the body is the query of a `_count`).
 * Zero means the cluster ships no kube-state metrics: without this, an environment with no
 * telemetry reports the same zeros as a healthy one.
 */
export function kubeTelemetry(env: HealthEnvironment): EsRequest {
  return { index: k8sIndex('statePod', env), body: es.since('now-24h') }
}

/** Pods that are running but not ready in the last `minutes`. */
export function podsNotReady(env: HealthEnvironment, limit = 20): EsRequest {
  const query = es.filter([es.since(`now-${env.thresholds.restartWindowMinutes}m`), es.term('kubernetes.pod.status.ready', false), es.term('kubernetes.pod.status.phase', 'running')])
  return { index: k8sIndex('statePod', env), body: es.aggregations(query, { by_pod: { terms: { field: 'kubernetes.pod.name', size: limit } } }) }
}

export function parsePodsNotReady(response: Json): PodIssue[] {
  return list(at(response, 'aggregations', 'by_pod', 'buckets')).flatMap((b) => {
    const pod = str(at(b, 'key'))
    return pod ? [{ ...blankPod(pod), notReady: true }] : []
  })
}

/**
 * Restart counters per pod in the window. The counter is cumulative, so the movement inside the
 * window is its max minus its min; only pods with a non-zero counter are asked for.
 */
export function containerRestarts(env: HealthEnvironment, limit = 50): EsRequest {
  const query = es.filter([es.since(`now-${env.thresholds.restartWindowMinutes}m`), { range: { 'kubernetes.container.status.restarts': { gt: 0 } } }])
  const byPod = {
    terms: { field: 'kubernetes.pod.name', size: limit, order: { restarts: 'desc' } },
    aggs: { restarts: { max: { field: 'kubernetes.container.status.restarts' } }, first: { min: { field: 'kubernetes.container.status.restarts' } } }
  }
  return { index: k8sIndex('stateContainer', env), body: es.aggregations(query, { by_pod: byPod }) }
}

export function parseContainerRestarts(response: Json): PodIssue[] {
  return list(at(response, 'aggregations', 'by_pod', 'buckets')).flatMap((b) => {
    const pod = str(at(b, 'key'))
    const total = num(at(b, 'restarts', 'value')) ?? 0
    const first = num(at(b, 'first', 'value')) ?? total
    return pod && total > 0 ? [{ ...blankPod(pod), restarts: total, recentRestarts: Math.max(0, total - first) }] : []
  })
}

/** Pods with a `BackOff` warning event in the window: Kubernetes backing off from restarting a failing container, the crash-loop signature. */
export function backOffEvents(env: HealthEnvironment, limit = 30): EsRequest {
  const query = es.filter([es.since(`now-${env.thresholds.restartWindowMinutes}m`), es.term('kubernetes.event.reason', 'BackOff'), es.term('kubernetes.event.type', 'Warning')])
  return { index: k8sIndex('event', env), body: es.aggregations(query, { by_object: { terms: { field: 'kubernetes.event.involved_object.name', size: limit } } }) }
}

export function parseBackOffEvents(response: Json): PodIssue[] {
  return list(at(response, 'aggregations', 'by_object', 'buckets')).flatMap((b) => {
    const pod = str(at(b, 'key'))
    return pod ? [{ ...blankPod(pod), backOff: true }] : []
  })
}

// Services that stopped reporting ----------------------------------------------------------------

/**
 * Last agent-metrics timestamp per service over the previous `lookbackHours`. Agents report every
 * ~30 seconds, so a service whose last document is older than a few minutes while it reported
 * earlier has stopped (scaled down, crashed, or the agent died).
 */
export function apmReporting(env: HealthEnvironment, lookbackHours = 24, limit = 300): EsRequest {
  const query = es.filter([es.since(`now-${lookbackHours}h`), es.terms('service.environment', apmEnvironmentValues(env))])
  const byService = { terms: { field: 'service.name', size: limit }, aggs: { last_seen: { max: { field: '@timestamp' } } } }
  return { index: env.apm.metrics, body: es.aggregations(query, { by_service: byService }) }
}

export function parseApmReporting(response: Json, now: number, silentAfterMinutes: number): ServiceReporting[] {
  return list(at(response, 'aggregations', 'by_service', 'buckets'))
    .flatMap((b): ServiceReporting[] => {
      const service = str(at(b, 'key'))
      const lastSeen = num(at(b, 'last_seen', 'value'))
      if (!service || lastSeen === undefined) return []
      const silentMinutes = Math.max(0, Math.floor((now - lastSeen) / 60_000))
      return [{ service, lastSeen, silentMinutes, isReporting: silentMinutes <= silentAfterMinutes }]
    })
    .sort((a, b) => a.service.localeCompare(b.service))
}

// Slow flows -------------------------------------------------------------------------------------

/**
 * Percentiles and failure rate per transaction. The terms are the busiest `candidates`
 * transactions, ranked by p95 on this side: an endpoint called twice a day is not a flow. A plain
 * `terms` on the name with the service as a sub-aggregation is much cheaper than `multi_terms`; a
 * name shared by two services collapses into one row attributed to the busier one.
 */
export function slowTransactions(env: HealthEnvironment, candidates = 50): EsRequest {
  const query = es.filter([es.since(`now-${env.thresholds.slowFlowHours}h`), es.term('processor.event', 'transaction'), es.terms('service.environment', apmEnvironmentValues(env))])
  const byTransaction = {
    terms: { field: 'transaction.name', size: candidates },
    aggs: {
      service: { terms: { field: 'service.name', size: 1 } },
      latency: { percentiles: { field: 'transaction.duration.us', percents: [50, 95, 99] } },
      failed: { filter: es.term('event.outcome', 'failure') },
      kind: { terms: { field: 'transaction.type', size: 1 } }
    }
  }
  return { index: env.apm.traces, body: es.aggregations(query, { by_transaction: byTransaction }) }
}

/** A percentile in milliseconds from a `percentiles` aggregation, which keys values as "95.0". */
export function percentileMs(aggregation: Json, percent: number): number | undefined {
  const value = num(at(aggregation, 'values', `${percent}.0`)) ?? num(at(aggregation, 'values', String(percent)))
  return value === undefined ? undefined : value / 1000
}

/** Transactions with at least `minCalls` calls, slowest p95 first, at most `limit`. */
export function parseSlowTransactions(response: Json, minCalls: number, limit: number): SlowTransaction[] {
  const all = list(at(response, 'aggregations', 'by_transaction', 'buckets')).flatMap((b): SlowTransaction[] => {
    const calls = num(at(b, 'doc_count')) ?? 0
    const name = str(at(b, 'key'))
    const service = str(at(b, 'service', 'buckets', 0, 'key'))
    const p95 = percentileMs(at(b, 'latency'), 95)
    if (calls < minCalls || !name || !service || p95 === undefined) return []
    const failed = num(at(b, 'failed', 'doc_count')) ?? 0
    return [
      {
        service,
        name,
        type: str(at(b, 'kind', 'buckets', 0, 'key')),
        calls,
        p50Ms: percentileMs(at(b, 'latency'), 50) ?? p95,
        p95Ms: p95,
        p99Ms: percentileMs(at(b, 'latency'), 99) ?? p95,
        failureRate: failed / Math.max(calls, 1)
      }
    ]
  })
  return all.sort((a, b) => b.p95Ms - a.p95Ms).slice(0, limit)
}

/** The slowest few flows get a breakdown; one per flow when asked on demand. */
export const DEFAULT_SPAN_SAMPLE = 100

// Container stderr -------------------------------------------------------------------------------

/**
 * stderr volume per container: the only infrastructure signal an environment without kube-state
 * metrics has. A proxy, not a truth: plenty of applications write normal output there, so only its
 * movement against its own baseline means anything. The namespace rides along so infrastructure
 * containers can be told apart.
 */
export function containerStderr(env: HealthEnvironment, windowDays = 7, limit = 25): EsRequest {
  return dailyTrend({
    index: k8sIndex('containerLogs', env),
    keyField: 'kubernetes.container.name',
    filters: [es.term('stream', 'stderr')],
    windowDays,
    recentHours: env.thresholds.errorWindowHours,
    limit,
    extraAggs: { namespace: { terms: { field: 'kubernetes.namespace', size: 1 } } }
  })
}

const trendRank = (s: SignalTrend) => ['new', 'worsening', 'ongoing', 'chronic'].indexOf(s.stats.state)

export function parseTrends(response: Json): SignalTrend[] {
  return list(at(response, 'aggregations', 'by_key', 'buckets'))
    .flatMap((bucket): SignalTrend[] => {
      const key = str(at(bucket, 'key'))
      const stats = trendOfBucket(bucket)
      return key && stats ? [{ key, stats, namespace: str(at(bucket, 'namespace', 'buckets', 0, 'key')) }] : []
    })
    .sort((a, b) => trendRank(a) - trendRank(b) || b.stats.recent - a.stats.recent)
}

// One service's errors, on demand ---------------------------------------------------------------

/**
 * The top `limit` error groups (`error.grouping_key`) of one service by errors in the rolling
 * window, each with its daily series, first and last occurrence, the most common transaction of
 * the window and its latest error for the type, message and culprit. One request, one service.
 */
export function errorGroups(env: HealthEnvironment, service: string, limit = 5): EsRequest {
  const t = env.thresholds
  return dailyTrend({
    index: env.apm.errors,
    keyField: 'error.grouping_key',
    filters: [es.terms('service.environment', apmEnvironmentValues(env)), es.term('service.name', service)],
    windowDays: t.trendWindowDays,
    recentHours: t.errorWindowHours,
    limit,
    byRecent: true,
    extraAggs: {
      recent: { filter: es.since(`now-${t.errorWindowHours}h`), aggs: { endpoint: { terms: { field: 'transaction.name', size: 1 } } } },
      first_seen: { min: { field: '@timestamp' } },
      last_seen: { max: { field: '@timestamp' } },
      sample: { top_hits: { size: 1, sort: [{ '@timestamp': 'desc' }], _source: false, fields: ['error.exception.type', 'error.exception.message', 'error.log.message', 'error.culprit'] } }
    }
  })
}

/** Groups with errors in the window, most first. `now` and `windowHours` decide which are new. */
export function parseErrorGroups(response: Json, now: number, windowHours: number): ErrorGroup[] {
  const windowStart = now - windowHours * 3_600_000
  return list(at(response, 'aggregations', 'by_key', 'buckets'))
    .flatMap((bucket): ErrorGroup[] => {
      const recent = num(at(bucket, 'recent', 'doc_count')) ?? 0
      const groupingKey = str(at(bucket, 'key'))
      if (!groupingKey || recent <= 0) return []
      const series = list(at(bucket, 'daily', 'buckets')).map((b) => num(at(b, 'doc_count')) ?? 0)
      const hit = at(bucket, 'sample', 'hits', 'hits', 0)
      const firstSeen = num(at(bucket, 'first_seen', 'value'))
      return [
        {
          groupingKey,
          exceptionType: str(field(hit, 'error.exception.type')),
          message: clip(str(field(hit, 'error.exception.message')) ?? str(field(hit, 'error.log.message')), 160),
          culprit: str(field(hit, 'error.culprit')),
          endpoint: str(at(bucket, 'recent', 'endpoint', 'buckets', 0, 'key')),
          recent,
          total: num(at(bucket, 'doc_count')) ?? recent,
          firstSeen,
          lastSeen: num(at(bucket, 'last_seen', 'value')),
          activeDays: series.filter((n) => n > 0).length,
          daysWithData: series.length,
          typicalDay: median(series.slice(0, -1).filter((n) => n > 0)),
          isNew: firstSeen !== undefined && firstSeen >= windowStart
        }
      ]
    })
    .sort((a, b) => b.recent - a.recent || a.groupingKey.localeCompare(b.groupingKey))
}

// One pod, on demand -----------------------------------------------------------------------------

/**
 * The container status of the given pods in the restart window: the waiting reason seen most and
 * the latest document of the container with the most restarts, for how its last run ended.
 */
export function podStatus(env: HealthEnvironment, pods: string[]): EsRequest {
  const query = es.filter([es.since(`now-${env.thresholds.restartWindowMinutes}m`), es.terms('kubernetes.pod.name', pods)])
  const latest = {
    top_hits: {
      size: 1,
      sort: [{ 'kubernetes.container.status.restarts': { order: 'desc', unmapped_type: 'long' } }, { '@timestamp': 'desc' }],
      _source: false,
      fields: ['kubernetes.container.name', 'kubernetes.namespace', 'kubernetes.container.status.last_terminated_reason', 'kubernetes.container.status.last_terminated_exitcode', 'kubernetes.container.status.last_terminated_timestamp']
    }
  }
  const byPod = {
    terms: { field: 'kubernetes.pod.name', size: Math.max(pods.length, 1) },
    aggs: {
      waiting: { filter: { exists: { field: 'kubernetes.container.status.reason' } }, aggs: { reason: { terms: { field: 'kubernetes.container.status.reason', size: 1 } } } },
      latest
    }
  }
  return { index: k8sIndex('stateContainer', env), body: es.aggregations(query, { by_pod_status: byPod }) }
}

export function parsePodStatus(response: Json): Record<string, PodStatus> {
  const result: Record<string, PodStatus> = {}
  for (const bucket of list(at(response, 'aggregations', 'by_pod_status', 'buckets'))) {
    const pod = str(at(bucket, 'key'))
    if (!pod) continue
    const hit = at(bucket, 'latest', 'hits', 'hits', 0)
    // Seconds as a float; a millisecond value is accepted too.
    const raw = num(field(hit, 'kubernetes.container.status.last_terminated_timestamp'))
    const exit = num(field(hit, 'kubernetes.container.status.last_terminated_exitcode'))
    result[pod] = {
      container: str(field(hit, 'kubernetes.container.name')),
      namespace: str(field(hit, 'kubernetes.namespace')),
      waitingReason: str(at(bucket, 'waiting', 'reason', 'buckets', 0, 'key')),
      lastTerminatedReason: str(field(hit, 'kubernetes.container.status.last_terminated_reason')),
      lastExitCode: exit === undefined ? undefined : Math.round(exit),
      lastTerminatedAt: raw === undefined ? undefined : raw > 100_000_000_000 ? raw : raw * 1000
    }
  }
  return result
}

/** The latest warning reasons about one pod in the last `hours`, one bucket per reason with its latest message. */
export function podEvents(env: HealthEnvironment, pod: string, hours: number, limit = 3): EsRequest {
  const query = es.filter([es.since(`now-${hours}h`), es.term('kubernetes.event.involved_object.name', pod), es.term('kubernetes.event.type', 'Warning')])
  const byReason = {
    terms: { field: 'kubernetes.event.reason', size: limit, order: { last_seen: 'desc' } },
    aggs: {
      last_seen: { max: { field: '@timestamp' } },
      latest: { top_hits: { size: 1, sort: [{ '@timestamp': 'desc' }], _source: false, fields: ['kubernetes.event.message', 'kubernetes.event.count'] } }
    }
  }
  return { index: k8sIndex('event', env), body: es.aggregations(query, { by_reason: byReason }) }
}

/** Newest first. */
export function parsePodEvents(response: Json): PodEvent[] {
  return list(at(response, 'aggregations', 'by_reason', 'buckets'))
    .flatMap((bucket): PodEvent[] => {
      const reason = str(at(bucket, 'key'))
      if (!reason) return []
      const hit = at(bucket, 'latest', 'hits', 'hits', 0)
      return [
        {
          reason,
          message: clip(str(field(hit, 'kubernetes.event.message')), 240),
          lastSeen: num(at(bucket, 'last_seen', 'value')),
          count: num(at(bucket, 'doc_count')) ?? 0,
          occurrences: num(field(hit, 'kubernetes.event.count'))
        }
      ]
    })
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
}

/** The last `lines` lines one pod wrote to stderr in the last `hours`: a handful of hits. */
export function podStderr(env: HealthEnvironment, pod: string, hours: number, lines = 5): EsRequest {
  const query = es.filter([es.since(`now-${hours}h`), es.term('kubernetes.pod.name', pod), es.term('stream', 'stderr')])
  return {
    index: k8sIndex('containerLogs', env),
    body: { size: lines, track_total_hits: false, query, sort: [{ '@timestamp': 'desc' }], _source: false, fields: ['message', 'kubernetes.container.name', { field: '@timestamp', format: 'epoch_millis' }] }
  }
}

/** Oldest first, as they were written. */
export function parsePodStderr(response: Json): LogLine[] {
  return [...list(at(response, 'hits', 'hits'))].reverse().flatMap((hit): LogLine[] => {
    const text = clip(str(field(hit, 'message')), 300)
    if (!text) return []
    const ts = Number(field(hit, '@timestamp'))
    return [{ text, container: str(field(hit, 'kubernetes.container.name')), timestamp: Number.isFinite(ts) ? ts : undefined }]
  })
}

// One slow flow, on demand -------------------------------------------------------------------------

/** Step 1 of a breakdown: the slowest executions of one transaction, to know which `transaction.id`s to break down. */
export function slowestExecutions(env: HealthEnvironment, service: string, name: string, sample = DEFAULT_SPAN_SAMPLE): EsRequest {
  const query = es.filter([
    es.since(`now-${env.thresholds.slowFlowHours}h`),
    es.term('processor.event', 'transaction'),
    es.term('service.name', service),
    es.term('transaction.name', name),
    es.terms('service.environment', apmEnvironmentValues(env))
  ])
  return { index: env.apm.traces, body: { size: sample, track_total_hits: false, query, sort: [{ 'transaction.duration.us': 'desc' }], _source: false, fields: ['transaction.id', 'transaction.duration.us'] } }
}

export interface TransactionSample {
  ids: string[]
  wallMs: number
}

export function parseExecutions(response: Json): TransactionSample {
  const ids: string[] = []
  let wall = 0
  for (const hit of list(at(response, 'hits', 'hits'))) {
    const id = str(field(hit, 'transaction.id'))
    if (!id) continue
    ids.push(id)
    wall += (num(field(hit, 'transaction.duration.us')) ?? 0) / 1000
  }
  return { ids, wallMs: wall }
}

/**
 * Step 2: the spans of the sampled transactions, broken down by destination, type and subtype.
 * Spans carry `transaction.id` but not the transaction's name, hence the ids from step 1.
 */
export function spanBreakdown(env: HealthEnvironment, sample: TransactionSample, top = 8): EsRequest {
  const byResource = {
    multi_terms: {
      terms: [
        { field: 'span.destination.service.resource', missing: 'n/a' },
        { field: 'span.type', missing: 'n/a' },
        { field: 'span.subtype', missing: 'n/a' }
      ],
      size: top,
      order: { total: 'desc' }
    },
    aggs: { total: { sum: { field: 'span.duration.us' } } }
  }
  const query = es.filter([es.since(`now-${env.thresholds.slowFlowHours}h`), es.term('processor.event', 'span'), es.terms('transaction.id', sample.ids)])
  return { index: env.apm.traces, body: es.aggregations(query, { by_resource: byResource }) }
}

/** Largest total first. */
export function parseSpanBreakdown(response: Json, sample: TransactionSample): SpanBreakdown[] {
  const transactions = Math.max(sample.ids.length, 1)
  const na = (v: string | undefined) => (v === 'n/a' ? undefined : v)
  return list(at(response, 'aggregations', 'by_resource', 'buckets'))
    .flatMap((bucket): SpanBreakdown[] => {
      const calls = num(at(bucket, 'doc_count')) ?? 0
      if (calls <= 0) return []
      const totalMs = (num(at(bucket, 'total', 'value')) ?? 0) / 1000
      const type = str(at(bucket, 'key', 1)) ?? 'n/a'
      return [
        {
          resource: na(str(at(bucket, 'key', 0))) ?? type,
          type,
          subtype: na(str(at(bucket, 'key', 2))),
          calls,
          totalMs,
          averageMs: totalMs / calls,
          callsPerTransaction: calls / transactions,
          shareOfWallTime: sample.wallMs > 0 ? totalMs / sample.wallMs : 0
        }
      ]
    })
    .sort((a, b) => b.totalMs - a.totalMs)
}

/** The two windows of a comparison: the last `hours` and the `hours` before them, as epoch milliseconds. */
export function comparisonWindows(now: number, hours: number): { previous: [number, number]; current: [number, number] } {
  const width = hours * 3_600_000
  return { previous: [now - 2 * width, now - width], current: [now - width, now] }
}

function windowFilters(env: HealthEnvironment, processor: string, service: string, transaction: string | null, now: number, hours: number) {
  const w = comparisonWindows(now, hours)
  const clauses: Clause[] = [es.term('processor.event', processor), es.terms('service.environment', apmEnvironmentValues(env)), es.term('service.name', service)]
  if (transaction !== null) clauses.push(es.term('transaction.name', transaction))
  return { query: es.filter([...clauses, es.between(w.previous[0], w.current[1])]), windows: { previous: es.between(...w.previous), current: es.between(...w.current) } }
}

/** Error counts of a service in the two windows. Errors are compared for the whole service: many carry no transaction. */
export function windowErrors(env: HealthEnvironment, service: string, now: number, hours: number): EsRequest {
  const { query, windows } = windowFilters(env, 'error', service, null, now, hours)
  return { index: env.apm.errors, body: es.aggregations(query, { windows: { filters: { filters: windows } } }) }
}

/** Transactions, failed transactions and p95 of one transaction in the two windows. */
export function windowTransactions(env: HealthEnvironment, service: string, transaction: string | null, now: number, hours: number): EsRequest {
  const { query, windows } = windowFilters(env, 'transaction', service, transaction, now, hours)
  const perWindow = { failed: { filter: es.term('event.outcome', 'failure') }, latency: { percentiles: { field: 'transaction.duration.us', percents: [95] } } }
  return { index: env.apm.traces, body: es.aggregations(query, { windows: { filters: { filters: windows }, aggs: perWindow } }) }
}

/** Error types of the service whose first occurrence in the trend window falls inside the current window, newest first. */
export function newErrorTypes(env: HealthEnvironment, service: string, now: number, hours: number, limit = 25): EsRequest {
  const query = es.filter([
    es.between(now - env.thresholds.trendWindowDays * 86_400_000, now),
    es.term('processor.event', 'error'),
    es.terms('service.environment', apmEnvironmentValues(env)),
    es.term('service.name', service)
  ])
  const byGroup = {
    terms: { field: 'error.grouping_key', size: limit, order: { first_seen: 'desc' } },
    aggs: { first_seen: { min: { field: '@timestamp' } }, sample: { top_hits: { size: 1, _source: false, fields: ['error.exception.type', 'error.culprit'] } } }
  }
  return { index: env.apm.errors, body: es.aggregations(query, { by_group: byGroup }) }
}

export function parseNewErrorTypes(response: Json, since: number): NewErrorType[] {
  return list(at(response, 'aggregations', 'by_group', 'buckets')).flatMap((bucket): NewErrorType[] => {
    const groupingKey = str(at(bucket, 'key'))
    const firstSeen = num(at(bucket, 'first_seen', 'value'))
    if (!groupingKey || firstSeen === undefined || firstSeen < since) return []
    const hit = at(bucket, 'sample', 'hits', 'hits', 0)
    return [{ groupingKey, exceptionType: str(field(hit, 'error.exception.type')), culprit: str(field(hit, 'error.culprit')), firstSeen, count: num(at(bucket, 'doc_count')) ?? 0 }]
  })
}

/** Joins the three answers of a window comparison. */
export function parseWindowComparison(errors: Json, transactions: Json, newTypes: Json, service: string, transaction: string | null, now: number, hours: number): WindowComparison {
  const stats = (name: 'previous' | 'current'): WindowStats => {
    const tx = at(transactions, 'aggregations', 'windows', 'buckets', name)
    return {
      errors: num(at(errors, 'aggregations', 'windows', 'buckets', name, 'doc_count')) ?? 0,
      transactions: num(at(tx, 'doc_count')) ?? 0,
      failedTransactions: num(at(tx, 'failed', 'doc_count')) ?? 0,
      p95Ms: percentileMs(at(tx, 'latency'), 95)
    }
  }
  const since = comparisonWindows(now, hours).current[0]
  return { service, transaction, windowHours: hours, previous: stats('previous'), current: stats('current'), newErrorTypes: parseNewErrorTypes(newTypes, since) }
}
