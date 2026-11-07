import type { FlowBaseline, FlowCodeCount, FlowHourPoint, FlowMeasure, FlowTiming } from './flow-map'

/**
 * The local history of flow-map measures: one aggregate per measure and hour, kept for a week, so
 * a map is drawn from disk and the cluster is only asked for the hours it has not answered yet.
 *
 * Percentiles cannot be added up hour by hour, so each hour keeps a latency histogram over fixed,
 * logarithmic buckets (each 20% wider than the one before, 1 ms to 10 minutes). Any window's
 * percentiles are read back from the sum of its hours, within the width of one bucket (about 10%).
 */

const HOUR_MS = 3_600_000

/**
 * How many hours of history are kept: the longest window a map reads (a week of whole hours) plus
 * the hour in course, which every window includes (see `flowTimingFromHistory`).
 */
export const FLOW_HISTORY_HOURS = 24 * 7 + 1

/**
 * APM documents arrive a few minutes late, so an hour counts as final only this long after it
 * ended; until then it is read again on every refresh.
 */
export const FLOW_HISTORY_SETTLE_MS = 15 * 60_000

/** Upper bounds of the latency buckets, in microseconds (as APM stores durations), ascending. */
export const FLOW_LATENCY_BOUNDS_US: readonly number[] = (() => {
  const out: number[] = []
  for (let ms = 1; ms <= 600_000; ms *= 1.2) {
    const us = Math.round(ms * 1000)
    if (out[out.length - 1] !== us) out.push(us)
  }
  return out
})()

