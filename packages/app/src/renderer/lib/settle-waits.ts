/**
 * Waits for main's "prompt settled" notice, by session and prompt token. Electron does not order an
 * invoke's answer with the events sent meanwhile, so `prompt()`'s answer can come before the turn's
 * last message; the notice travels with those events and so comes after it. A notice can also
 * arrive before anyone waits for it: it is kept until then.
 */
export class SettleWaits {
  private readonly waiting = new Map<string, () => void>()
  private readonly early = new Set<string>()

  /** Main's notice for `key` arrived. */
  notify(key: string): void {
    const done = this.waiting.get(key)
    if (done) done()
    else this.early.add(key)
  }

  /** Resolves once the notice for `key` arrived, or after `waitMs` (a window that missed it). */
  wait(key: string, waitMs: number): Promise<void> {
    if (this.early.delete(key)) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiting.delete(key)
        resolve()
      }
      const timer = setTimeout(done, waitMs)
      this.waiting.set(key, done)
    })
  }
}
