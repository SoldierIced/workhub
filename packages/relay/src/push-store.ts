// Push subscriptions outlive the process (a phone subscribes once): a JSON file, written whole on
// every change. Endpoints and keys only, never a message.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PushRecord, PushStore } from './core'

export class FilePushStore implements PushStore {
  private readonly records = new Map<string, PushRecord>()

  constructor(private readonly path: string) {
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
    this.flush()
  }

  delete(id: string) {
    if (this.records.delete(id)) this.flush()
  }

  size(): number {
    return this.records.size
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records), null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
