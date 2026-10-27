import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
    private readonly delayMs = 500
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

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending === null) return
    const value = this.pending
    this.pending = null
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
