// Push subscriptions outlive the process (a phone subscribes once): a JSON file, rewritten whole
// shortly after a change (changes in the same moment share one write). Endpoints and keys only,
// never a message. A write that fails is logged by the caller; the records stay in memory.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PushRecord, PushStore } from './core'

export class FilePushStore implements PushStore {
  private readonly records = new Map<string, PushRecord>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(
    private readonly path: string,
    private readonly delayMs = 250
  ) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, PushRecord>
      for (const [id, record] of Object.entries(parsed)) if (record && typeof record === 'object' && record.sub?.endpoint) this.records.set(id, record)
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  get(id: string) {
    return this.records.get(id)
  }

  set(id: string, record: PushRecord) {
    this.records.set(id, record)
    this.schedule()
  }

  delete(id: string) {
    if (this.records.delete(id)) this.schedule()
  }

  size(): number {
    return this.records.size
  }

  /** Writes now what is pending (shutdown, tests). Throws when the disk refuses. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty) return
    this.dirty = false
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records)), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      try {
        this.flush()
      } catch (err) {
        console.warn(`${new Date().toISOString()} warn push store write failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, this.delayMs)
    this.timer.unref?.()
  }
}
