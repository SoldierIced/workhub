import type { MergedCoverage, MergedPullRequest, MergedSearch, MergedStore, StoredMergedPullRequest } from '@workhub/core'
import type { WorkhubDb } from './db'

interface PrRow {
  profile_id: string
  url: string
  provider: string
  owner: string
  repo: string
  number: number
  title: string
  author: string
  branch: string
  base: string
  merged_at: number
  created_at: number | null
  additions: number | null
  deletions: number | null
  changed_files: number | null
}

const orUndefined = (v: number | null): number | undefined => (v === null ? undefined : Number(v))
const orNull = (v: number | undefined): number | null => (v === undefined ? null : v)

function toStored(row: PrRow): StoredMergedPullRequest {
  const pr: MergedPullRequest = {
    provider: row.provider,
    owner: row.owner,
    repo: row.repo,
    number: Number(row.number),
    url: row.url,
    title: row.title,
    author: row.author,
    branch: row.branch,
    base: row.base,
    mergedAt: Number(row.merged_at)
  }
  const createdAt = orUndefined(row.created_at)
  const additions = orUndefined(row.additions)
  const deletions = orUndefined(row.deletions)
  const changedFiles = orUndefined(row.changed_files)
  if (createdAt !== undefined) pr.createdAt = createdAt
  if (additions !== undefined) pr.additions = additions
  if (deletions !== undefined) pr.deletions = deletions
  if (changedFiles !== undefined) pr.changedFiles = changedFiles
  return { profileId: row.profile_id, pr }
}

/** A search not read for this long is forgotten by the daily upkeep (its coverage, and the rows no other search found). */
export const MERGED_UNUSED_MS = 90 * 86_400_000

/**
 * Forgets the searches no read has used since `cutoff` (a scope or account no longer in use: each change
 * starts a new search), then the pull requests no remaining search found. One search per transaction and
 * a few hundred rows per delete, with the event loop let go between them. Returns what it removed.
 */
export async function pruneMergedSearches(db: WorkhubDb, cutoff: number, pause: () => Promise<void>, batch = 500): Promise<{ searches: number; pullRequests: number }> {
  const out = { searches: 0, pullRequests: 0 }
  if (!db.isOpen) return out
  // Last used: its newest read, or for a search that never covered a range (a cut list), its newest saved row.
  const stale = db.raw
    .prepare(
      `SELECT profile_id, search_key FROM (
         SELECT profile_id, search_key, MAX(at) AS used FROM merged_coverage GROUP BY profile_id, search_key
         UNION ALL
         SELECT f.profile_id, f.search_key, MAX(p.saved_at) AS used FROM merged_found f JOIN merged_prs p ON p.profile_id = f.profile_id AND p.url = f.url
         WHERE NOT EXISTS (SELECT 1 FROM merged_coverage c WHERE c.profile_id = f.profile_id AND c.search_key = f.search_key)
         GROUP BY f.profile_id, f.search_key
       ) GROUP BY profile_id, search_key HAVING MAX(used) < ?`
    )
    .all(cutoff) as unknown as Array<{ profile_id: string; search_key: string }>
  const dropCoverage = db.raw.prepare('DELETE FROM merged_coverage WHERE profile_id = ? AND search_key = ?')
  const dropFound = db.raw.prepare('DELETE FROM merged_found WHERE profile_id = ? AND search_key = ?')
  for (const s of stale) {
    if (!db.isOpen) return out
    db.transaction(() => {
      dropCoverage.run(s.profile_id, s.search_key)
      dropFound.run(s.profile_id, s.search_key)
    })
    out.searches++
    await pause()
  }
  const orphans = db.raw.prepare(
    `DELETE FROM merged_prs WHERE rowid IN (SELECT p.rowid FROM merged_prs p WHERE NOT EXISTS (SELECT 1 FROM merged_found f WHERE f.profile_id = p.profile_id AND f.url = p.url) LIMIT ?)`
  )
  for (;;) {
    if (!db.isOpen) return out
    const changes = Number(db.transaction(() => orphans.run(batch)).changes)
    out.pullRequests += changes
    if (changes < batch) return out
    await pause()
  }
}

/**
 * Merged pull requests and the ranges read for each search, in `merged_prs`, `merged_found` and
 * `merged_coverage`. A value the host did not report is stored as NULL and read back as undefined.
 */
export class SqliteMergedStore implements MergedStore {
  constructor(
    private readonly db: WorkhubDb,
    private readonly now: () => number = Date.now
  ) {}

