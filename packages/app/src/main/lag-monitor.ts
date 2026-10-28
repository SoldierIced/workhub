import { performance } from 'node:perf_hooks'

/** One piece of main-process work, named for the log (an IPC channel, a scan). */
interface Span {
  label: string
  start: number
  end: number | null
}

/**
 * What the main process is doing: named spans of work, kept for a few seconds after they end, so
 * a stall found afterwards (the lag monitor only wakes up once the block is over) can say what ran.
 */
export class Activity {
  private readonly open = new Set<Span>()
  private ended: Span[] = []

  constructor(
    private readonly now: () => number = () => performance.now(),
    /** Ended spans older than this are forgotten. */
    private readonly keepMs = 10_000
  ) {}

  /** Starts a span; call the returned function when the work ends. */
  begin(label: string): () => void {
    const span: Span = { label, start: this.now(), end: null }
    this.open.add(span)
    return () => {
      if (span.end !== null) return
      span.end = this.now()
      this.open.delete(span)
      this.ended.push(span)
      if (this.ended.length > 200) this.ended = this.ended.slice(-100)
    }
  }

  /** Runs `fn` as a span; a rejected promise ends it too. */
  async run<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    const end = this.begin(label)
    try {
      return await fn()
    } finally {
      end()
    }
  }

  /** The labels of the spans that ran during [from, to], most recent first, each once. */
  during(from: number, to: number): string[] {
    const cutoff = this.now() - this.keepMs
    this.ended = this.ended.filter((s) => (s.end ?? 0) >= cutoff)
    const hits = [...this.ended, ...this.open].filter((s) => s.start <= to && (s.end ?? Infinity) >= from).sort((a, b) => b.start - a.start)
    return [...new Set(hits.map((s) => s.label))]
  }
}

export interface LagMonitorOptions {
  /** A block longer than this is reported (200 ms by default). */
  thresholdMs?: number
  /** How often the loop is sampled (100 ms by default). */
  intervalMs?: number
  now?: () => number
  /** What ran during the block, if anything was named (see `Activity`). */
  activity?: Activity
  onLag: (lag: { blockedMs: number; during: string[] }) => void
}

/**
 * Watches the main event loop: a timer that should fire every `intervalMs` and fires late was held
 * up by synchronous work. A delay over the threshold is reported with the named work that ran then.
 */
export class LagMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private last: number | null = null
  private readonly thresholdMs: number
  private readonly intervalMs: number

  constructor(private readonly options: LagMonitorOptions) {
    this.thresholdMs = options.thresholdMs ?? 200
    this.intervalMs = options.intervalMs ?? 100
  }

  private now(): number {
    return this.options.now?.() ?? performance.now()
  }

  start(): void {
    if (this.timer) return
    this.last = this.now()
    this.timer = setInterval(() => this.check(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.last = null
  }

  /** One sample: how long past its due time this tick came (reported over the threshold); null on the first. */
  check(at = this.now()): number | null {
    const prev = this.last
    this.last = at
    if (prev === null) return null
    const blockedMs = Math.max(0, at - prev - this.intervalMs)
    if (blockedMs >= this.thresholdMs) this.options.onLag({ blockedMs: Math.round(blockedMs), during: this.options.activity?.during(prev, at) ?? [] })
    return blockedMs
  }
}
