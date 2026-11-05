import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A JSON state file in the data folder (watcher threads, automation runs), written atomically
 * (temp file, then rename) and at most every `delayMs`; `flush` writes what is pending now.
 */
export class StateFile<T> {
  private pending: T | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly path: string,
    private readonly delayMs = 500,
    private readonly log: (message: string) => void = (message) => console.warn(message)
  ) {}

  /** The stored value merged over `fallback`; `fallback` when the file is missing or unreadable. */
  load(fallback: T): T {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...fallback, ...(raw as Partial<T>) } : fallback
    } catch {
      return fallback
    }
  }

  save(value: T): void {
    this.pending = value
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.delayMs)
    this.timer.unref?.()
  }

  /**
   * Writes the pending value now. A failed write keeps it pending (the next `save` or `flush`
   * tries again), removes its temp file and is logged, never thrown: state files are best effort.
   */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending === null) return
    const value = this.pending
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
      renameSync(tmp, this.path)
      // A `save` made while writing (none today: this is synchronous) would have replaced `pending`.
      if (this.pending === value) this.pending = null
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Nothing more to tidy.
      }
      this.log(`could not write ${this.path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
