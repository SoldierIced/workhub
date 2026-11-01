/**
 * The metric source port, and the first source's mapping: Health's own signals (what the Health
 * screen already read) as daily samples. A new source implements `MetricSource`; nothing in the
 * rules or the lifecycle changes.
 */
import type { HealthSnapshot } from '../health/types'
import { localDay } from './days'
import type { MetricDefinition, MetricSample } from './types'

export interface MetricSource {
  /** Stable id, stored in each sample and series key. */
  readonly id: string
  /** The metrics this source reports. */
  definitions(): readonly MetricDefinition[]
  /**
   * The samples of a profile at `now`: today's value of each subject and, when the source knows
   * them, earlier days (the last sample of a day wins). Never throws for "nothing to report".
   */
  collect(profileId: string, now: number): Promise<MetricSample[]>
}

export const HEALTH_METRIC_SOURCE = 'health'

/** Health's metrics. Each is a rolling 24 h figure sampled through the day, so the last read of a day stands for that day. */
export const HEALTH_METRICS: readonly MetricDefinition[] = [
  { id: 'health.errors', label: 'APM errors', source: HEALTH_METRIC_SOURCE, direction: 'upIsBad', kind: 'count', absentIsZero: true },
  { id: 'health.stderr', label: 'Container stderr lines', source: HEALTH_METRIC_SOURCE, direction: 'upIsBad', kind: 'count', absentIsZero: true },
  { id: 'health.slowCalls', label: 'Calls to slow endpoints', source: HEALTH_METRIC_SOURCE, direction: 'upIsBad', kind: 'count', absentIsZero: true },
  { id: 'health.slowFailureRate', label: 'Failure rate of slow endpoints', source: HEALTH_METRIC_SOURCE, direction: 'upIsBad', kind: 'rate' }
]

/** One environment as Health last read it. */
export interface HealthSampleInput {
  name: string
  snapshot: Pick<HealthSnapshot, 'errorServices' | 'containerStderr' | 'slow' | 'blindSpots' | 'state'>
  /** Kibana errors page per service, and Kibana page per service. */
  errorUrls?: Record<string, string>
  serviceUrls?: Record<string, string>
}

/**
 * Daily samples from Health's environments: errors per service, stderr lines per container,
 * calls to the slow endpoints per service and their failure rate. An environment that was not
 * read yet or could not be read reports nothing (rather than zeros).
 */
export function healthMetricSamples(environments: readonly HealthSampleInput[], now: number): MetricSample[] {
  const day = localDay(now)
  const out: MetricSample[] = []
  const sample = (metric: string, subject: string, segment: string, value: number, extra: Partial<MetricSample> = {}) =>
    out.push({ metric, subject, segment, day, value, source: HEALTH_METRIC_SOURCE, at: now, ...extra })
  for (const env of environments) {
    const s = env.snapshot
    if (s.state === 'unreachable' || s.blindSpots.some((b) => b.code === 'notReadYet')) continue
    const unread = new Set(s.blindSpots.filter((b) => b.code === 'unread' && b.signal).map((b) => b.signal))
    if (!unread.has('errors')) for (const e of s.errorServices) sample('health.errors', e.service, env.name, e.stats.recent, env.errorUrls?.[e.service] ? { link: env.errorUrls[e.service] } : {})
    if (!unread.has('stderr')) for (const c of s.containerStderr) sample('health.stderr', c.key, env.name, c.stats.recent)
    if (!unread.has('slow')) {
      const byService = new Map<string, { calls: number; failed: number }>()
      for (const tx of s.slow) {
        const acc = byService.get(tx.service) ?? { calls: 0, failed: 0 }
        acc.calls += tx.calls
        acc.failed += tx.calls * tx.failureRate
        byService.set(tx.service, acc)
      }
      for (const [service, acc] of byService) {
        const link = env.serviceUrls?.[service] ? { link: env.serviceUrls[service] } : {}
        sample('health.slowCalls', service, env.name, acc.calls, link)
        if (acc.calls > 0) sample('health.slowFailureRate', service, env.name, Math.round((acc.failed / acc.calls) * 1000) / 10, { base: acc.calls, ...link })
      }
    }
  }
  return out
}
