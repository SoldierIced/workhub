import { describe, expect, it } from 'vitest'
import {
  FLOW_HISTORY_HOURS,
  FLOW_HISTORY_SETTLE_MS,
  FLOW_LATENCY_BOUNDS_US,
  flowHistoryGap,
  flowHistoryKey,
  flowHistoryStart,
  flowLatencyBucket,
  flowTimingFromHistory,
  histogramPercentileMs,
  histogramShareOverMs,
  hourStart,
  mergeFlowHistory,
  sumFlowHours,
  type FlowHour,
  type FlowMeasure
} from '../src'

const H = 3_600_000
const NOW = Date.UTC(2026, 0, 15, 12, 30)
const tx: FlowMeasure = { type: 'apm.transaction', service: 'shop-bff', transaction: 'POST /checkout' }
const span: FlowMeasure = { type: 'apm.span', service: 'shop-bff', destination: 'orders:8080' }

/** An hour of `durationsMs` calls, `failed` of them failures. */
function hour(at: number, durationsMs: number[], failed = 0, codes?: Record<string, number>): FlowHour {
  const latency = new Map<number, number>()
  for (const ms of durationsMs) {
    const b = flowLatencyBucket(ms * 1000)
    latency.set(b, (latency.get(b) ?? 0) + 1)
  }
  return { at, count: durationsMs.length, failed, latency: [...latency], ...(codes ? { codes } : {}) }
}

describe('latency buckets', () => {
  it('grow by about 20% from 1 ms to 10 minutes', () => {
    expect(FLOW_LATENCY_BOUNDS_US[0]).toBe(1000)
    expect(FLOW_LATENCY_BOUNDS_US.at(-1)).toBeLessThanOrEqual(600_000_000)
    for (let i = 1; i < FLOW_LATENCY_BOUNDS_US.length; i++) expect(FLOW_LATENCY_BOUNDS_US[i]! / FLOW_LATENCY_BOUNDS_US[i - 1]!).toBeLessThan(1.21)
  })

  it('place a duration under the first bound above it', () => {
    expect(flowLatencyBucket(0)).toBe(0)
    expect(flowLatencyBucket(999)).toBe(0)
    expect(flowLatencyBucket(1000)).toBe(1)
    expect(flowLatencyBucket(10 ** 12)).toBe(FLOW_LATENCY_BOUNDS_US.length)
  })
})

describe('histogramPercentileMs', () => {
  it('is 0 without calls', () => {
    expect(histogramPercentileMs([], 95)).toBe(0)
  })

  it('reads percentiles within one bucket of the real value', () => {
    const durations = Array.from({ length: 1000 }, (_, i) => 10 + i) // 10 ms … 1009 ms
    const h = hour(0, durations)
    for (const [p, real] of [[50, 510], [95, 960], [99, 1000]] as const) {
      const got = histogramPercentileMs(h.latency, p)
      expect(Math.abs(got - real) / real).toBeLessThan(0.2)
    }
  })

  it('caps calls slower than the last bound at that bound', () => {
    expect(histogramPercentileMs([[FLOW_LATENCY_BOUNDS_US.length, 3]], 50)).toBeCloseTo(FLOW_LATENCY_BOUNDS_US.at(-1)! / 1000, 1)
  })
})

describe('histogramShareOverMs', () => {
  it('is 0 for an empty histogram and counts whole buckets above the duration', () => {
    expect(histogramShareOverMs([], 5000)).toBe(0)
    const latency: [number, number][] = [[flowLatencyBucket(1_000_000), 60], [flowLatencyBucket(9_000_000), 40]]
    expect(histogramShareOverMs(latency, 5000)).toBeCloseTo(0.4, 5)
    expect(histogramShareOverMs(latency, 100)).toBeCloseTo(1, 5)
    expect(histogramShareOverMs(latency, 60_000)).toBe(0)
  })

  it('interpolates inside the bucket the duration falls in, and counts the overflow bucket as slower', () => {
    const b = flowLatencyBucket(5_000_000)
    const lo = FLOW_LATENCY_BOUNDS_US[b - 1]!
    const hi = FLOW_LATENCY_BOUNDS_US[b]!
    const mid = (lo + hi) / 2 / 1000
    expect(histogramShareOverMs([[b, 10]], mid)).toBeCloseTo(0.5, 5)
    expect(histogramShareOverMs([[FLOW_LATENCY_BOUNDS_US.length, 3], [0, 3]], 700_000)).toBeCloseTo(0.5, 5)
  })

  it('agrees with the percentiles of the same histogram', () => {
    const latency: [number, number][] = [[flowLatencyBucket(200_000), 30], [flowLatencyBucket(800_000), 30], [flowLatencyBucket(4_000_000), 40]]
    expect(histogramShareOverMs(latency, histogramPercentileMs(latency, 60))).toBeCloseTo(0.4, 2)
  })
})

describe('flowHistoryKey', () => {
  it('tells transactions from spans and is shared by equal measures', () => {
    expect(flowHistoryKey(tx)).toBe('tx|shop-bff|POST /checkout')
    expect(flowHistoryKey(span)).toBe('span|shop-bff|orders:8080')
    expect(flowHistoryKey({ ...tx })).toBe(flowHistoryKey(tx))
  })
})

