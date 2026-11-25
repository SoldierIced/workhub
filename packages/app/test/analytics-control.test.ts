import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { AutomationRunLog, checkReadOnlySql, deniedTables, ensureHistoryIndex, Timelines, weekStartOf, type WorkhubDb } from '@workhub/adapters/sqlite-store'
import { afterEach, describe, expect, it } from 'vitest'
import { createAnalyticsControl, EXAMPLES, timeOf, type AnalyticsControlDeps } from '../src/main/analytics-control'
import { AnalyticsQueries, forkQueryWorker, type QueryWorker } from '../src/main/analytics-queries'
import { authorizerAvailable } from '../src/main/analytics-worker'
import { startLoopbackControlServer } from '../src/main/control-server'
import { openTestDb } from './test-db'

const WORKER = resolve(__dirname, '../src/main/analytics-worker.ts')
/** Electron's binary, as the `electron` package names it on this OS (undefined when not downloaded). */
const ELECTRON = ((): string | undefined => {
  try {
    const path: unknown = createRequire(import.meta.url)('electron')
    return typeof path === 'string' && existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
})()
/** The worker refuses every query without SQLite's authorizer (Node 22): run it where it exists, this Node or Electron's. */
const RUNTIME = authorizerAvailable() ? process.execPath : ELECTRON
const HOUR = 3_600_000
// Rows are recent so the examples (last 30 days, this month, last 7 days) find them. They also sit in
// the past and inside this local week and month, whatever the hour the tests run: within five hours of
// Monday 00:00 or of the 1st the steps between them shrink, or the weekly report of their week and the
// "this month" example would miss some.
const NOW = Date.now()
const PERIOD_START = Math.max(weekStartOf(NOW), new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), 1).getTime())
const STEP = Math.min(HOUR, Math.floor((NOW - PERIOD_START) / 5))
/** Between two turns of the same session: under a sixtieth of a step, so 30 of them stay within one. */
const TICK = Math.min(1000, Math.floor(STEP / 60))
const T0 = NOW - 5 * STEP
const PR = 'https://github.com/acme/api/pull/42'

const opened: { db: WorkhubDb; queries: AnalyticsQueries }[] = []
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.queries.close()
    o.db.close()
  }
})

