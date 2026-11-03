/**
 * The flow-map history on disk: `<dataDir>/flow-history/<scope>.json`, one file per profile,
 * connection and environment, holding the hourly aggregates of every measure for a week (see
 * `@workhub/core` flow-history). Hours older than a week are dropped on every write, and a file
 * that has not been written for a week (an environment or a connection that is gone) is deleted.
 */
import { createHash } from 'node:crypto'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { FLOW_HISTORY_HOURS, flowHistoryStart, type FlowMeasureHistory } from '@workhub/core'
import { StateFile } from './state-file'

export const FLOW_HISTORY_FOLDER = 'flow-history'
const FILE_VERSION = 1
const WEEK_MS = FLOW_HISTORY_HOURS * 3_600_000

interface HistoryFile {
  version: number
  measures: Record<string, FlowMeasureHistory>
}

/** The file name of a scope: a hash, so ids and connection details never end up in a path. */
export const flowHistoryFileName = (scope: string): string => `${createHash('sha256').update(scope).digest('hex').slice(0, 24)}.json`

export class FlowHistoryStore {
  private readonly files = new Map<string, { file: StateFile<HistoryFile>; data: HistoryFile }>()

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly delayMs = 2_000
  ) {}

  private open(scope: string) {
    let entry = this.files.get(scope)
    if (!entry) {
      const file = new StateFile<HistoryFile>(join(this.dir, flowHistoryFileName(scope)), this.delayMs)
      const loaded = file.load({ version: FILE_VERSION, measures: {} })
      const data = loaded.version === FILE_VERSION && loaded.measures && typeof loaded.measures === 'object' ? loaded : { version: FILE_VERSION, measures: {} }
      entry = { file, data }
      this.files.set(scope, entry)
    }
    return entry
  }

  get(scope: string, key: string): FlowMeasureHistory | undefined {
    return this.open(scope).data.measures[key]
  }

  set(scope: string, key: string, history: FlowMeasureHistory): void {
    const entry = this.open(scope)
    entry.data.measures[key] = history
    const start = flowHistoryStart(this.now())
    // Measures nobody asked for in a week (a map removed or edited) go with their hours.
    for (const [k, h] of Object.entries(entry.data.measures)) {
      h.hours = h.hours.filter((x) => x.at >= start)
      if (this.now() - h.fetchedAt > WEEK_MS) delete entry.data.measures[k]
    }
    entry.file.save(entry.data)
  }

  /** Writes what is pending now (on quit). */
  flush(): void {
    for (const { file } of this.files.values()) file.flush()
  }

  /** Deletes the files not written for a week; returns how many. */
  prune(): number {
    let removed = 0
    let names: string[]
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'))
    } catch {
      return 0
    }
    for (const name of names) {
      const path = join(this.dir, name)
      try {
        if (this.now() - statSync(path).mtimeMs > WEEK_MS) {
          unlinkSync(path)
          removed++
        }
      } catch {
        // Gone already, or not ours to delete: nothing to do.
      }
    }
    return removed
  }
}
