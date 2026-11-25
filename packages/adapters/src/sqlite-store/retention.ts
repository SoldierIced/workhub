/**
 * Keeps the usage data from growing without end. Turns older than the retention (12 months, to the
 * local midnight) move into daily summaries in `turns_daily`, one row per local day, session, agent,
 * model, folder, project and priced or not, and are deleted; pull request and ticket events and
 * automation runs older than it are deleted. Sessions, their links and tags stay: the reports group
 * and filter the summaries through them as they did the turns, and count each session once.
 *
 * The job is bounded: one day of turns per transaction and a few hundred rows per delete, with the
 * event loop let go between them, so it never holds the main process for long. Running it again
 * changes nothing. Once a day is summed, `TurnIngest` skips turns older than `rolledUntil`, so a
 * transcript read again (a resumed old session, a rewritten file) never counts them twice.
 */
import type { WorkhubDb } from './db'
import { MERGED_UNUSED_MS, pruneMergedSearches } from './merged-prs'

/** How long the usage detail (turns), timeline events and automation runs are kept, in months. */
export const USAGE_RETENTION_MONTHS = 12
/** The `kv_state` key of the job's state (`RetentionState`). */
export const RETENTION_KEY = 'usage-retention'
/** Rows per delete transaction when pruning. */
export const PRUNE_BATCH = 500

export interface RetentionState {
  /** Turns before this time (epoch ms, a local midnight) are in the daily summaries only. */
  rolledUntil: number
  /** When the job last finished. */
  lastRunAt: number
}

export interface RetentionResult {
  /** The boundary of this run: what is older was summed or pruned. */
  cutoff: number
  /** Days of turns summed. */
  days: number
  turns: number
  /** Summary rows written (new or added to). */
  summaries: number
  prEvents: number
  ticketEvents: number
  automationRuns: number
  /** Merged-view searches not used for `MERGED_UNUSED_MS`, forgotten, and the merged pull requests only they had found. */
  mergedSearches: number
  mergedPullRequests: number
}

export interface RetentionOptions {
  now?: () => number
  months?: number
  /** Lets the event loop run between transactions (`setImmediate` by default). */
  pause?: () => Promise<void>
}

