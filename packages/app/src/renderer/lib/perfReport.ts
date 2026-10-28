import type { RendererReport } from '@shared/api'

/** A long task shorter than this is not worth a log line. */
export const LONG_TASK_MS = 200
/** Long tasks are summed and sent at most this often. */
export const LONG_TASK_FLUSH_MS = 5_000
/** Errors sent per minute at most; the rest are dropped (main throttles too). */
export const ERRORS_PER_MINUTE = 10

/**
 * Sums long tasks over a few seconds into one report: how many, the longest and their total.
 * `add` returns the report to send once `flushMs` passed since the first task of the batch.
 */
export class LongTaskBatch {
  private count = 0
  private maxMs = 0
  private totalMs = 0
  private since: number | null = null

  constructor(
    private readonly thresholdMs = LONG_TASK_MS,
    private readonly flushMs = LONG_TASK_FLUSH_MS
  ) {}

  add(durationMs: number, now: number): RendererReport | null {
    if (durationMs < this.thresholdMs) return null
    this.count++
    this.maxMs = Math.max(this.maxMs, durationMs)
    this.totalMs += durationMs
    this.since ??= now
    return now - this.since >= this.flushMs ? this.take() : null
  }

  /** The batch so far (null when empty), started over. */
  take(): RendererReport | null {
    if (!this.count) return null
    const report: RendererReport = { kind: 'longtask', count: this.count, maxMs: Math.round(this.maxMs), totalMs: Math.round(this.totalMs) }
    this.count = 0
    this.maxMs = 0
    this.totalMs = 0
    this.since = null
    return report
  }
}

/** Lets `limit` events through per minute. */
export function perMinute(limit: number, now: () => number = Date.now): () => boolean {
  let minute = -1
  let count = 0
  return () => {
    const m = Math.floor(now() / 60_000)
    if (m !== minute) {
      minute = m
      count = 0
    }
    return ++count <= limit
  }
}

let started = false

/**
 * Sends the window's long tasks (over `LONG_TASK_MS`) and uncaught errors to the main log. Only
 * durations, counts and error messages: never what the window shows.
 */
export function startPerfReports(send: (report: RendererReport) => void = (r) => window.hub?.diagnostics?.report(r)): void {
  if (started || typeof window === 'undefined') return
  started = true
  const batch = new LongTaskBatch()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    const report = batch.take()
    if (report) send(report)
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ready = batch.add(entry.duration, performance.now())
        if (ready) send(ready)
        // A lone long task is sent too, a little later.
        else if (!timer && entry.duration >= LONG_TASK_MS) timer = setTimeout(flush, LONG_TASK_FLUSH_MS)
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    // No long task timing in this engine.
  }
  const allow = perMinute(ERRORS_PER_MINUTE)
  window.addEventListener('error', (e) => {
    if (!allow()) return
    send({ kind: 'error', message: String(e.message || 'error'), source: e.filename ? `${e.filename.split('/').pop()}:${e.lineno}:${e.colno}` : undefined })
  })
  window.addEventListener('unhandledrejection', (e) => {
    if (!allow()) return
    const reason: unknown = e.reason
    send({ kind: 'rejection', message: reason instanceof Error ? `${reason.name}: ${reason.message}` : 'non-error rejection' })
  })
}
