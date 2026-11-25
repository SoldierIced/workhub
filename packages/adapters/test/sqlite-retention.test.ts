import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRetention,
  DB_FILE,
  filterValues,
  PRUNE_BATCH,
  refreshSessionTotals,
  retentionCutoff,
  retentionState,
  SessionRecords,
  sessionsTable,
  spendGroups,
  spendSeries,
  spendTotals,
  storageGroupOf,
  storageStats,
  TurnIngest,
  USAGE_RETENTION_MONTHS,
  weeklySummary,
  WorkhubDb,
  type SessionSort,
  type SpendFilters,
  type SpendGroupBy
} from '../src/sqlite-store'

const dirs: string[] = []
const dbs: WorkhubDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-retention-'))
  dirs.push(d)
  return d
}
const openDb = () => {
  const db = WorkhubDb.open(join(tmp(), DB_FILE), { log: () => {} })
  dbs.push(db)
  return db
}
const count = (db: WorkhubDb, table: string) => Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
const noPause = () => Promise.resolve()

const HOUR = 3_600_000
const MIN = 60_000
/** Local midnight of a calendar day (month from 1). */
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()
const NOW = day(2026, 11, 15) + 12 * HOUR
const CUTOFF = retentionCutoff(NOW)

/**
 * Sessions of two profiles, agents and accounts, linked to tickets, a pull request and tags, whose
 * turns run from two months before the retention boundary to after it (one session spans it), with
 * priced and unpriced models, sub-agent turns and several folders. Dollars are binary fractions, so
 * sums in any order are exact.
 */
function seed(db: WorkhubDb): void {
  const session = db.raw.prepare("INSERT INTO sessions (id, agent, account_id, profile_id, cwd, project, title, started_at, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'workhub', 0)")
  const turn = db.raw.prepare(
    'INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms, sidechain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const plans = [
    { id: 's1', agent: 'claude', account: null, profile: 'p1', start: day(2025, 11, 10), days: 12 },
    { id: 's2', agent: 'codex', account: 'a1', profile: 'p1', start: day(2025, 9, 20), days: 5 },
    { id: 's3', agent: 'claude', account: 'a1', profile: 'p2', start: day(2025, 10, 3), days: 3 },
    { id: 's4', agent: 'kiro', account: null, profile: 'p2', start: day(2025, 11, 14), days: 1 },
    { id: 's5', agent: 'claude', account: null, profile: null, start: day(2026, 10, 1), days: 4 },
    { id: 's6', agent: 'codex', account: 'a1', profile: 'p1', start: day(2025, 10, 30), days: 2 }
  ]
  const models = ['sonnet', 'opus', null]
  const folders: [string | null, string | null][] = [
    ['/w/acme/api', '/w/acme'],
    ['/w/acme/web', '/w/acme'],
    ['/w/tools', null]
  ]
  let k = 0
  db.transaction(() => {
    for (const p of plans) {
      session.run(p.id, p.agent, p.account, p.profile, '/w/acme/api', '/w/acme', `Session ${p.id}`, p.start + 9 * HOUR)
      for (let d = 0; d < p.days; d++) {
        const base = new Date(p.start)
        base.setDate(base.getDate() + d)
        for (let i = 0; i < 7; i++) {
          k++
          const at = base.getTime() + (1 + i * 3) * HOUR + (k % 50) * MIN
          const model = p.agent === 'kiro' ? 'auto' : models[k % 3]!
          const priced = p.agent !== 'kiro' && model !== null && k % 5 !== 0
          const [cwd, project] = folders[k % 3]!
          const sidechain = k % 4 === 0 ? 1 : 0
          turn.run(p.id, p.agent, `m${k}`, at, model, 100 + k, 10 + (k % 7), k % 3, 1000 + k, priced ? (k % 8) * 0.125 : null, cwd, project, sidechain ? 0 : (k % 9) * MIN, sidechain)
        }
      }
    }
  })
  const records = new SessionRecords(db, () => day(2025, 9, 1))
  records.addLinks('s1', [
    { kind: 'ticket', ref: 'PAY-1', source: 'user' },
    { kind: 'ticket', ref: 'PAY-2', source: 'user' }
  ])
  records.addLinks('s2', [
    { kind: 'pr', ref: 'https://example.com/acme/api/pull/7', source: 'acted' },
    { kind: 'ticket', ref: 'PAY-1', source: 'tracker' }
  ])
  records.setTags('s3', ['idea'])
  records.setTags('s1', ['idea', 'spike'])
  for (const p of plans) refreshSessionTotals(db, p.id)
}

