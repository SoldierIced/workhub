import { join } from 'node:path'
import type { RendererReport } from '../shared/api'
import { describeError, redact } from './ipc-timing'
import { Activity, LagMonitor } from './lag-monitor'
import { RotatingLog, type Logger } from './log-file'

export interface Diagnostics {
  log: Logger
  activity: Activity
  /** The folder holding `main.log` and its rotated copies. */
  logsDir: string
  /** The live log file, to reveal in the file manager. */
  logPath: string
  /** Writes what is buffered (quitting). */
  flush(): void
}

/**
 * The always-on diagnostics of the main process: a rotated log in `<dataDir>/logs`, uncaught
 * errors and unhandled rejections, and event-loop stalls with the work that ran then. Cheap enough
 * to stay on in the installed app; only names, durations and counts are written.
 */
export function startDiagnostics(dataDir: string, info: { version: string; packaged: boolean }): Diagnostics {
  const logsDir = join(dataDir, 'logs')
  const log = new RotatingLog(logsDir, 'main')
  const activity = new Activity()
  log.info(`start version=${info.version} packaged=${info.packaged} platform=${process.platform} arch=${process.arch} electron=${process.versions['electron'] ?? '?'}`)
  process.on('uncaughtException', (err) => log.error(`uncaught ${describeError(err)} ${stackTop(err)}`))
  process.on('unhandledRejection', (reason) => log.error(`unhandled rejection ${describeError(reason)} ${stackTop(reason)}`))
  const monitor = new LagMonitor({
    activity,
    onLag: ({ blockedMs, during }) => log.warn(`event loop blocked ${blockedMs}ms${during.length ? ` during: ${during.slice(0, 5).join(', ')}` : ''}`)
  })
  monitor.start()
  return { log, activity, logsDir, logPath: log.path, flush: () => log.flush() }
}

/** Where an error was thrown: the first frames, file names and lines only. */
function stackTop(err: unknown): string {
  if (!(err instanceof Error) || !err.stack) return ''
  const frames = err.stack
    .split('\n')
    .slice(1, 4)
    .map((l) => l.trim().replace(/^at\s+/, ''))
  return frames.length ? `at ${redact(frames.join(' < '), 400)}` : ''
}

/** Reports a renderer accepts per kind and minute; more are counted and dropped. */
const RENDERER_PER_MINUTE = 20

/**
 * Writes what a renderer reported (long tasks, errors) after checking its shape: unknown fields are
 * ignored, text is redacted and cut. At most `RENDERER_PER_MINUTE` lines per kind and minute.
 */
export function rendererReporter(log: Logger, now: () => number = Date.now): (window: string, report: unknown) => void {
  const windows = new Map<string, { minute: number; count: number; dropped: number }>()
  return (window, report) => {
    const r = parseReport(report)
    if (!r) return
    const minute = Math.floor(now() / 60_000)
    const key = r.kind
    const slot = windows.get(key)
    if (!slot || slot.minute !== minute) {
      if (slot?.dropped) log.warn(`renderer ${key}: ${slot.dropped} more reports dropped`)
      windows.set(key, { minute, count: 1, dropped: 0 })
    } else if (slot.count >= RENDERER_PER_MINUTE) {
      slot.dropped++
      return
    } else slot.count++
    const where = redact(window, 40)
    if (r.kind === 'longtask') log.warn(`renderer ${where} long tasks count=${r.count} max=${r.maxMs}ms total=${r.totalMs}ms`)
    else log.error(`renderer ${where} ${r.kind} ${redact(r.message)}${r.source ? ` at ${redact(r.source, 160)}` : ''}`)
  }
}

const int = (v: unknown, max = 3_600_000): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : null)
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v.slice(0, 500) : undefined)

/** A renderer report, or null when it is not one. */
export function parseReport(raw: unknown): RendererReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r['kind'] === 'longtask') {
    const count = int(r['count'], 100_000)
    const maxMs = int(r['maxMs'])
    const totalMs = int(r['totalMs'])
    return count && maxMs !== null && totalMs !== null ? { kind: 'longtask', count, maxMs, totalMs } : null
  }
  if (r['kind'] === 'error' || r['kind'] === 'rejection') {
    const message = text(r['message'])
    return message ? { kind: r['kind'], message, source: text(r['source']) } : null
  }
  return null
}
