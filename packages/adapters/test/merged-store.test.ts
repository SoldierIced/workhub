import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MergedPullRequest } from '@workhub/core'
import { afterEach, describe, expect, it } from 'vitest'
import { DB_FILE, MIGRATIONS, SqliteMergedStore, WorkhubDb } from '../src/sqlite-store'
import { storageStats } from '../src/sqlite-store/storage-stats'

const dirs: string[] = []
const dbs: WorkhubDb[] = []
afterEach(() => {
  for (const d of dbs.splice(0)) d.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'wh-merged-'))
  dirs.push(d)
  return d
}
function open(dir = folder(), migrations?: typeof MIGRATIONS): WorkhubDb {
  const db = WorkhubDb.open(join(dir, DB_FILE), { log: () => {}, ...(migrations ? { migrations } : {}) })
  dbs.push(db)
  return db
}

const pr = (n: number, mergedAt: number, extra: Partial<MergedPullRequest> = {}): MergedPullRequest => ({
  provider: 'github',
  owner: 'acme',
  repo: 'api',
  number: n,
  url: `https://github.com/acme/api/pull/${n}`,
  title: `Change ${n}`,
  author: 'ana',
  branch: `feat/c-${n}`,
  base: 'main',
  mergedAt,
  ...extra
})
const A = { profileId: 'p1', key: 'all|github.com|org:acme' }
const B = { profileId: 'p1', key: 'mine|github.com|ana|org:acme' }
const OTHER = { profileId: 'p2', key: 'all|github.com|org:acme' }

describe('SqliteMergedStore: rows', () => {
  it('saves and reads back, newest merge first and the highest number first on a tie', async () => {
    const store = new SqliteMergedStore(open())
    await store.save(A, [pr(1, 100), pr(2, 300), pr(3, 300), pr(4, 200)])
    const rows = await store.read([A], 0, 1000)
    expect(rows.map((r) => r.pr.number)).toEqual([3, 2, 4, 1])
    expect(rows[0]).toEqual({ profileId: 'p1', pr: pr(3, 300) })
  })

  it('reads only [since, until)', async () => {
    const store = new SqliteMergedStore(open())
    await store.save(A, [pr(1, 100), pr(2, 200), pr(3, 300)])
    expect((await store.read([A], 100, 300)).map((r) => r.pr.number)).toEqual([2, 1])
    expect(await store.read([A], 300, 300)).toEqual([])
    expect(await store.read([], 0, 1000)).toEqual([])
  })

  it('upserts by profile and URL', async () => {
    const store = new SqliteMergedStore(open())
    await store.save(A, [pr(1, 100, { title: 'Old' })])
    await store.save(A, [pr(1, 100, { title: 'New', additions: 5 })])
    const rows = await store.read([A], 0, 1000)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.pr).toMatchObject({ title: 'New', additions: 5 })
  })

  it('keeps a missing value undefined and a zero a zero', async () => {
    const store = new SqliteMergedStore(open())
    await store.save(A, [pr(1, 100), pr(2, 200, { createdAt: 50, additions: 0, deletions: 0, changedFiles: 0 })])
    const [two, one] = (await store.read([A], 0, 1000)).map((r) => r.pr)
    expect(one).not.toHaveProperty('additions')
    expect(one).not.toHaveProperty('createdAt')
    expect(one).not.toHaveProperty('changedFiles')
    expect(two).toMatchObject({ createdAt: 50, additions: 0, deletions: 0, changedFiles: 0 })
  })

  it('remembers which search found each row, so another key does not see it', async () => {
    const store = new SqliteMergedStore(open())
    await store.save(A, [pr(1, 100), pr(2, 200)])
    await store.save(B, [pr(2, 200), pr(3, 300)])
    expect((await store.read([A], 0, 1000)).map((r) => r.pr.number)).toEqual([2, 1])
    expect((await store.read([B], 0, 1000)).map((r) => r.pr.number)).toEqual([3, 2])
    expect((await store.read([A, B], 0, 1000)).map((r) => r.pr.number)).toEqual([3, 2, 1])
  })

  it('reads across profiles: one entry per profile and URL', async () => {
    const store = new SqliteMergedStore(open())
    await store.save(A, [pr(1, 100), pr(2, 200)])
    await store.save(OTHER, [pr(2, 200), pr(3, 300)])
    const rows = await store.read([A, OTHER], 0, 1000)
    expect(rows.map((r) => `${r.profileId}:${r.pr.number}`)).toEqual(['p2:3', 'p1:2', 'p2:2', 'p1:1'])
    expect(await store.read([A], 0, 1000)).toHaveLength(2)
  })

  it('counts what read would return, without reading it', async () => {
    const store = new SqliteMergedStore(open())
    const B = { profileId: 'p2', key: 'all|github.com|org:acme' }
    await store.save(A, [pr(1, 1000), pr(2, 2000), pr(3, 3000)])
    await store.save(B, [pr(1, 1000)])
    expect(await store.count([A], 1500, 4000)).toBe(2)
    expect(await store.count([A, B], 0, 4000)).toBe((await store.read([A, B], 0, 4000)).length)
    expect(await store.count([], 0, 4000)).toBe(0)
    expect(await store.count([A], 5, 5)).toBe(0)
  })

  it('finds the searches of a pull request by index, so the prune of unfound rows stays fast', () => {
    const db = open()
    const plan = db.raw.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM merged_prs p WHERE NOT EXISTS (SELECT 1 FROM merged_found f WHERE f.profile_id = p.profile_id AND f.url = p.url)').all()
    expect(plan.map((r) => String(r.detail)).join('\n')).toMatch(/merged_found_url \(profile_id=\? AND url=\?\)/)
  })

  it('saving nothing changes nothing', async () => {
    const store = new SqliteMergedStore(open())
    await store.save(A, [])
    expect(await store.read([A], 0, 1000)).toEqual([])
  })
})