const GROUPS: SpendGroupBy[] = ['project', 'agent', 'model', 'account', 'ticket', 'pr', 'tag', 'none']
const FILTERS: SpendFilters[] = [
  {},
  { profileId: 'p1' },
  { ticket: 'PAY-1' },
  { pr: 'https://example.com/acme/api/pull/7' },
  { tag: 'idea' },
  { cwdPrefix: '/w/acme' },
  { project: '/w/acme' },
  { model: 'sonnet' },
  { agent: 'codex' },
  { account: 'a1' }
]
const SORTS: SessionSort[] = ['startedAt', 'usd', 'tokens', 'activeMs', 'title']

/** Every report the Usage screen and `/v1/analytics/report` read, over spans that cross the boundary. */
function everyReport(db: WorkhubDb) {
  const spans = [
    { since: day(2025, 9, 1), until: day(2026, 11, 16) },
    { since: day(2025, 10, 4), until: day(2025, 11, 20) }
  ]
  const out: Record<string, unknown> = {}
  for (const span of spans) {
    for (const groupBy of GROUPS) {
      for (const filters of FILTERS) {
        const key = `${span.since}:${groupBy}:${JSON.stringify(filters)}`
        out[`day ${key}`] = spendSeries(db, { ...span, bucket: 'day', groupBy, filters })
        out[`week ${key}`] = spendSeries(db, { ...span, bucket: 'week', groupBy, filters })
        out[`totals ${key}`] = spendTotals(db, { ...span, groupBy, filters })
        out[`groups ${key}`] = spendGroups(db, { ...span, groupBy, filters })
      }
    }
    for (const sort of SORTS) {
      for (const dir of ['asc', 'desc'] as const) {
        out[`sessions ${span.since} ${sort} ${dir}`] = sessionsTable(db, { ...span }, { sort, dir, limit: 50 })
        out[`sessions model ${span.since} ${sort} ${dir}`] = sessionsTable(db, { ...span, model: 'sonnet' }, { sort, dir, limit: 50, turnsOnly: true })
      }
    }
    out[`filters ${span.since}`] = filterValues(db, span)
    out[`filters p1 ${span.since}`] = filterValues(db, { ...span, profileId: 'p1' })
  }
  out['sessions all'] = sessionsTable(db, {}, { limit: 50 })
  for (const week of [day(2025, 9, 22), day(2025, 11, 10), day(2025, 11, 17)]) out[`weekly ${week}`] = weeklySummary(db, { weekStart: week })
  out['weekly p1'] = weeklySummary(db, { weekStart: day(2025, 11, 10), profileId: 'p1' })
  return out
}

