import { addDays, isDay, localDay } from './days'
import type { MetricSample, MetricSeries, MetricSeriesStore } from './types'

/** Days of history kept per series. */
export const SERIES_RETENTION_DAYS = 45

export function seriesKey(s: Pick<MetricSample, 'source' | 'metric' | 'subject' | 'segment'>): string {
  return `${s.source}|${s.metric}|${s.subject}|${s.segment ?? ''}`
}

const validSample = (s: MetricSample, today: string): boolean =>
  typeof s.metric === 'string' && s.metric.length > 0 && typeof s.subject === 'string' && s.subject.length > 0 && typeof s.source === 'string' && s.source.length > 0 && isDay(s.day) && s.day <= today && Number.isFinite(s.value) && s.value >= 0

/**
 * Merges samples into the per-key daily series: the last sample of a day wins, days older than
 * `SERIES_RETENTION_DAYS` are dropped, and so are series left with no day. Bad samples (no key,
 * a malformed or future day, a negative or non-finite value) are ignored. Returns a new store.
 */
export function mergeSamples(store: MetricSeriesStore, samples: readonly MetricSample[], now: number): MetricSeriesStore {
  const today = localDay(now)
  const cutoff = addDays(today, -(SERIES_RETENTION_DAYS - 1))
  const next: MetricSeriesStore = { ...store }
  const touched = new Set<string>()
  for (const s of samples) {
    if (!validSample(s, today) || s.day < cutoff) continue
    const key = seriesKey(s)
    const current: MetricSeries = touched.has(key) ? next[key]! : next[key] ? { ...next[key]!, points: [...next[key]!.points] } : { key, source: s.source, metric: s.metric, subject: s.subject, ...(s.segment ? { segment: s.segment } : {}), points: [] }
    touched.add(key)
    const point = { day: s.day, value: s.value, ...(s.base !== undefined && Number.isFinite(s.base) ? { base: s.base } : {}) }
    const at = current.points.findIndex((p) => p.day === s.day)
    if (at >= 0) current.points[at] = point
    else current.points.push(point)
    current.lastSampleAt = Math.max(current.lastSampleAt ?? 0, s.at ?? now)
    if (s.link) current.link = s.link
    next[key] = current
  }
  for (const [key, series] of Object.entries(next)) {
    const points = series.points.filter((p) => p.day >= cutoff).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    if (points.length === 0) delete next[key]
    else if (touched.has(key) || points.length !== series.points.length) next[key] = { ...series, points }
  }
  return next
}