/** Local midnight of the day holding `at`. */
function dayOf(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Local midnight of the day after the one starting at `day` (23 or 25 hours on a clock change). */
function nextDay(day: number): number {
  const d = new Date(day)
  d.setDate(d.getDate() + 1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The local midnight `months` months before the day holding `now`: older detail is summed. */
export function retentionCutoff(now: number, months = USAGE_RETENTION_MONTHS): number {
  const d = new Date(dayOf(now))
  d.setMonth(d.getMonth() - months)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The job's state; zeros before its first run. */
export function retentionState(db: Pick<WorkhubDb, 'raw'>): RetentionState {
  try {
    const row = db.raw.prepare('SELECT value FROM kv_state WHERE key = ?').get(RETENTION_KEY) as { value: string } | undefined
    const v = row ? (JSON.parse(row.value) as Partial<RetentionState>) : {}
    return { rolledUntil: typeof v.rolledUntil === 'number' ? v.rolledUntil : 0, lastRunAt: typeof v.lastRunAt === 'number' ? v.lastRunAt : 0 }
  } catch {
    return { rolledUntil: 0, lastRunAt: 0 }
  }
}

function saveState(db: WorkhubDb, state: RetentionState, at: number): void {
  db.raw
    .prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(RETENTION_KEY, JSON.stringify(state), at)
}

interface Group {
  session_id: string
  agent: string
  model: string | null
  cwd: string | null
  project: string | null
  priced: number
  at: number
  last_at: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  usd: number | null
  turn_ms: number
  turns: number
}

/** Sums the turns of one local day into `turns_daily` (adding to a row already there) and deletes them; one transaction. */
function rollDay(db: WorkhubDb, day: number, end: number, now: number): { turns: number; summaries: number } {
  return db.transaction(() => {
    const groups = db.raw
      .prepare(
        `SELECT session_id, agent, model, cwd, project, (usd IS NOT NULL) AS priced, MIN(at) AS at, MAX(at) AS last_at,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens, SUM(usd) AS usd, SUM(CASE WHEN sidechain = 0 THEN turn_ms ELSE 0 END) AS turn_ms, COUNT(*) AS turns
         FROM turns WHERE at >= ? AND at < ? GROUP BY session_id, agent, model, cwd, project, priced`
      )
      .all(day, end) as unknown as Group[]
    // NULLs never match in a unique index, so the row of a group is found with IS, not an upsert.
    const add = db.raw.prepare(
      `UPDATE turns_daily SET at = MIN(at, ?), last_at = MAX(last_at, ?), input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         cache_write_tokens = cache_write_tokens + ?, cache_read_tokens = cache_read_tokens + ?, usd = CASE WHEN ? IS NULL THEN usd ELSE COALESCE(usd, 0) + ? END,
         turn_ms = turn_ms + ?, turns = turns + ?
       WHERE day = ? AND session_id = ? AND agent = ? AND model IS ? AND cwd IS ? AND project IS ? AND priced = ?`
    )
    const insert = db.raw.prepare(
      `INSERT INTO turns_daily (day, session_id, agent, model, cwd, project, priced, at, last_at, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, turn_ms, turns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    let turns = 0
    for (const g of groups) {
      turns += g.turns
      const changed = add.run(g.at, g.last_at, g.input_tokens, g.output_tokens, g.cache_write_tokens, g.cache_read_tokens, g.usd, g.usd, g.turn_ms, g.turns, day, g.session_id, g.agent, g.model, g.cwd, g.project, g.priced)
      if (Number(changed.changes) === 0) {
        insert.run(day, g.session_id, g.agent, g.model, g.cwd, g.project, g.priced, g.at, g.last_at, g.input_tokens, g.output_tokens, g.cache_write_tokens, g.cache_read_tokens, g.usd, g.turn_ms, g.turns)
      }
    }
    db.raw.prepare('DELETE FROM turns WHERE at >= ? AND at < ?').run(day, end)
    const state = retentionState(db)
    saveState(db, { ...state, rolledUntil: Math.max(state.rolledUntil, end) }, now)
    return { turns, summaries: groups.length }
  })
}

/**
 * Sums turns older than the retention into daily summaries and prunes events and automation runs
 * older than it, in small transactions. Stops early (with what it did) when the database closes.
 */
export async function applyRetention(db: WorkhubDb, options: RetentionOptions = {}): Promise<RetentionResult> {
  const now = options.now?.() ?? Date.now()
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
  const cutoff = retentionCutoff(now, options.months)
  const result: RetentionResult = { cutoff, days: 0, turns: 0, summaries: 0, prEvents: 0, ticketEvents: 0, automationRuns: 0, mergedSearches: 0, mergedPullRequests: 0 }
  const oldest = db.raw.prepare('SELECT MIN(at) AS at FROM turns WHERE at < ?')
  for (;;) {
    if (!db.isOpen) return result
    const row = oldest.get(cutoff) as { at: number | null } | undefined
    if (row?.at === null || row?.at === undefined) break
    const day = dayOf(row.at)
    const r = rollDay(db, day, Math.min(nextDay(day), cutoff), now)
    result.days++
    result.turns += r.turns
    result.summaries += r.summaries
    await pause()
  }
  const prune = async (table: string, column: string): Promise<number> => {
    let total = 0
    const del = db.raw.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`)
    for (;;) {
      if (!db.isOpen) return total
      const changes = Number(db.transaction(() => del.run(cutoff, PRUNE_BATCH)).changes)
      total += changes
      if (changes < PRUNE_BATCH) return total
      await pause()
    }
  }
  result.prEvents = await prune('pr_events', 'at')
  result.ticketEvents = await prune('ticket_events', 'at')
  result.automationRuns = await prune('automation_runs', 'started_at')
  const merged = await pruneMergedSearches(db, now - MERGED_UNUSED_MS, pause, PRUNE_BATCH)
  result.mergedSearches = merged.searches
  result.mergedPullRequests = merged.pullRequests
  if (db.isOpen) db.transaction(() => saveState(db, { rolledUntil: Math.max(retentionState(db).rolledUntil, cutoff), lastRunAt: now }, now))
  return result
}