describe('usage retention', () => {
  it('cuts at the local midnight twelve months back', () => {
    expect(USAGE_RETENTION_MONTHS).toBe(12)
    expect(CUTOFF).toBe(day(2025, 11, 15))
  })

  it('sums old turns into daily rows and every report reads the same across the boundary', async () => {
    const db = openDb()
    seed(db)
    const before = everyReport(db)
    const oldTurns = Number((db.raw.prepare('SELECT COUNT(*) AS n FROM turns WHERE at < ?').get(CUTOFF) as { n: number }).n)
    const recent = count(db, 'turns') - oldTurns
    expect(oldTurns).toBeGreaterThan(50)

    const r = await applyRetention(db, { now: () => NOW, pause: noPause })

    expect(r).toMatchObject({ cutoff: CUTOFF, turns: oldTurns })
    expect(count(db, 'turns')).toBe(recent)
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM turns WHERE at < ?').get(CUTOFF) as { n: number }).n)).toBe(0)
    expect(Number((db.raw.prepare('SELECT SUM(turns) AS n FROM turns_daily').get() as { n: number }).n)).toBe(oldTurns)
    expect(count(db, 'turns_daily')).toBe(r.summaries)
    expect(count(db, 'turns_daily')).toBeLessThan(oldTurns)
    // Sessions, links and tags stay: the summaries are grouped and filtered through them.
    expect(count(db, 'sessions')).toBe(6)
    expect(retentionState(db)).toEqual({ rolledUntil: CUTOFF, lastRunAt: NOW })

    const after = everyReport(db)
    for (const key of Object.keys(before)) expect(after[key], key).toEqual(before[key])
  })

  it('changes nothing when run again', async () => {
    const db = openDb()
    seed(db)
    await applyRetention(db, { now: () => NOW, pause: noPause })
    const rows = () => db.raw.prepare('SELECT * FROM turns_daily ORDER BY day, session_id, model, cwd, priced').all()
    const daily = rows()
    const turns = count(db, 'turns')
    const again = await applyRetention(db, { now: () => NOW + HOUR, pause: noPause })
    expect(again).toMatchObject({ days: 0, turns: 0, summaries: 0, prEvents: 0, ticketEvents: 0, automationRuns: 0 })
    expect(rows()).toEqual(daily)
    expect(count(db, 'turns')).toBe(turns)
  })

  it('adds turns that arrive later for a day already summed to its rows', async () => {
    const db = openDb()
    seed(db)
    await applyRetention(db, { now: () => NOW, pause: noPause })
    const row = db.raw.prepare("SELECT * FROM turns_daily WHERE session_id = 's2' AND model = 'sonnet' AND priced = 1 ORDER BY day LIMIT 1").get() as Record<string, number | string>
    db.raw
      .prepare("INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, usd, cwd, project, turn_ms) VALUES ('s2', 'codex', 'late', ?, 'sonnet', 7, 3, 0.5, ?, ?, 60000)")
      .run(Number(row['at']) + MIN, row['cwd'] as string, row['project'] as string)
    const rows = count(db, 'turns_daily')
    await applyRetention(db, { now: () => NOW, pause: noPause })
    expect(count(db, 'turns_daily')).toBe(rows)
    const merged = db.raw.prepare('SELECT * FROM turns_daily WHERE day = ? AND session_id = ? AND model = ? AND cwd = ? AND priced = 1').get(Number(row['day']), 's2', 'sonnet', String(row['cwd'])) as Record<string, number>
    expect(merged).toMatchObject({ turns: Number(row['turns']) + 1, input_tokens: Number(row['input_tokens']) + 7, usd: Number(row['usd']) + 0.5, turn_ms: Number(row['turn_ms']) + 60000 })
  })

  it("keeps a session's agent time when its turns are summed and it gets new ones", async () => {
    const db = openDb()
    seed(db)
    const active = () => Number((db.raw.prepare("SELECT active_ms FROM sessions WHERE id = 's1'").get() as { active_ms: number }).active_ms)
    const before = active()
    await applyRetention(db, { now: () => NOW, pause: noPause })
    refreshSessionTotals(db, 's1')
    expect(active()).toBe(before)
  })

  it('prunes events and automation runs older than the boundary, in batches', async () => {
    const db = openDb()
    const old = CUTOFF - HOUR
    const recent = CUTOFF + HOUR
    db.transaction(() => {
      const ticket = db.raw.prepare("INSERT INTO ticket_events (profile_id, key, kind, at, json) VALUES ('p1', 'PAY-1', 'status', ?, '{}')")
      for (let i = 0; i < PRUNE_BATCH * 2 + 3; i++) ticket.run(old - i)
      ticket.run(recent)
      const pr = db.raw.prepare("INSERT INTO pr_events (id, profile_id, repo, number, url, kind, at, json) VALUES (?, 'p1', 'acme/api', 7, 'https://example.com/acme/api/pull/7', 'merged', ?, '{}')")
      pr.run('old', old)
      pr.run('new', recent)
      const run = db.raw.prepare("INSERT INTO automation_runs (id, automation_id, trigger, started_at, status, summary_json) VALUES (?, 'auto', 'manual', ?, 'ok', '{}')")
      run.run('old', old)
      run.run('new', recent)
    })
    let pauses = 0
    const r = await applyRetention(db, { now: () => NOW, pause: async () => void pauses++ })
    expect(r).toMatchObject({ ticketEvents: PRUNE_BATCH * 2 + 3, prEvents: 1, automationRuns: 1 })
    expect(pauses).toBeGreaterThanOrEqual(2)
    expect(db.raw.prepare('SELECT at FROM ticket_events').all()).toEqual([{ at: recent }])
    expect(db.raw.prepare('SELECT id FROM pr_events').all()).toEqual([{ id: 'new' }])
    expect(db.raw.prepare('SELECT id FROM automation_runs').all()).toEqual([{ id: 'new' }])
  })

  it('never counts a summed turn again when its transcript is read again', async () => {
    const db = openDb()
    const root = tmp()
    const claude = join(root, '.claude')
    const folder = join(claude, 'projects', '-w-acme')
    mkdirSync(folder, { recursive: true })
    const iso = (ms: number) => new Date(ms).toISOString()
    const line = (id: string, at: number, extra = '') =>
      JSON.stringify({ type: 'assistant', cwd: '/w/acme', timestamp: iso(at), message: { id, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: `synthetic${extra}` }], usage: { input_tokens: 10, output_tokens: 5 } } })
    const file = join(folder, 'old.jsonl')
    const oldAt = day(2025, 10, 1) + 10 * HOUR
    const write = (extra = '') => writeFileSync(file, [line('a1', oldAt, extra), line('a2', oldAt + MIN, extra), line('a3', NOW - HOUR, extra)].join('\n') + '\n')
    write()
    const ingest = new TurnIngest(db, { projects: async (p) => Object.fromEntries(p.map((x) => [x, x])), now: () => NOW })
    const sources = { claudeDirs: [claude], codexHomes: [], kiroDirs: [] }
    await ingest.scan(sources)
    expect(count(db, 'turns')).toBe(3)
    await applyRetention(db, { now: () => NOW, pause: noPause })
    expect(count(db, 'turns')).toBe(1)
    const total = () => spendTotals(db, { since: 0, until: NOW + HOUR, groupBy: 'none' })[0]
    const before = total()
    expect(before).toMatchObject({ turns: 3, tokensIn: 30 })
    // The file is rewritten (its first bytes change): read again from the start.
    write(' again')
    await ingest.scan(sources)
    expect(count(db, 'turns')).toBe(1)
    expect(total()).toEqual(before)
  })
})

