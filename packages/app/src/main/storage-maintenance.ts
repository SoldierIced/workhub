/**
 * The database's upkeep: once a day (a few minutes after start, then every 24 hours) the retention
 * job sums turns older than 12 months into daily summaries and prunes old events and automation
 * runs (`applyRetention`, in small transactions). Settings → Advanced → Data reads what each group of
 * data takes (`storage:usage`, counted in the report worker) and can compact the file now
 * (`storage:compact`: the job, then VACUUM and a checkpoint that empties the write-ahead log).
 *
 * VACUUM rewrites the whole file, so it runs while no worker process has it open: `exclusive` waits
 * for the report and agents' queries already running, stops their processes, and holds new ones
 * until it is done (they then start a new process).
 */
import { applyRetention, retentionState, storageStats, USAGE_RETENTION_MONTHS, type RetentionResult, type StorageStats, type WorkhubDb } from '@workhub/adapters/sqlite-store'
import type { StorageCompactResult, StorageUsage } from '../shared/api'
import type { IpcRegistrar } from './ipc-guard'

/** When the first daily run starts after launch: after the backup (30 s) and the first scans. */
export const MAINTENANCE_FIRST_DELAY_MS = 5 * 60_000
export const MAINTENANCE_EVERY_MS = 24 * 3_600_000

export interface StorageMaintenanceDeps {
  db: WorkhubDb
  /** The storage figures off the main process (the report worker); on `db` without it (tests). */
  stats?: () => Promise<StorageStats>
  /** Runs `task` while no worker holds the file open; `task` runs directly without it (tests). */
  exclusive?: <T>(task: () => Promise<T>) => Promise<T>
  log?: (message: string) => void
  now?: () => number
  pause?: () => Promise<void>
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class StorageMaintenance {
  private running: Promise<RetentionResult> | null = null
  private compacting: Promise<StorageCompactResult> | null = null
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(private readonly deps: StorageMaintenanceDeps) {}

  /** The retention job; a run already going is shared. */
  run(): Promise<RetentionResult> {
    this.running ??= applyRetention(this.deps.db, { now: this.deps.now, pause: this.deps.pause })
      .then((r) => {
        if (r.turns || r.prEvents || r.ticketEvents || r.automationRuns || r.mergedSearches || r.mergedPullRequests) {
          this.deps.log?.(`storage: ${r.turns} turns of ${r.days} days summed into ${r.summaries} rows; pruned ${r.prEvents} pull request events, ${r.ticketEvents} ticket events, ${r.automationRuns} automation runs, ${r.mergedSearches} unused merged searches and ${r.mergedPullRequests} merged pull requests only they had found`)
        }
        return r
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  /** The job, then VACUUM with no worker reading the file; one at a time. */
  compact(): Promise<StorageCompactResult> {
    this.compacting ??= this.compactOnce().finally(() => {
      this.compacting = null
    })
    return this.compacting
  }

  private async compactOnce(): Promise<StorageCompactResult> {
    const { db } = this.deps
    try {
      await this.run()
      const beforeBytes = db.sizeBytes()
      const vacuum = async () => {
        if (!db.isOpen) throw new Error('the database is closed')
        db.raw.exec('VACUUM')
        db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      }
      await (this.deps.exclusive ? this.deps.exclusive(vacuum) : vacuum())
      const afterBytes = db.sizeBytes()
      this.deps.log?.(`storage: compacted from ${beforeBytes} to ${afterBytes} bytes`)
      return { ok: true, beforeBytes, afterBytes }
    } catch (err) {
      this.deps.log?.(`storage: compact failed: ${describe(err)}`)
      return { ok: false, error: describe(err) }
    }
  }

  /** Rows and size per group, the free space, the file's size and the retention. */
  async usage(): Promise<StorageUsage> {
    const { db } = this.deps
    const stats = this.deps.stats ? await this.deps.stats() : storageStats(db)
    const last = retentionState(db).lastRunAt
    return { groups: stats.groups, freeBytes: stats.freeBytes, fileBytes: db.sizeBytes(), retentionMonths: USAGE_RETENTION_MONTHS, lastRunAt: last || null }
  }

  /** The daily runs (first after `MAINTENANCE_FIRST_DELAY_MS`). */
  start(): void {
    const daily = () => void this.run().catch((err: unknown) => this.deps.log?.(`storage: retention failed: ${describe(err)}`))
    const first = setTimeout(daily, MAINTENANCE_FIRST_DELAY_MS)
    const every = setInterval(daily, MAINTENANCE_EVERY_MS)
    first.unref?.()
    every.unref?.()
    this.timers.push(first, every)
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }
}

/** `storage:usage` and `storage:compact` (Settings window only: not in the remote allowlist). */
export function registerStorageMaintenanceIpc(ipc: IpcRegistrar, maintenance: Pick<StorageMaintenance, 'usage' | 'compact'>): void {
  ipc.handle('storage:usage', () => maintenance.usage())
  ipc.handle('storage:compact', () => maintenance.compact())
}