  async save(search: MergedSearch, items: readonly MergedPullRequest[]): Promise<void> {
    if (items.length === 0) return
    this.db.write('merged pull requests', () =>
      this.db.transaction(() => {
        const upsert = this.db.raw.prepare(
          `INSERT INTO merged_prs (profile_id, url, provider, owner, repo, number, title, author, branch, base, merged_at, created_at, additions, deletions, changed_files, saved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id, url) DO UPDATE SET provider = excluded.provider, owner = excluded.owner, repo = excluded.repo, number = excluded.number,
             title = excluded.title, author = excluded.author, branch = excluded.branch, base = excluded.base, merged_at = excluded.merged_at,
             created_at = excluded.created_at, additions = excluded.additions, deletions = excluded.deletions, changed_files = excluded.changed_files,
             saved_at = excluded.saved_at`
        )
        const found = this.db.raw.prepare('INSERT OR IGNORE INTO merged_found (profile_id, search_key, url) VALUES (?, ?, ?)')
        const savedAt = this.now()
        for (const p of items) {
          upsert.run(search.profileId, p.url, p.provider, p.owner, p.repo, p.number, p.title, p.author, p.branch, p.base, p.mergedAt, orNull(p.createdAt), orNull(p.additions), orNull(p.deletions), orNull(p.changedFiles), savedAt)
          found.run(search.profileId, search.key, p.url)
        }
      })
    )
  }

  async read(searches: readonly MergedSearch[], since: number, until: number): Promise<StoredMergedPullRequest[]> {
    if (searches.length === 0 || since >= until) return []
    const where = searches.map(() => '(f.profile_id = ? AND f.search_key = ?)').join(' OR ')
    const params = searches.flatMap((s) => [s.profileId, s.key])
    const rows = this.db.raw
      .prepare(
        `SELECT p.* FROM merged_prs p JOIN merged_found f ON f.profile_id = p.profile_id AND f.url = p.url
         WHERE (${where}) AND p.merged_at >= ? AND p.merged_at < ?
         GROUP BY p.profile_id, p.url
         ORDER BY p.merged_at DESC, p.number DESC, p.url ASC, p.profile_id ASC`
      )
      .all(...params, since, until) as unknown as PrRow[]
    return rows.map(toStored)
  }

  async count(searches: readonly MergedSearch[], since: number, until: number): Promise<number> {
    if (searches.length === 0 || since >= until) return 0
    const where = searches.map(() => '(f.profile_id = ? AND f.search_key = ?)').join(' OR ')
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM merged_prs p JOIN merged_found f ON f.profile_id = p.profile_id AND f.url = p.url
         WHERE (${where}) AND p.merged_at >= ? AND p.merged_at < ? GROUP BY p.profile_id, p.url)`
      )
      .get(...searches.flatMap((s) => [s.profileId, s.key]), since, until) as { n: number } | undefined
    return Number(row?.n ?? 0)
  }

  async covered(search: MergedSearch): Promise<MergedCoverage[]> {
    const rows = this.db.raw.prepare('SELECT since, until, at FROM merged_coverage WHERE profile_id = ? AND search_key = ? ORDER BY since ASC, until ASC').all(search.profileId, search.key) as unknown as MergedCoverage[]
    return rows.map((r) => ({ since: Number(r.since), until: Number(r.until), at: Number(r.at) }))
  }

  async cover(search: MergedSearch, since: number, until: number, at: number): Promise<void> {
    if (since >= until) return
    this.db.write('merged pull request coverage', () =>
      this.db.transaction(() => {
        // Ranges that overlap or touch the new one are joined with it.
        const touching = this.db.raw
          .prepare('SELECT rowid AS id, since, until, at FROM merged_coverage WHERE profile_id = ? AND search_key = ? AND since <= ? AND until >= ?')
          .all(search.profileId, search.key, until, since) as unknown as Array<{ id: number; since: number; until: number; at: number }>
        let joined: MergedCoverage = { since, until, at }
        for (const r of touching) {
          const range = { since: Number(r.since), until: Number(r.until), at: Number(r.at) }
          // The newest end decides `at`: reading an older range never makes it look fresh.
          const newest = range.until > joined.until || (range.until === joined.until && range.at > joined.at) ? range : joined
          joined = { since: Math.min(joined.since, range.since), until: Math.max(joined.until, range.until), at: newest.at }
        }
        const remove = this.db.raw.prepare('DELETE FROM merged_coverage WHERE rowid = ?')
        for (const r of touching) remove.run(r.id)
        this.db.raw.prepare('INSERT INTO merged_coverage (profile_id, search_key, since, until, at) VALUES (?, ?, ?, ?, ?)').run(search.profileId, search.key, joined.since, joined.until, joined.at)
      })
    )
  }
}
