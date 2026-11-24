/**
 * Runs one task per key at a time. A forced request made while one runs is queued (at most one waiting) and
 * runs right after it, so a refresh asked after a write is never dropped; every caller waits for the run that
 * covers it. A plain request made meanwhile joins the run in flight.
 */
export class RunQueue {
  private readonly running = new Map<string, Promise<void>>()
  private readonly waiting = new Map<string, Promise<void>>()

  request(key: string, force: boolean, task: () => Promise<void>): Promise<void> {
    const running = this.running.get(key)
    if (!running) return this.start(key, task)
    if (!force) return running
    let next = this.waiting.get(key)
    if (!next) {
      next = running.then(() => {
        this.waiting.delete(key)
        return this.start(key, task)
      })
      this.waiting.set(key, next)
    }
    return next
  }

  busy(key: string): boolean {
    return this.running.has(key)
  }

  private start(key: string, task: () => Promise<void>): Promise<void> {
    const p = task()
      .catch(() => undefined)
      .finally(() => {
        if (this.running.get(key) === p) this.running.delete(key)
      })
    this.running.set(key, p)
    return p
  }
}