describe('storage figures', () => {
  it('counts rows and sizes per group, and the free pages', async () => {
    const db = openDb()
    seed(db)
    db.raw.prepare("INSERT INTO pr_events (id, profile_id, repo, url, kind, at, json) VALUES ('e', 'p1', 'acme/api', 'https://example.com/acme/api/pull/7', 'merged', ?, '{}')").run(NOW)
    const detail = count(db, 'turns') + count(db, 'sessions') + count(db, 'session_links') + count(db, 'session_tags') + count(db, 'turn_files')
    const stats = storageStats(db)
    const of = (g: string) => stats.groups.find((x) => x.group === g)!
    expect(stats.groups.map((g) => g.group)).toEqual(['usageDetail', 'usageSummaries', 'historyIndex', 'events', 'pullRequests', 'state'])
    expect(of('usageDetail').rows).toBe(detail)
    expect(of('usageSummaries').rows).toBe(0)
    expect(of('events').rows).toBe(1)
    expect(of('usageDetail').bytes).toBeGreaterThan(0)
    expect(typeof stats.freeBytes).toBe('number')

    await applyRetention(db, { now: () => NOW, pause: noPause })
    const after = storageStats(db)
    expect(after.groups.find((g) => g.group === 'usageSummaries')!.rows).toBe(count(db, 'turns_daily'))
    expect(after.groups.find((g) => g.group === 'usageSummaries')!.rows).toBeGreaterThan(0)
  })

  it('puts each table in its group, History and unknown tables included', () => {
    expect(storageGroupOf('turns')).toBe('usageDetail')
    expect(storageGroupOf('turns_daily')).toBe('usageSummaries')
    expect(storageGroupOf('history_fts_data')).toBe('historyIndex')
    expect(storageGroupOf('automation_runs')).toBe('events')
    expect(storageGroupOf('merged_prs')).toBe('pullRequests')
    expect(storageGroupOf('merged_coverage')).toBe('pullRequests')
    expect(storageGroupOf('kv_state')).toBe('state')
    expect(storageGroupOf('sqlite_schema')).toBe('state')
  })
})