describe('SqliteMergedStore: coverage', () => {
  it('lists the ranges sorted by since', async () => {
    const store = new SqliteMergedStore(open())
    await store.cover(A, 500, 600, 1)
    await store.cover(A, 100, 200, 2)
    expect(await store.covered(A)).toEqual([
      { since: 100, until: 200, at: 2 },
      { since: 500, until: 600, at: 1 }
    ])
    expect(await store.covered(B)).toEqual([])
  })

  it('records nothing for an empty or inverted range', async () => {
    const store = new SqliteMergedStore(open())
    await store.cover(A, 100, 100, 1)
    await store.cover(A, 200, 100, 1)
    expect(await store.covered(A)).toEqual([])
  })

  it('joins overlapping and touching ranges into one', async () => {
    const store = new SqliteMergedStore(open())
    await store.cover(A, 100, 200, 1)
    await store.cover(A, 200, 300, 2)
    await store.cover(A, 250, 400, 3)
    await store.cover(A, 600, 700, 4)
    expect(await store.covered(A)).toEqual([
      { since: 100, until: 400, at: 3 },
      { since: 600, until: 700, at: 4 }
    ])
  })

  it('bridges two ranges with one that spans the gap', async () => {
    const store = new SqliteMergedStore(open())
    await store.cover(A, 100, 200, 1)
    await store.cover(A, 300, 400, 2)
    await store.cover(A, 150, 350, 3)
    expect(await store.covered(A)).toEqual([{ since: 100, until: 400, at: 2 }])
  })

  it('keeps the at of the range with the greatest until: an older range read later does not make the end look fresh', async () => {
    const store = new SqliteMergedStore(open())
    await store.cover(A, 200, 300, 10)
    await store.cover(A, 100, 200, 99)
    expect(await store.covered(A)).toEqual([{ since: 100, until: 300, at: 10 }])
  })

  it('takes the new at when the new range reaches further', async () => {
    const store = new SqliteMergedStore(open())
    await store.cover(A, 100, 200, 10)
    await store.cover(A, 150, 300, 20)
    expect(await store.covered(A)).toEqual([{ since: 100, until: 300, at: 20 }])
  })

  it('on a tie of until, the larger at wins', async () => {
    const store = new SqliteMergedStore(open())
    await store.cover(A, 100, 300, 10)
    await store.cover(A, 200, 300, 5)
    expect(await store.covered(A)).toEqual([{ since: 100, until: 300, at: 10 }])
    await store.cover(A, 250, 300, 30)
    expect(await store.covered(A)).toEqual([{ since: 100, until: 300, at: 30 }])
  })

  it('keeps each search and profile apart', async () => {
    const store = new SqliteMergedStore(open())
    await store.cover(A, 100, 200, 1)
    await store.cover(B, 150, 250, 2)
    await store.cover(OTHER, 100, 200, 3)
    expect(await store.covered(A)).toEqual([{ since: 100, until: 200, at: 1 }])
    expect(await store.covered(B)).toEqual([{ since: 150, until: 250, at: 2 }])
    expect(await store.covered(OTHER)).toEqual([{ since: 100, until: 200, at: 3 }])
  })
})