function seed(db: WorkhubDb): void {
  const s = db.raw.prepare('INSERT INTO sessions (id, agent, profile_id, cwd, project, title, started_at, ended_at, active_ms, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  s.run('s1', 'claude', 'work', '/w/acme/api/src', '/w/acme/api', 'Fix login', T0, T0 + STEP, 600_000, 'workhub', NOW)
  s.run('s2', 'codex', 'home', '/w/acme/web', '/w/acme/web', 'Landing', T0 + 2 * STEP, T0 + 3 * STEP, 300_000, 'transcript', NOW)
  const t = db.raw.prepare('INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, usd, cwd, project, turn_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (let i = 0; i < 30; i++) t.run('s1', 'claude', `m${i}`, T0 + i * TICK, 'sonnet', 100, 10, 0.1, '/w/acme/api/src', '/w/acme/api', 20_000)
  t.run('s2', 'codex', 'm0', T0 + 2 * STEP, 'gpt', 50, 5, 0.5, '/w/acme/web', '/w/acme/web', 300_000)
  const link = db.raw.prepare('INSERT INTO session_links (session_id, kind, ref, source, at) VALUES (?, ?, ?, ?, ?)')
  link.run('s1', 'ticket', 'ABC-123', 'user', T0)
  link.run('s1', 'ticket', 'ABC-124', 'user', T0)
  link.run('s1', 'pr', PR, 'acted', T0)
  db.raw.prepare('INSERT INTO session_tags (session_id, tag, at) VALUES (?, ?, ?)').run('s2', 'idea', T0)
  new AutomationRunLog(db).record([{ id: 'r1', automationId: 'a1', automationName: 'Triage', trigger: 'interval', queuedAt: T0, startedAt: T0, endedAt: T0 + TICK, outcome: 'error', detail: 'agent failed', merged: 0 }], () => 'work')
  new Timelines(db).appendPrEvents('work', [{ id: 'acme/api#42|approved|1', name: 'acme/api#42', url: PR, kind: 'approved', at: T0, title: 'Fix login', actor: 'ana' } as never])
  db.raw.prepare('INSERT INTO ticket_events (profile_id, key, kind, at, from_value, to_value, title, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('work', 'ABC-123', 'status', T0, 'To do', 'In progress', 'Fix login', '{}')
  db.raw.prepare('INSERT INTO turn_files (path, agent, session_id, size, mtime_ms, offset, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('/w/t.jsonl', 'claude', 's1', 10, 1, 10, NOW)
  db.raw.prepare('INSERT INTO flow_maps (id, json, updated_at) VALUES (?, ?, ?)').run('checkout', '{"id":"checkout"}', NOW)
  db.raw.prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)').run('remote-pairing', '{"secret":"x"}', NOW)
  db.raw.exec('CREATE VIEW kv_view AS SELECT * FROM kv_state')
  ensureHistoryIndex(db)
}

function setup(over: Partial<AnalyticsControlDeps> = {}, runner: { budgetMs?: number; execPath?: string; spawn?: () => QueryWorker } = {}) {
  const db = openTestDb()
  seed(db)
  const logs: string[] = []
  const execPath = runner.execPath ?? RUNTIME
  const queries = new AnalyticsQueries({
    path: db.path,
    spawn: runner.spawn ?? forkQueryWorker(WORKER, execPath && execPath !== process.execPath ? { execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
    ...(runner.budgetMs ? { budgetMs: runner.budgetMs } : {}),
    log: (m) => logs.push(m)
  })
  opened.push({ db, queries })
  const control = createAnalyticsControl({
    sessionProfile: (id) => (id === 'sess-work' || id === 'sess-review' ? 'work' : undefined),
    sessionReadOnly: (id) => id === 'sess-review',
    profiles: async () => ({ ids: ['work', 'home'], active: 'work' }),
    db,
    queries,
    log: (m) => logs.push(m),
    ...over
  })
  /** Runs SQL on the worker without the text check: what a query that slipped past it would reach. */
  const raw = (sql: string, params: (string | number)[] = []) => {
    const tables = (db.raw.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`).all() as { name: string }[]).map((r) => r.name)
    return queries.run(sql, params, 100, [...deniedTables(tables)])
  }
  return { db, queries, control, logs, raw }
}

const q = (s: string) => new URLSearchParams(s)
const none = q('')
type Rows = { columns: string[]; rows: unknown[][] }

describe.skipIf(!RUNTIME)('analytics schema', () => {
  it('describes the tables, how to query and examples', async () => {
    const { control } = setup()
    const r = await control.schema(q('session=sess-work'))
    expect(r.status).toBe(200)
    const body = r.body as { tables: { name: string; columns: unknown[] }[]; howTo: string[]; examples: { title: string; sql: string }[]; readable: string[]; projectMeaning: string }
    expect(body.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['sessions', 'turns', 'session_links', 'session_tags', 'automation_runs', 'pr_events', 'ticket_events', 'flow_maps', 'flow_history_measures', 'flow_history_hours']))
    expect(body.readable).not.toContain('turn_files')
    expect(body.readable).not.toContain('history_index')
    expect(body.readable).not.toContain('kv_state')
    expect(body.readable).toContain('sqlite_master')
    expect(body.howTo.join(' ')).toMatch(/lower case/)
    expect(body.projectMeaning).toMatch(/repository/)
    expect(body.examples.length).toBeGreaterThanOrEqual(8)
    for (const e of body.examples) expect(checkReadOnlySql(e.sql), e.title).toBeNull()
  })

  it('every example returns at least one non-null value on a seeded database', async () => {
    const { control } = setup()
    for (const e of EXAMPLES) {
      const r = await control.query({ sql: e.sql, params: e.params }, none)
      expect(r.status, e.title).toBe(200)
      const { rows } = r.body as Rows
      expect(rows.length, e.title).toBeGreaterThan(0)
      expect(rows.flat().some((v) => v !== null), e.title).toBe(true)
    }
  })
})

describe.skipIf(!RUNTIME)('the workhub-analytics skill', () => {
  it('only shows queries that run and return something', async () => {
    const { control } = setup()
    const text = readFileSync(resolve(__dirname, '../../../skills/workhub-analytics/SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
    const blocks = [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!)
    expect(blocks.length).toBeGreaterThanOrEqual(6)
    for (const sql of blocks) {
      const named = /:pr\b/.test(sql) ? { pr: PR } : /:n\b/.test(sql) ? { n: 42 } : undefined
      const params = named ?? (sql.match(/\?/g) ?? []).map((_, i) => (sql.includes('repo = ?') ? ['acme/api', 42][i]! : 'ABC-123'))
      const r = await control.query({ sql, params }, none)
      expect(r.status, sql).toBe(200)
      expect((r.body as Rows).rows.flat().some((v) => v !== null), sql).toBe(true)
    }
  })
})

describe.skipIf(!RUNTIME)('analytics query', () => {
  it('runs SELECT and WITH with positional and named params', async () => {
    const { control, logs } = setup()
    const r = await control.query({ session: 'sess-work', sql: 'SELECT cwd, COUNT(*) AS n, TOTAL(usd) AS usd FROM turns WHERE at >= ? GROUP BY cwd ORDER BY cwd', params: [0] }, none)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, columns: ['cwd', 'n', 'usd'], rowCount: 2, truncated: false, timedOut: false })
    const rows = (r.body as Rows).rows
    expect(rows[0]).toEqual(['/w/acme/api/src', 30, expect.closeTo(3, 5)])
    expect(rows[1]).toEqual(['/w/acme/web', 1, 0.5])
    expect(logs.at(-1)).toMatch(/analytics query \(session sess-work\): 2 rows/)
    const named = await control.query({ sql: "WITH t AS (SELECT session_id FROM session_links WHERE kind = 'ticket' AND ref = :key) SELECT s.id, s.agent FROM sessions s JOIN t ON t.session_id = s.id", params: { key: 'ABC-123' } }, none)
    expect(named.body).toMatchObject({ columns: ['id', 'agent'], rows: [['s1', 'claude']] })
  })

  it('never logs bound values', async () => {
    const { control, logs } = setup()
    await control.query({ sql: 'SELECT ? AS v', params: ['secret-value-xyz'] }, none)
    await control.query({ sql: 'SELECT nope FROM sessions WHERE id = ?', params: ['secret-value-xyz'] }, none)
    expect(logs.length).toBeGreaterThanOrEqual(2)
    expect(logs.join('\n')).not.toContain('secret-value-xyz')
  })

  it('keeps duplicate column names apart and accepts one trailing semicolon', async () => {
    const { control } = setup()
    const r = await control.query({ sql: "SELECT s.id, t.id FROM sessions s JOIN turns t ON t.session_id = s.id WHERE s.id = 's2';" }, none)
    expect(r.status).toBe(200)
    expect((r.body as Rows).rows[0]).toHaveLength(2)
  })

  it('accepts semicolons and keywords inside strings, quoted names, comments, functions and quoted aliases', async () => {
    const { control } = setup()
    const r = await control.query({ sql: "SELECT 'a;b' AS \"x;y\", 'DELETE FROM sessions' AS t -- trailing; comment\n FROM sessions LIMIT 1" }, none)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ columns: ['x;y', 't'], rows: [['a;b', 'DELETE FROM sessions']] })
    expect((await control.query({ sql: "SELECT j.value FROM json_each('[1,2]') j" }, none)).body).toMatchObject({ rows: [[1], [2]] })
    expect((await control.query({ sql: "SELECT replace(cwd, '/w/', '') AS p, CASE WHEN usd > 0.2 THEN 'big' ELSE 'small' END AS size FROM turns LIMIT 1" }, none)).status).toBe(200)
    expect((await control.query({ sql: 'SELECT 1 AS "commit", 2 AS edit, 0x1F AS h, 1.5e3 AS e, ?1 AS p', params: [7] }, none)).body).toMatchObject({ rows: [[1, 2, 31, 1500, 7]] })
    expect((await control.query({ sql: 'SELECT name, sql FROM sqlite_master WHERE name = ?', params: ['turns'] }, none)).status).toBe(200)
  })

  it.each([
    ['two statements', 'SELECT 1; SELECT 2', /one statement/],
    ['a write after a select', 'SELECT 1; DELETE FROM sessions', /one statement/],
    ['a write hidden after a block comment', '/* SELECT */ DELETE FROM sessions', /only SELECT or WITH/],
    ['a write after a line comment', '-- SELECT\nDELETE FROM sessions', /only SELECT or WITH/],
    ['a write in a CTE', 'WITH x AS (SELECT 1) DELETE FROM sessions', /DELETE/],
    ['REPLACE INTO in a CTE', 'WITH x AS (SELECT 1) REPLACE INTO sessions SELECT * FROM sessions', /REPLACE/],
    ['an update', "UPDATE sessions SET title = 'x'", /only SELECT or WITH/],
    ['PRAGMA', 'PRAGMA query_only = 0', /only SELECT or WITH/],
    ['a PRAGMA function', "SELECT * FROM pragma_table_info('sessions')", /PRAGMA/],
    ['ATTACH', "ATTACH DATABASE '/tmp/x.db' AS x", /only SELECT or WITH/],
    ['kv_state', 'SELECT value FROM kv_state', /kv_state/],
    ['kv_state quoted', 'SELECT value FROM "KV_STATE"', /kv_state/],
    ['kv_state in brackets with the schema', 'SELECT value FROM main.[kv_state]', /kv_state/],
    ['kv_state as a string', "SELECT * FROM 'kv_state'", /kv_state/],
    ['kv_state as a string with the schema', "SELECT * FROM main.'KV_STATE'", /kv_state/],
    ['turn_files (local paths)', 'SELECT path FROM turn_files', /turn_files/],
    ['history_index (first prompts)', 'SELECT * FROM history_index', /history_index/],
    ['the search index content as a string in a JOIN', "SELECT * FROM turns JOIN 'history_fts_content' h ON 1", /history_fts_content/],
    ['a view over kv_state', 'SELECT * FROM kv_view', /kv_view/],
    ['schema_migrations', 'SELECT * FROM schema_migrations', /schema_migrations/],
    ['dbstat', 'SELECT * FROM dbstat', /dbstat/],
    ['the temp schema', 'SELECT * FROM temp.sqlite_master', /only the main database/],
    ['a file function', "SELECT readfile('/etc/hosts')", /readfile/],
    ['load_extension', "SELECT load_extension('x')", /load_extension/],
    ['load_extension behind a hex number', "SELECT 0x1e+load_extension('/tmp/x')", /load_extension/],
    ['fts3_tokenizer behind a hex number', "SELECT 0x1e+fts3_tokenizer('simple')", /fts3_tokenizer/],
    ['a letter glued to a number', 'SELECT 1abc', /unrecognized token/],
    ['randomblob', 'SELECT randomblob(1000000000)', /randomblob/],
    ['zeroblob', 'SELECT zeroblob(1000000000)', /zeroblob/],
    ['COMMIT as an alias', 'SELECT 1 AS commit', /quote it if it is a name/],
    ['RELEASE as an alias', 'SELECT 1 AS release', /quote it if it is a name/],
    ['an open comment', 'SELECT 1 /* never closed', /cannot be read/],
    ['an open string', "SELECT 'never closed", /cannot be read/],
    ['VACUUM INTO', "VACUUM INTO '/tmp/copy.db'", /only SELECT or WITH/],
    ['not SQL', 'hello', /only SELECT or WITH/]
  ])('refuses %s', async (_, sql, why) => {
    const { control, logs } = setup()
    const r = await control.query({ sql }, none)
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toMatch(why)
    expect(logs.at(-1)).toMatch(/refused/)
  })

  it('refuses a hidden table named as a string, in FROM or JOIN', () => {
    expect(checkReadOnlySql("SELECT * FROM 'kv_state'")).toMatch(/kv_state/)
    expect(checkReadOnlySql("SELECT * FROM turns JOIN 'history_fts_content' h ON 1", ['turns', 'history_fts_content'])).toMatch(/history_fts_content/)
    expect(checkReadOnlySql("SELECT * FROM turns JOIN 'it''s' h ON 1", ["it's"])).toMatch(/it's/)
    expect(checkReadOnlySql("SELECT * FROM turns WHERE model = 'sonnet'", ['turns', 'history_fts_content'])).toBeNull()
  })

  it('refuses SQL longer than 20 KB, bad params and bad limits', async () => {
    const { control } = setup()
    expect((await control.query({ sql: `SELECT 1 AS a${' '.repeat(21 * 1024)}` }, none)).body).toMatchObject({ error: expect.stringMatching(/20 KB/) })
    expect((await control.query({ sql: 'SELECT ?', params: [{ a: 1 }] }, none)).status).toBe(400)
    expect((await control.query({ sql: 'SELECT ?', params: 'x' }, none)).status).toBe(400)
    expect((await control.query({ sql: 'SELECT 1', limit: 0 }, none)).status).toBe(400)
    expect((await control.query({ sql: 42 }, none)).status).toBe(400)
    expect((await control.query('SELECT 1', none)).status).toBe(400)
  })

  it('reports SQLite errors as 400 and cuts them in the log', async () => {
    const { control, logs } = setup()
    const r = await control.query({ sql: 'SELECT nope FROM sessions' }, none)
    expect(r).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^SQLite: .*nope/) } })
    const long = `SELECT ${'x'.repeat(2000)} FROM sessions`
    await control.query({ sql: long }, none)
    const line = logs.at(-1)!
    expect(line).toMatch(/failed/)
    expect(line.length).toBeLessThan(700)
  })

  it('caps the rows and says so', async () => {
    const { control } = setup()
    expect((await control.query({ sql: 'SELECT id FROM turns ORDER BY id', limit: 10 }, none)).body).toMatchObject({ rowCount: 10, truncated: true, timedOut: false })
    expect((await control.query({ sql: 'SELECT id FROM turns', limit: 5000 }, none)).body).toMatchObject({ rowCount: 31, truncated: false })
    expect((await control.query({ sql: 'SELECT id FROM turns', limit: 31 }, none)).body).toMatchObject({ rowCount: 31, truncated: false })
  })

  it('kills a query past the budget, answers timedOut with no rows, and keeps answering', async () => {
    const { control, logs } = setup({}, { budgetMs: 1000 })
    const started = Date.now()
    const r = await control.query({ sql: 'WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT count(*) FROM r' }, none)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(r).toMatchObject({ status: 200, body: { timedOut: true, truncated: true, rows: [], rowCount: 0 } })
    expect(logs.join('\n')).toMatch(/killed/)
    expect((await control.query({ sql: 'SELECT COUNT(*) FROM sessions' }, none)).body).toMatchObject({ rows: [[2]], timedOut: false })
  })

  it('cannot write even when the text check is bypassed: read-only file and query_only', async () => {
    const { db, raw } = setup()
    const refused = /readonly|read-only|query_only|not authorized|prohibited/i
    await expect(raw("UPDATE sessions SET title = 'x'")).rejects.toThrow(refused)
    await expect(raw('DELETE FROM kv_state')).rejects.toThrow(refused)
    await expect(raw('CREATE TABLE x (a)')).rejects.toThrow(refused)
    // Turning query_only off (allowed without an authorizer) still leaves a file opened read-only.
    await raw('PRAGMA query_only = 0').catch(() => undefined)
    await expect(raw("INSERT INTO session_tags (session_id, tag, at) VALUES ('s1', 'x', 1)")).rejects.toThrow(refused)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM session_tags').get()).toEqual({ n: 1 })
    expect(db.raw.prepare("SELECT title FROM sessions WHERE id = 's1'").get()).toEqual({ title: 'Fix login' })
  })

  it('sees what the app writes after it opened', async () => {
    const { control, db } = setup()
    expect((await control.query({ sql: 'SELECT COUNT(*) FROM sessions' }, none)).body).toMatchObject({ rows: [[2]] })
    db.raw.prepare("INSERT INTO sessions (id, agent, source, updated_at) VALUES ('s3', 'kiro', 'transcript', 1)").run()
    expect((await control.query({ sql: 'SELECT COUNT(*) FROM sessions' }, none)).body).toMatchObject({ rows: [[3]] })
  })

  it('lets a reviewer (read-only) session read; refuses an unknown session', async () => {
    const { control } = setup()
    expect((await control.query({ session: 'sess-review', sql: 'SELECT 1' }, none)).status).toBe(200)
    expect((await control.schema(q('session=sess-review'))).status).toBe(200)
    expect((await control.report(q('session=sess-review&kind=spend_by_agent'))).status).toBe(200)
    expect((await control.query({ session: 'nope', sql: 'SELECT 1' }, none)).status).toBe(404)
    expect((await control.query({ session: '../x', sql: 'SELECT 1' }, none)).status).toBe(400)
  })
})

describe('analytics report', () => {
  type Group = { group: string | null; usd: number; turns: number; sessions: number }
  type Report = { totals: Group; groups: Group[]; rows: { bucketStart: number; bucketStartIso: string }[]; since: number; sinceIso: string; groupsOverlap: boolean }

  it('spend by project with ms and ISO times, 4-decimal dollars and sessions', async () => {
    const { control } = setup()
    const r = await control.report(q('kind=spend_by_project&profile=all'))
    expect(r.status).toBe(200)
    const body = r.body as Report
    expect(body).toMatchObject({ kind: 'spend_by_project', bucket: 'day', profile: 'all', groupsOverlap: false, totals: { turns: 31, sessions: 2, usd: 3.5 } })
    expect(new Date(body.sinceIso).getTime()).toBe(body.since)
    expect(body.groups.map((g) => [g.group, g.sessions])).toEqual([
      ['/w/acme/api', 1],
      ['/w/acme/web', 1]
    ])
    expect(new Date(body.rows[0]!.bucketStartIso).getTime()).toBe(body.rows[0]!.bucketStart)
    expect(r.body).toHaveProperty('projectMeaning')
  })

  it('counts totals once when groups overlap', async () => {
    const { control } = setup()
    const r = (await control.report(q('kind=spend_by_ticket&profile=all'))).body as Report & { note: string }
    expect(r.groupsOverlap).toBe(true)
    expect(r.note).toMatch(/more than the totals/)
    expect(r.totals.turns).toBe(31)
    expect(r.groups.reduce((a, g) => a + g.turns, 0)).toBe(61)
  })

  it('filters by tag, folder, PR, model, agent and profile; the caller profile by default', async () => {
    const { control } = setup()
    expect((await control.report(q('kind=spend_by_tag&profile=all&tag=IDEA'))).body).toMatchObject({ totals: { turns: 1 }, groups: [{ group: 'idea' }] })
    expect((await control.report(q('kind=spend_by_agent&profile=all&folder=/w/acme/api'))).body).toMatchObject({ totals: { turns: 30 } })
    expect((await control.report(q(`kind=spend_by_agent&profile=all&pr=${encodeURIComponent(PR.toUpperCase() + '/')}`))).body).toMatchObject({ totals: { turns: 30 } })
    expect((await control.report(q('kind=spend_by_agent&profile=all&model=gpt'))).body).toMatchObject({ totals: { turns: 1 } })
    expect((await control.report(q('kind=spend_by_agent&profile=all&agent=codex'))).body).toMatchObject({ groups: [{ group: 'codex' }] })
    expect((await control.report(q('kind=spend_by_agent&session=sess-work'))).body).toMatchObject({ profile: 'work', groups: [{ group: 'claude', turns: 30 }] })
    expect((await control.report(q('kind=spend_by_agent&profile=home&bucket=week'))).body).toMatchObject({ profile: 'home', bucket: 'week', groups: [{ group: 'codex' }] })
  })

  it('weekly summary of the week holding since; refuses the spend filters', async () => {
    const { control } = setup()
    const r = await control.report(q(`kind=weekly&profile=all&since=${T0}`))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ kind: 'weekly', sessions: 2, tickets: expect.arrayContaining([expect.objectContaining({ ref: 'ABC-123' })]) })
    expect(r.body).toHaveProperty('weekStartIso')
    for (const extra of ['tag=idea', 'until=2026-11-20', 'bucket=week', 'folder=/w']) {
      const bad = await control.report(q(`kind=weekly&${extra}`))
      expect(bad.status, extra).toBe(400)
      expect((bad.body as { error: string }).error).toMatch(/does not apply to weekly/)
    }
  })

  it('validates its parameters', async () => {
    const { control } = setup()
    expect((await control.report(none)).status).toBe(400)
    expect((await control.report(q('kind=spend_by_model'))).status).toBe(400)
    expect((await control.report(q('kind=spend_by_project&since=yesterday'))).status).toBe(400)
    expect((await control.report(q('kind=spend_by_project&since=2026'))).status).toBe(400)
    expect((await control.report(q('kind=spend_by_project&bucket=month'))).status).toBe(400)
    expect((await control.report(q('kind=spend_by_project&since=2026-11-10&until=2026-11-01'))).status).toBe(400)
    expect((await control.report(q('kind=spend_by_project&since=2020-01-01&until=2026-01-01'))).status).toBe(400)
    expect((await control.report(q('kind=spend_by_project&profile=nope'))).status).toBe(404)
  })

  it('reads times', () => {
    expect(timeOf('1700000000000')).toBe(1_700_000_000_000)
    expect(timeOf('2026')).toMatch(/not a time/)
    expect(timeOf('2026-11-01')).toBe(new Date(2026, 10, 1).getTime())
    expect(timeOf('2026-11-01T10:00:00Z')).toBe(Date.UTC(2026, 10, 1, 10))
    expect(timeOf('soon')).toMatch(/not a time/)
  })
})

describe.skipIf(!RUNTIME)('analytics over the endpoint', () => {
  it('serves the three routes, refuses other methods and requests without the token', async () => {
    const { control } = setup()
    const token = 'tok'
    // The reviewer's session token on top of the launch token: analytics are read-only, so a reviewer may call them.
    const started = await startLoopbackControlServer(token, { auth: { sessionOf: (t) => (t === 't-review' ? 'sess-review' : undefined), readOnly: () => true }, openReview: () => ({ ok: true }), analytics: control })
    const { server, url } = started!
    const hit = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((done, fail) => {
        const u = new URL(path, url)
        const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => done({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }))
        })
        req.on('error', fail)
        req.end(body === undefined ? undefined : JSON.stringify(body))
      })
    const auth = { authorization: `Bearer ${token}`, 'x-workhub-token': 't-review' }
    try {
      // The launch token alone reaches the endpoint, but analytics need a session token.
      expect((await hit('GET', '/v1/analytics/schema', { authorization: `Bearer ${token}` })).status).toBe(401)
      expect((await hit('GET', '/v1/analytics/schema', {})).status).toBe(401)
      expect((await hit('POST', '/v1/analytics/query', {}, { sql: 'SELECT 1' })).status).toBe(401)
      expect((await hit('GET', '/v1/analytics/schema?session=sess-review', auth)).status).toBe(200)
      expect(await hit('POST', '/v1/analytics/query', auth, { session: 'sess-review', sql: 'SELECT COUNT(*) AS n FROM turns' })).toMatchObject({ status: 200, body: { columns: ['n'], rows: [[31]] } })
      expect((await hit('POST', '/v1/analytics/query', auth, { sql: 'PRAGMA user_version' })).status).toBe(400)
      expect((await hit('GET', '/v1/analytics/report?kind=weekly', auth)).status).toBe(200)
      expect((await hit('GET', '/v1/analytics/query', auth)).status).toBe(405)
      // A reviewer's POST anywhere but the query is a change, refused before the method is checked.
      expect((await hit('POST', '/v1/analytics/schema', auth, {})).status).toBe(403)
      expect((await hit('GET', '/v1/analytics/nope', auth)).status).toBe(404)
    } finally {
      server.close()
    }
  })

  it('is absent when the app offers no analytics', async () => {
    const { server, url } = (await startLoopbackControlServer('t', { auth: { sessionOf: () => 's1', readOnly: () => false }, openReview: () => ({ ok: true }) }))!
    try {
      const status = await new Promise<number>((done) => request(new URL('/v1/analytics/schema', url), { headers: { authorization: 'Bearer t', 'x-workhub-token': 'st' } }, (res) => (res.resume(), done(res.statusCode ?? 0))).end())
      expect(status).toBe(404)
    } finally {
      server.close()
    }
  })
})

// The worker under Electron's own Node (24), where SQLite's authorizer exists: what a query that
// slipped past the text check would meet in the app.
describe('a worker without the authorizer', () => {
  it('refuses every query with "read-only guard unavailable" (503), and says so once in the log', async () => {
    const sent: unknown[] = []
    const spawn = (): QueryWorker => {
      let reply: (m: never) => void = () => undefined
      return {
        post: (m) => {
          sent.push(m)
          if (m.type === 'init') queueMicrotask(() => reply({ type: 'ready', authorizer: false } as never))
          else queueMicrotask(() => reply({ type: 'result', id: m.id, columns: ['v'], rows: [[1]], truncated: false } as never))
        },
        onMessage: (fn) => (reply = fn as never),
        onExit: () => undefined,
        kill: () => undefined
      }
    }
    const { control, logs } = setup({}, { spawn })
    for (let i = 0; i < 2; i++) {
      const r = await control.query({ sql: 'SELECT COUNT(*) FROM turns' }, none)
      expect(r.status).toBe(503)
      expect((r.body as { error: string }).error).toMatch(/^read-only guard unavailable/)
    }
    expect(logs.filter((l) => /authorizer unavailable/.test(l))).toHaveLength(1)
    expect(logs.at(-1)).toMatch(/refused.*read-only guard unavailable/)
    // The second query never reached the worker.
    expect(sent.filter((m) => (m as { type: string }).type === 'query')).toHaveLength(1)
  })

  it.skipIf(authorizerAvailable())('this Node has no authorizer: the real worker refuses too', async () => {
    const { control } = setup({}, { execPath: process.execPath })
    const r = await control.query({ sql: 'SELECT 1' }, none)
    expect(r.status).toBe(503)
  })
})

describe('tokens in the reports', () => {
  it('adds tokens = input + output + cache writes to totals, groups, rows and the weekly answer', async () => {
    const { control, db } = setup()
    db.raw.prepare('UPDATE turns SET cache_write_tokens = 7, cache_read_tokens = 1000').run()
    const r = (await control.report(q('kind=spend_by_agent&profile=all'))).body as { tokensMeaning: string; totals: { tokens: number }; groups: { group: string; tokens: number }[]; rows: { tokens: number }[] }
    expect(r.totals.tokens).toBe(30 * 117 + 62)
    expect(r.groups.find((g) => g.group === 'codex')!.tokens).toBe(62)
    expect(r.rows.reduce((a, x) => a + x.tokens, 0)).toBe(r.totals.tokens)
    expect(r.tokensMeaning).toMatch(/cache writes/)
    const week = (await control.report(q(`kind=weekly&profile=all&since=${T0}`))).body as { tokens: number; tokensMeaning: string }
    expect(week.tokens).toBe(30 * 117 + 62)
    expect(week.tokensMeaning).toMatch(/Home/)
  })
})

// Electron's binary from the `electron` package, so this runs on every OS CI uses.
describe.skipIf(!ELECTRON)('analytics worker under Electron (authorizer)', () => {
  it('denies the hidden tables, internal tables and functions; allows CTE counts', async () => {
    const { raw, logs } = setup({}, { execPath: ELECTRON! })
    const denied = /prohibited|not authorized/
    for (const sql of [
      'SELECT * FROM kv_state',
      'SELECT count(*) FROM kv_state',
      'SELECT * FROM kv_view',
      "SELECT * FROM pragma_table_info('turns')",
      'SELECT * FROM dbstat',
      'SELECT * FROM temp.sqlite_master',
      "SELECT 0x1e+load_extension('/tmp/x')",
      'SELECT randomblob(10)',
      'PRAGMA query_only = 0',
      "UPDATE sessions SET title = 'x'"
    ])
      await expect(raw(sql), sql).rejects.toThrow(denied)
    for (const sql of [
      'WITH c AS MATERIALIZED (SELECT * FROM turns) SELECT count(*) FROM c',
      "WITH c AS (SELECT 1 AS a UNION ALL SELECT 2) SELECT count(*) FROM c",
      'WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 5) SELECT count(*) FROM r',
      "SELECT count(*), json_extract(summary_json, '$.automationName') FROM automation_runs",
      'SELECT count(*) FROM sqlite_master'
    ])
      expect((await raw(sql)).rows[0]![0], sql).not.toBeNull()
    expect(logs.join('\n')).not.toMatch(/authorizer unavailable/)
  })

  it('kills a runaway query after the default 5 s and starts again', async () => {
    const { control } = setup({}, { execPath: ELECTRON! })
    const started = Date.now()
    const r = await control.query({ sql: 'WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT count(*) FROM r' }, none)
    const took = Date.now() - started
    expect(r.body).toMatchObject({ timedOut: true, rows: [] })
    expect(took).toBeGreaterThanOrEqual(4900)
    expect(took).toBeLessThan(8000)
    expect((await control.query({ sql: 'SELECT COUNT(*) FROM turns' }, none)).body).toMatchObject({ rows: [[31]] })
  }, 15_000)
})
