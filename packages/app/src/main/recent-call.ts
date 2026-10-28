/**
 * An expensive read shared by its callers: calls made while one runs wait for it instead of
 * starting their own, and a caller that accepts a result up to `maxAgeMs` old gets the last one.
 * A failure is never kept: the next call tries again.
 */
export class RecentCall<T> {
  private running: Promise<T> | null = null
  private last: { at: number; value: T } | null = null

  constructor(
    private readonly fn: () => Promise<T>,
    private readonly now: () => number = Date.now
  ) {}

  get(maxAgeMs = 0): Promise<T> {
    if (this.running) return this.running
    if (this.last && maxAgeMs > 0 && this.now() - this.last.at <= maxAgeMs) return Promise.resolve(this.last.value)
    const run = this.fn().then((value) => {
      this.last = { at: this.now(), value }
      return value
    })
    this.running = run
    const clear = () => {
      if (this.running === run) this.running = null
    }
    run.then(clear, clear)
    return run
  }
}
