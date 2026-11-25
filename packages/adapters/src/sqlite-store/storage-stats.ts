/**
 * Rows and approximate size of each group of tables in `workhub.db`, for Settings → Advanced → Data.
 * Sizes come from SQLite's `dbstat` table (the pages each table and its indexes take); where that
 * table is missing they are null. Reading every page of a large file takes a moment, so the app runs
 * this in its report worker. This file keeps to type imports (the worker loads it as is).
 */
import type { DatabaseSync } from 'node:sqlite'

export type StorageGroup = 'usageDetail' | 'usageSummaries' | 'historyIndex' | 'events' | 'pullRequests' | 'state'

export const STORAGE_GROUPS: readonly StorageGroup[] = ['usageDetail', 'usageSummaries', 'historyIndex', 'events', 'pullRequests', 'state']

/** The tables whose rows each group counts (History's full-text tables are counted by session, in `history_index`). */
export const STORAGE_ROW_TABLES: Record<StorageGroup, readonly string[]> = {
  usageDetail: ['turns', 'sessions', 'session_links', 'session_tags', 'turn_files'],
  usageSummaries: ['turns_daily'],
  historyIndex: ['history_index'],
  events: ['pr_events', 'ticket_events', 'automation_runs'],
  pullRequests: ['merged_prs', 'merged_found', 'merged_coverage'],
  state: ['kv_state', 'flow_maps', 'flow_history_measures', 'flow_history_hours']
}

export interface StorageGroupStats {
  group: StorageGroup
  rows: number
  /** Bytes of its tables and indexes; null when SQLite cannot tell (no `dbstat`). */
  bytes: number | null
}

export interface StorageStats {
  groups: StorageGroupStats[]
  /** Pages no table uses any more (deleted rows): what compacting gives back. Null when not known. */
  freeBytes: number | null
}

/** The group a table (or a table an index belongs to) is in; anything not listed is app state. */
export function storageGroupOf(table: string): StorageGroup {
  const name = table.toLowerCase()
  if (name.startsWith('history_')) return 'historyIndex'
  for (const group of STORAGE_GROUPS) if (STORAGE_ROW_TABLES[group].includes(name)) return group
  return 'state'
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0)

/** Rows and bytes per group, and the free pages; `db` may be read-only. */
export function storageStats(db: { raw: DatabaseSync }): StorageStats {
  const objects = db.raw.prepare("SELECT name, tbl_name AS tbl, type FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string; tbl: string; type: string }[]
  const tables = new Set(objects.filter((o) => o.type === 'table').map((o) => o.name.toLowerCase()))
  const owner = new Map(objects.map((o) => [o.name, o.tbl]))
  const rows = new Map<StorageGroup, number>(STORAGE_GROUPS.map((g) => [g, 0]))
  for (const group of STORAGE_GROUPS) {
    for (const table of STORAGE_ROW_TABLES[group]) {
      if (!tables.has(table)) continue
      rows.set(group, rows.get(group)! + num((db.raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: unknown }).n))
    }
  }
  let bytes: Map<StorageGroup, number> | null = new Map(STORAGE_GROUPS.map((g) => [g, 0]))
  try {
    const pages = db.raw.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all() as { name: string; bytes: unknown }[]
    for (const p of pages) {
      const group = storageGroupOf(owner.get(p.name) ?? p.name)
      bytes.set(group, bytes.get(group)! + num(p.bytes))
    }
  } catch {
    // This SQLite was built without dbstat.
    bytes = null
  }
  let freeBytes: number | null = null
  try {
    const free = num((db.raw.prepare('PRAGMA freelist_count').get() as Record<string, unknown>)['freelist_count'])
    const size = num((db.raw.prepare('PRAGMA page_size').get() as Record<string, unknown>)['page_size'])
    freeBytes = free * size
  } catch {
    freeBytes = null
  }
  return { groups: STORAGE_GROUPS.map((group) => ({ group, rows: rows.get(group)!, bytes: bytes ? bytes.get(group)! : null })), freeBytes }
}