/** The bucket a duration (microseconds) falls in. */
export function flowLatencyBucket(us: number): number {
  const bounds = FLOW_LATENCY_BOUNDS_US
  let lo = 0
  let hi = bounds.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (us < bounds[mid]!) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * One measure over one hour. `latency` holds `[bucket, count]` pairs for the buckets that saw
 * calls: bucket `i` counts durations under `FLOW_LATENCY_BOUNDS_US[i]` (and at or over the bound
 * before it); the bucket after the last bound counts everything slower.
 */
export interface FlowHour {
  /** Epoch milliseconds of the hour's start. */
  at: number
  count: number
  failed: number
  latency: [number, number][]
  /** Results of the hour (transactions only), by `transaction.result`. */
  codes?: Record<string, number>
}

/** What is stored for one measure of one environment. */
export interface FlowMeasureHistory {
  /** Hours with calls, oldest first; an hour missing before `settledUntil` had none. */
  hours: FlowHour[]
  /** Every hour that starts before this (epoch ms, on the hour) is final and is not read again. */
  settledUntil: number
  /** When the cluster was last asked (epoch ms). */
  fetchedAt: number
}

/** The start of the hour `t` falls in. */
export const hourStart = (t: number): number => Math.floor(t / HOUR_MS) * HOUR_MS

/** The key a measure is stored under; two maps that measure the same thing share it. */
export function flowHistoryKey(measure: FlowMeasure): string {
  return measure.type === 'apm.transaction' ? `tx|${measure.service}|${measure.transaction}` : `span|${measure.service}|${measure.destination}`
}

/** The first hour the history keeps at `now`. */
export const flowHistoryStart = (now: number): number => hourStart(now) - (FLOW_HISTORY_HOURS - 1) * HOUR_MS

/** The range to ask the cluster for: from the first hour not yet final (or a week back) up to `now`. */
export function flowHistoryGap(history: FlowMeasureHistory | undefined, now: number): { from: number; to: number } {
  const start = flowHistoryStart(now)
  return { from: Math.max(start, history?.settledUntil ?? start), to: now }
}

/**
 * The history after a read of `[from, now)`: the hours read replace the stored ones from `from` on,
 * hours older than a week are dropped, and the hours that ended long enough ago become final.
 */
export function mergeFlowHistory(history: FlowMeasureHistory | undefined, read: FlowHour[], from: number, now: number): FlowMeasureHistory {
  const start = flowHistoryStart(now)
  const kept = (history?.hours ?? []).filter((h) => h.at >= start && h.at < from)
  const fresh = read.filter((h) => h.at >= start && h.at >= from && h.count > 0)
  const hours = [...kept, ...fresh].sort((a, b) => a.at - b.at)
  const settledUntil = Math.max(history?.settledUntil ?? 0, Math.min(hourStart(now - FLOW_HISTORY_SETTLE_MS), hourStart(now)))
  return { hours, settledUntil, fetchedAt: now }
}

/** The `percent` percentile of a histogram, in milliseconds, interpolated inside its bucket; 0 when empty. */
export function histogramPercentileMs(latency: readonly [number, number][], percent: number): number {
  const total = latency.reduce((s, [, n]) => s + n, 0)
  if (total === 0) return 0
  const bounds = FLOW_LATENCY_BOUNDS_US
  const rank = (percent / 100) * total
  let seen = 0
  for (const [bucket, n] of [...latency].sort((a, b) => a[0] - b[0])) {
    if (n <= 0) continue
    if (seen + n >= rank) {
      const last = bounds[bounds.length - 1]!
      const lo = bucket === 0 ? 0 : bounds[Math.min(bucket, bounds.length) - 1]!
      const hi = bucket < bounds.length ? bounds[bucket]! : last
      const fraction = Math.min(1, Math.max(0, (rank - seen) / n))
      return round2((lo + (hi - lo) * fraction) / 1000)
    }
    seen += n
  }
  return round2(bounds[bounds.length - 1]! / 1000)
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * The share (0–1) of a histogram's calls slower than `ms`, interpolated inside the bucket `ms`
 * falls in (like `histogramPercentileMs`); 0 when empty.
 */
export function histogramShareOverMs(latency: readonly [number, number][], ms: number): number {
  const total = latency.reduce((s, [, n]) => s + Math.max(0, n), 0)
  if (total === 0) return 0
  const bounds = FLOW_LATENCY_BOUNDS_US
  const us = ms * 1000
  let over = 0
  for (const [bucket, n] of latency) {
    if (n <= 0) continue
    const lo = bucket === 0 ? 0 : bounds[Math.min(bucket, bounds.length) - 1]!
    const hi = bucket < bounds.length ? bounds[bucket]! : Infinity
    if (lo >= us) over += n
    else if (hi > us) over += hi === Infinity ? n : n * ((hi - us) / (hi - lo))
  }
  return Math.min(1, over / total)
}

/** The hours added up: calls, failures, histogram and results. */
export function sumFlowHours(hours: readonly FlowHour[]): Omit<FlowHour, 'at'> {
  const latency = new Map<number, number>()
  const codes = new Map<string, number>()
  let count = 0
  let failed = 0
  for (const h of hours) {
    count += h.count
    failed += h.failed
    for (const [bucket, n] of h.latency) latency.set(bucket, (latency.get(bucket) ?? 0) + n)
    for (const [code, n] of Object.entries(h.codes ?? {})) codes.set(code, (codes.get(code) ?? 0) + n)
  }
  const out: Omit<FlowHour, 'at'> = { count, failed, latency: [...latency].sort((a, b) => a[0] - b[0]) }
  if (codes.size > 0) out.codes = Object.fromEntries(codes)
  return out
}

function baseline(hours: readonly FlowHour[]): FlowBaseline {
  const sum = sumFlowHours(hours)
  const p95 = histogramPercentileMs(sum.latency, 95)
  return { count: sum.count, p50Ms: sum.count ? histogramPercentileMs(sum.latency, 50) : p95, p95Ms: p95, errorRate: sum.failed / Math.max(sum.count, 1) }
}

/**
 * The numbers of one measure over the last `windowHours`, read from its stored hours. History is
 * kept by whole hours, so the window is the `windowHours` full hours before the hour in course
 * plus the part of that hour already gone (`windowHours` to `windowHours + 1` hours of real time,
 * never less): a 1 h window read at 10:20 covers 9:00 to 10:20. `perMinute` divides by the
 * minutes actually covered; `hourly` has one point per hour of the window (`windowHours + 1`);
 * `previous` is the same number of whole hours just before the window, and `weekly` the stored week.
 */
export function flowTimingFromHistory(hours: readonly FlowHour[], measure: FlowMeasure, now: number, windowHours: number): FlowTiming {
  const current = hourStart(now)
  const span = Math.max(0, Math.floor(windowHours))
  const from = current - span * HOUR_MS
  const before = from - (span + 1) * HOUR_MS
  const inWindow = hours.filter((h) => h.at >= from && h.at <= current)
  const byHour = new Map(inWindow.map((h) => [h.at, h]))
  const hourly: FlowHourPoint[] = []
  for (let at = from; at <= current; at += HOUR_MS) {
    const h = byHour.get(at)
    hourly.push(h ? { at, count: h.count, p50Ms: histogramPercentileMs(h.latency, 50), p95Ms: histogramPercentileMs(h.latency, 95) } : { at, count: 0, p50Ms: 0, p95Ms: 0 })
  }
  const minutes = (now - from) / 60_000
  const sum = sumFlowHours(inWindow)
  const p95 = histogramPercentileMs(sum.latency, 95)
  const timing: FlowTiming = {
    count: sum.count,
    p50Ms: sum.count ? histogramPercentileMs(sum.latency, 50) : p95,
    p95Ms: p95,
    p99Ms: histogramPercentileMs(sum.latency, 99),
    errorRate: sum.failed / Math.max(sum.count, 1),
    failed: sum.failed,
    perMinute: round2(sum.count / Math.max(minutes, 1)),
    latency: sum.latency,
    hourly,
    previous: baseline(hours.filter((h) => h.at >= before && h.at < from)),
    weekly: baseline(hours.filter((h) => h.at >= flowHistoryStart(now) && h.at <= current))
  }
  if (measure.type === 'apm.transaction' && sum.codes) {
    const codes: FlowCodeCount[] = Object.entries(sum.codes)
      .filter(([, n]) => n > 0)
      .map(([code, n]) => ({ code, count: n }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
    if (codes.length > 0) timing.codes = codes
  }
  return timing
}
