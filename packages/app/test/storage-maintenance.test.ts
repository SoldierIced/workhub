import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { retentionCutoff, storageStats, type WorkhubDb } from '@workhub/adapters/sqlite-store'
import { AnalyticsQueries, forkQueryWorker, type QueryWorker } from '../src/main/analytics-queries'
import type { WorkerReply } from '../src/main/analytics-worker'
import { registerStorageMaintenanceIpc, StorageMaintenance } from '../src/main/storage-maintenance'
import { openTestDb } from './test-db'

const HOUR = 3_600_000
const NOW = new Date(2026, 10, 15, 12).getTime()
const noPause = () => Promise.resolve()

/** Old and recent turns of one session, with some bulk so compacting has something to give back. */
function seed(db: WorkhubDb, old = 2000): void {
  db.raw.prepare("INSERT INTO sessions (id, agent, profile_id, source, updated_at) VALUES ('s1', 'claude', 'p1', 'workhub', 0)").run()
  const turn = db.raw.prepare("INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, usd, cwd, project, turn_ms) VALUES ('s1', 'claude', ?, ?, 'sonnet', 100, 10, 0.25, ?, '/w/acme', 60000)")
  const cutoff = retentionCutoff(NOW)
  db.transaction(() => {
    for (let i = 0; i < old; i++) turn.run(`old-${i}`, cutoff - 40 * 86_400_000 + i * 60_000, `/w/acme/${'x'.repeat(200)}`)
    turn.run('new', NOW - HOUR, '/w/acme')
  })
}

describe('StorageMaintenance', () => {
  it('reads rows and size per group, the file size and the retention for the panel', async () => {
    const db = openTestDb()
    seed(db, 10)
    const m = new StorageMaintenance({ db, now: () => NOW, pause: noPause })
    const before = await m.usage()
    expect(before).toMatchObject({ retentionMonths: 12, lastRunAt: null })
    expect(before.fileBytes).toBeGreaterThan(0)
    expect(before.groups.map((g) => [g.group, g.rows])).toEqual([
      ['usageDetail', 12],
      ['usageSummaries', 0],
      ['historyIndex', 0],
      ['events', 0],
      ['pullRequests', 0],
      ['state', expect.any(Number)]
    ])
    await m.run()
    const after = await m.usage()
    expect(after.lastRunAt).toBe(NOW)
    expect(after.groups.find((g) => g.group === 'usageDetail')!.rows).toBe(2)
    expect(after.groups.find((g) => g.group === 'usageSummaries')!.rows).toBe(1)
  })

  it('takes the figures from the worker when it has one', async () => {
    const db = openTestDb()
    const stats = { groups: [{ group: 'events' as const, rows: 3, bytes: 4096 }], freeBytes: 0 }
    const usage = await new StorageMaintenance({ db, stats: async () => stats }).usage()
    expect(usage.groups).toEqual(stats.groups)
  })

  it('compacts: runs the job, then VACUUM while the workers are stopped, and the file shrinks', async () => {
    const db = openTestDb()
    seed(db)
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const steps: string[] = []
    const m = new StorageMaintenance({
      db,
      now: () => NOW,
      pause: noPause,
      exclusive: async (task) => {
        steps.push(`exclusive with ${db.raw.prepare('SELECT COUNT(*) AS n FROM turns').get()!['n']} turns`)
        const r = await task()
        steps.push('released')
        return r
      }
    })
    const r = await m.compact()
    expect(steps).toEqual(['exclusive with 1 turns', 'released'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.afterBytes).toBeLessThan(r.beforeBytes)
    expect(storageStats(db).freeBytes).toBe(0)
  })

  it('answers a failed compact with its error', async () => {
    const db = openTestDb()
    const m = new StorageMaintenance({ db, now: () => NOW, pause: noPause, exclusive: async () => Promise.reject(new Error('worker stuck')) })
    expect(await m.compact()).toEqual({ ok: false, error: 'worker stuck' })
  })

  it('registers the panel channels', async () => {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    registerStorageMaintenanceIpc({ handle: (c, h) => void handlers.set(c, h), on: () => undefined }, { usage: async () => 'usage' as never, compact: async () => ({ ok: true, beforeBytes: 2, afterBytes: 1 }) })
    expect([...handlers.keys()]).toEqual(['storage:usage', 'storage:compact'])
    expect(await handlers.get('storage:compact')!({} as IpcMainInvokeEvent)).toEqual({ ok: true, beforeBytes: 2, afterBytes: 1 })
  })
})

describe('AnalyticsQueries.exclusive', () => {
  /** A worker that answers reports after a tick and exits when killed. */
  function worker() {
    const log: string[] = []
    let spawned = 0
    const spawn = (): QueryWorker => {
      const n = ++spawned
      let reply: (m: WorkerReply) => void = () => undefined
      let exit: (code: number | null) => void = () => undefined
      return {
        post: (m) => {
          if (m.type === 'init') return
          log.push(`worker ${n}: ${m.type}`)
          if (m.type === 'report' || m.type === 'storage') setTimeout(() => reply({ type: 'report', id: m.id, value: m.type }), 5)
        },
        onMessage: (fn) => (reply = fn),
        onExit: (fn) => (exit = fn),
        kill: () => {
          log.push(`worker ${n}: killed`)
          setTimeout(() => exit(null), 1)
        }
      }
    }
    return { spawn, log }
  }

  it('waits for the reports before it, runs with no worker alive, and later reports start a new one', async () => {
    const w = worker()
    const queries = new AnalyticsQueries({ spawn: w.spawn, path: '/tmp/none.db' })
    const first = queries.report({ name: 'filters', query: {} })
    const task = queries.exclusive(async () => {
      w.log.push('task')
      return 'done'
    })
    const after = queries.storage()
    expect(await Promise.all([first, task, after])).toEqual(['report', 'done', 'storage'])
    expect(w.log).toEqual(['worker 1: report', 'worker 1: killed', 'task', 'worker 2: storage'])
  })
})

const WORKER = resolve(__dirname, '../src/main/analytics-worker.ts')
const ELECTRON = ((): string | undefined => {
  try {
    const path: unknown = createRequire(import.meta.url)('electron')
    return typeof path === 'string' && existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
})()
const STRIPS_TYPES = Number(process.versions.node.split('.')[0]) >= 23

describe.skipIf(!STRIPS_TYPES && !ELECTRON)('the real worker', () => {
  const opened: AnalyticsQueries[] = []
  afterEach(() => {
    for (const q of opened.splice(0)) q.close()
  })

  it('reads the storage figures as the main process would, despite the agents’ guard', async () => {
    const db = openTestDb()
    seed(db, 50)
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const queries = new AnalyticsQueries({ spawn: forkQueryWorker(WORKER, STRIPS_TYPES ? {} : { execPath: ELECTRON!, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }), path: db.path, budgetMs: 10_000 })
    opened.push(queries)
    expect(await queries.storage()).toEqual(storageStats(db))
    // A VACUUM between two reports, with the worker stopped, leaves the next report working.
    await queries.exclusive(async () => void db.raw.exec('VACUUM'))
    expect(await queries.storage()).toEqual(storageStats(db))
  })
})
