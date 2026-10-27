import {
  trendStats,
  type HealthEnvironment,
  type K8sEvent,
  type PodIssue,
  type ServiceErrorCount,
  type ServiceReporting,
  type SlowTransaction
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
  event: 'metrics-kubernetes.event'
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
}

/**
 * Daily counts per key over `windowDays`, plus a rolling count over `recentHours` per key. The
 * rolling count is what gets compared: today's calendar bucket is partial and would make
 * everything look like it is improving.
 */
export function dailyTrend({ index, keyField, filters, windowDays, recentHours, limit, extraAggs = {} }: TrendOptions): EsRequest {
  const perKey = {
    daily: { date_histogram: { field: '@timestamp', calendar_interval: 'day', min_doc_count: 0 } },
    recent: { filter: es.since(`now-${recentHours}h`) },
    ...extraAggs
  }
  const byKey = { terms: { field: keyField, size: limit }, aggs: perKey }
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