describe('migration 4', () => {
  it('upgrades an existing version 3 database, keeps its data and adds the three tables', () => {
    const dir = folder()
    const v3 = open(dir, MIGRATIONS.filter((m) => m.version <= 3))
    expect(v3.schemaVersion()).toBe(3)
    v3.raw.prepare("INSERT INTO kv_state (key, value, updated_at) VALUES ('k', '1', 0)").run()
    v3.close()
    dbs.splice(dbs.indexOf(v3), 1)
    const db = open(dir)
    expect(db.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version)
    expect((db.raw.prepare("SELECT value FROM kv_state WHERE key = 'k'").get() as { value: string }).value).toBe('1')
    const tables = (db.raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'merged_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
    expect(tables).toEqual(['merged_coverage', 'merged_found', 'merged_prs'])
  })
})

describe('storage figures', () => {
  it('count the three tables in the "pullRequests" group', async () => {
    const db = open()
    const store = new SqliteMergedStore(db)
    await store.save(A, [pr(1, 100), pr(2, 200)])
    await store.cover(A, 0, 300, 1)
    const group = storageStats(db).groups.find((g) => g.group === 'pullRequests')!
    // 2 rows + 2 found + 1 coverage
    expect(group.rows).toBe(5)
  })
})

describe('pruneMergedSearches', () => {
  const DAY = 86_400_000
  const pause = async () => {}

  it('forgets searches unused since the cutoff and the rows only they found, and keeps the rest', async () => {
    const { pruneMergedSearches } = await import('../src/sqlite-store/merged-prs')
    const db = open()
    const store = new SqliteMergedStore(db, () => 100 * DAY)
    const OLD = { profileId: 'p1', key: 'all|github.com|me|org:old' }
    const NEW = { profileId: 'p1', key: 'all|github.com|me|org:acme' }
    await store.save(OLD, [pr(1, 1000), pr(2, 2000)])
    await store.save(NEW, [pr(2, 2000), pr(3, 3000)])
    await store.cover(OLD, 0, 5000, 10 * DAY)
    await store.cover(NEW, 0, 5000, 99 * DAY)

    expect(await pruneMergedSearches(db, 50 * DAY, pause, 1)).toEqual({ searches: 1, pullRequests: 1 })
    expect(await store.covered(OLD)).toEqual([])
    expect(await store.read([OLD], 0, 5000)).toEqual([])
    expect((await store.read([NEW], 0, 5000)).map((r) => r.pr.number)).toEqual([3, 2])
    expect(await pruneMergedSearches(db, 50 * DAY, pause)).toEqual({ searches: 0, pullRequests: 0 })
  })

  it('judges a search that never covered a range by its newest saved row', async () => {
    const { pruneMergedSearches } = await import('../src/sqlite-store/merged-prs')
    const db = open()
    let now = 10 * DAY
    const store = new SqliteMergedStore(db, () => now)
    const CUT = { profileId: 'p1', key: 'all|gitlab|me|group:acme' }
    await store.save(CUT, [pr(1, 1000)])
    expect(await pruneMergedSearches(db, 5 * DAY, pause)).toEqual({ searches: 0, pullRequests: 0 })
    now = 20 * DAY
    expect(await pruneMergedSearches(db, 15 * DAY, pause)).toEqual({ searches: 1, pullRequests: 1 })
  })
})