describe('flowHistoryGap and mergeFlowHistory', () => {
  it('asks for a whole week the first time', () => {
    expect(flowHistoryGap(undefined, NOW)).toEqual({ from: hourStart(NOW) - (FLOW_HISTORY_HOURS - 1) * H, to: NOW })
  })

  it('then asks only from the first hour that is not final', () => {
    const first = mergeFlowHistory(undefined, [hour(hourStart(NOW) - 2 * H, [10])], flowHistoryStart(NOW), NOW)
    // 12:30 minus 15 minutes is 12:15: the 11:00 hour ended at 12:00, so it is final; 12:00 is not.
    expect(first.settledUntil).toBe(hourStart(NOW))
    const later = NOW + 10 * 60_000
    expect(flowHistoryGap(first, later)).toEqual({ from: hourStart(NOW), to: later })
  })

  it('keeps the last hour open until it is old enough', () => {
    const justAfter = hourStart(NOW) + 5 * 60_000 // 12:05: the 11:00 hour ended five minutes ago
    const merged = mergeFlowHistory(undefined, [], flowHistoryStart(justAfter), justAfter)
    expect(merged.settledUntil).toBe(hourStart(justAfter - FLOW_HISTORY_SETTLE_MS))
    expect(merged.settledUntil).toBe(hourStart(NOW) - H)
  })

  it('replaces the hours it read again and keeps the older ones', () => {
    const open = hourStart(NOW)
    const stored = mergeFlowHistory(undefined, [hour(open - 3 * H, [5]), hour(open, [5, 5])], flowHistoryStart(NOW), NOW)
    const merged = mergeFlowHistory(stored, [hour(open, [5, 5, 5])], open, NOW + 60_000)
    expect(merged.hours.map((h) => [h.at, h.count])).toEqual([[open - 3 * H, 1], [open, 3]])
  })

  it('drops hours older than a week and empty hours', () => {
    const old = flowHistoryStart(NOW) - H
    const merged = mergeFlowHistory({ hours: [hour(old, [5])], settledUntil: old + H, fetchedAt: 0 }, [hour(hourStart(NOW), [])], hourStart(NOW), NOW)
    expect(merged.hours).toEqual([])
  })
})

describe('sumFlowHours', () => {
  it('adds calls, failures, buckets and results', () => {
    const sum = sumFlowHours([hour(0, [5, 50], 1, { 'HTTP 2xx': 1, 'HTTP 5xx': 1 }), hour(H, [5], 0, { 'HTTP 2xx': 1 })])
    expect(sum.count).toBe(3)
    expect(sum.failed).toBe(1)
    expect(sum.latency.reduce((s, [, n]) => s + n, 0)).toBe(3)
    expect(sum.codes).toEqual({ 'HTTP 2xx': 2, 'HTTP 5xx': 1 })
  })
})

describe('flowTimingFromHistory', () => {
  const open = hourStart(NOW)
  const hours = [
    hour(open - 60 * H, [100, 100], 0), // in the week, before the previous 24 h
    hour(open - 25 * H, [200], 1), // previous window
    hour(open - 2 * H, [10, 20, 30], 1, { 'HTTP 2xx': 2, 'HTTP 5xx': 1 }),
    hour(open, [40])
  ]

  it('reads the window hour by hour, the hour in course included', () => {
    const t = flowTimingFromHistory(hours, tx, NOW, 24)
    expect(t.hourly).toHaveLength(25)
    expect(t.hourly[0]!.at).toBe(open - 24 * H)
    expect(t.hourly.at(-1)).toMatchObject({ at: open, count: 1 })
    expect(t.count).toBe(4)
    expect(t.failed).toBe(1)
    expect(t.errorRate).toBeCloseTo(0.25)
    expect(t.perMinute).toBeCloseTo(4 / (24 * 60 + 30), 2)
    expect(t.codes).toEqual([{ code: 'HTTP 2xx', count: 2 }, { code: 'HTTP 5xx', count: 1 }])
  })

  it('compares with the window before and the week', () => {
    const t = flowTimingFromHistory(hours, tx, NOW, 24)
    expect(t.previous).toMatchObject({ count: 1, errorRate: 1 })
    expect(t.weekly?.count).toBe(7)
  })

  it('leaves the results out for spans', () => {
    expect(flowTimingFromHistory(hours, span, NOW, 24).codes).toBeUndefined()
  })

  it('is all zeros without calls', () => {
    const t = flowTimingFromHistory([], tx, NOW, 3)
    expect(t).toMatchObject({ count: 0, p50Ms: 0, p95Ms: 0, failed: 0 })
    expect(t.hourly.map((h) => h.count)).toEqual([0, 0, 0, 0])
  })

  it('covers a full hour of real time with a 1 h window, early in the hour', () => {
    // 12:30: the window is 11:00 to 12:30, not only the half hour in course.
    const t = flowTimingFromHistory([hour(open - H, [10, 10, 10]), hour(open, [10])], tx, NOW, 1)
    expect(t.count).toBe(4)
    expect(t.hourly.map((h) => h.at)).toEqual([open - H, open])
    expect(t.perMinute).toBeCloseTo(4 / 90, 2)
  })

  it('compares with as many whole hours as the window has, just before it', () => {
    const t = flowTimingFromHistory([hour(open - 3 * H, [10]), hour(open - 2 * H, [10, 10]), hour(open - 4 * H, [10, 10, 10, 10])], tx, NOW, 1)
    // Window: open - 1 h and open. Previous: open - 3 h and open - 2 h.
    expect(t.count).toBe(0)
    expect(t.previous?.count).toBe(3)
  })
})
