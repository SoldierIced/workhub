import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyConfig, type AgentEvent, type PrEventState, type PullRequest, type WorkhubConfig } from '@workhub/core'
import { SessionRecords, Timelines, WorkhubDb } from '@workhub/adapters/sqlite-store'
import { AnalyticsRecorder, linksOfSnapshot } from '../src/main/analytics-recorder'
import { registerAnalyticsIpc } from '../src/main/analytics-ipc'
import { PrEventService, prSlug } from '../src/main/pr-events-service'
import { TicketWatcher } from '../src/main/watchers'
import { seedScenarioAnalytics } from '../src/main/demo-scenario'
import { ingestsTranscripts, turnOwners, turnProjects } from '../src/main/token-spend'
import type { SessionView } from '../src/shared/api'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const memoryDb = () => WorkhubDb.open(':memory:', { log: () => {} })
const rows = (db: WorkhubDb, sql: string, ...params: (string | number)[]) => db.raw.prepare(sql).all(...params) as Record<string, unknown>[]

const view = (over: Partial<SessionView> = {}): SessionView =>
  ({ id: 'w1', agentId: 'claude-work', accountId: 'work', profileId: 'p1', cwd: '/w/acme', state: 'ready', startedAt: 1000, agentSessionId: 'agent-1', label: 'Claude', ...over }) as SessionView
const monitor = (snapshot: object, sessionId = 'w1'): AgentEvent => ({ type: 'monitor', sessionId, snapshot }) as AgentEvent

describe('session links from the monitor', () => {
  it('reads PRs, tickets and branches out of a snapshot', () => {
    expect(
      linksOfSnapshot({
        pullRequestLinks: [{ source: 'acted', url: 'https://example.com/acme/api/pull/7/' }, { source: 'user', number: 3 }],
        ticketKeys: ['abc-1'],
        replyTicketKeys: ['ABC-2'],
        linkedTicketKeys: ['ABC-3'],
        branches: [{ name: 'feat/x' }, { folder: '/w/acme' }]
      })
    ).toEqual([
      { kind: 'pr', ref: 'https://example.com/acme/api/pull/7', source: 'acted' },
      { kind: 'ticket', ref: 'ABC-1', source: 'user' },
      { kind: 'ticket', ref: 'ABC-2', source: 'reply' },
      { kind: 'ticket', ref: 'ABC-3', source: 'tracker' },
      { kind: 'branch', ref: 'feat/x', source: 'git' }
    ])
  })

  it('records a session under its agent family, its worktree as a link, and what the monitor names, once each', () => {
    const db = memoryDb()
    const records = new SessionRecords(db)
    let writes = 0
    const recorder = new AnalyticsRecorder({ records: { upsertSession: (s) => (writes++, records.upsertSession(s)), addLinks: (id, l) => records.addLinks(id, l), rekey: (a, b) => records.rekey(a, b) }, agentOf: () => 'claude' })
    const v = view({ name: 'Synthetic task', worktree: { repoRoot: '/w/acme', path: '/w/acme-wt', branch: 'feat/y' } })
    recorder.sessionChanged(v)
    recorder.sessionChanged(v)
    expect(writes).toBe(1)
    recorder.onEvent(monitor({ ticketKeys: ['ABC-1'], model: 'claude-sonnet-4-5' }))
    recorder.onEvent(monitor({ ticketKeys: ['ABC-1'], pullRequestLinks: [{ source: 'acted', url: 'https://example.com/acme/api/pull/7' }] }))
    expect(rows(db, 'SELECT id, agent, account_id, title, cwd, work_path, last_model, source FROM sessions')).toEqual([
      { id: 'agent-1', agent: 'claude', account_id: 'work', title: 'Synthetic task', cwd: '/w/acme', work_path: null, last_model: 'claude-sonnet-4-5', source: 'workhub' }
    ])
    expect(rows(db, 'SELECT kind, ref FROM session_links ORDER BY kind, ref').map((r) => `${r['kind']}:${r['ref']}`)).toEqual(['branch:feat/y', 'pr:https://example.com/acme/api/pull/7', 'ticket:ABC-1', 'worktree:/w/acme-wt'])
    db.close()
  })

  it('keeps the first stop time across a rename, clears it on resume', () => {
    const db = memoryDb()
    const records = new SessionRecords(db)
    let now = 5000
    const recorder = new AnalyticsRecorder({ records, now: () => now })
    recorder.sessionChanged(view())
    recorder.sessionChanged(view({ state: 'stopped' }))
    now = 9000
    recorder.sessionChanged(view({ state: 'stopped', name: 'Renamed' }))
    expect(rows(db, 'SELECT title, ended_at FROM sessions')).toEqual([{ title: 'Renamed', ended_at: 5000 }])
    recorder.sessionChanged(view({ state: 'ready', name: 'Renamed' }))
    expect(rows(db, 'SELECT ended_at FROM sessions')).toEqual([{ ended_at: null }])
    db.close()
  })

  it("moves links found before the agent's id was known to its session, and forgets a removed session", () => {
    const db = memoryDb()
    const records = new SessionRecords(db)
    const recorder = new AnalyticsRecorder({ records })
    recorder.sessionChanged(view({ state: 'starting', agentSessionId: undefined, identity: 'wh-ident' }))
    recorder.onEvent(monitor({ ticketKeys: ['ABC-9'] }))
    expect(rows(db, 'SELECT id FROM sessions')).toEqual([{ id: 'wh-ident' }])
    recorder.sessionChanged(view({ agentSessionId: 'agent-7', identity: 'wh-ident' }))
    expect(rows(db, 'SELECT id FROM sessions')).toEqual([{ id: 'agent-7' }])
    expect(rows(db, 'SELECT session_id, ref FROM session_links')).toEqual([{ session_id: 'agent-7', ref: 'ABC-9' }])
    recorder.sessionRemoved('w1')
    // Forgotten: the same link is offered to the store again (and ignored there).
    let offered = 0
    const spy = new AnalyticsRecorder({ records: { upsertSession: () => {}, addLinks: () => (offered++, 0), rekey: () => {} } })
    spy.sessionChanged(view())
    spy.onEvent(monitor({ ticketKeys: ['ABC-9'] }))
    spy.sessionRemoved('w1')
    spy.sessionChanged(view())
    spy.onEvent(monitor({ ticketKeys: ['ABC-9'] }))
    expect(offered).toBe(2)
    db.close()
  })

  it('logs a failed write instead of throwing at the session', () => {
    const logged: string[] = []
    const recorder = new AnalyticsRecorder({
      records: {
        upsertSession: () => {
          throw new Error('disk full')
        },
        addLinks: () => 0,
        rekey: () => {}
      },
      log: (m) => logged.push(m)
    })
    expect(() => recorder.sessionChanged(view())).not.toThrow()
    expect(logged[0]).toContain('disk full')
  })
})

describe('analytics IPC', () => {
  it('lists and sets tags of a known session; refuses the rest', async () => {
    const db = memoryDb()
    const records = new SessionRecords(db)
    db.raw.prepare("INSERT INTO sessions (id, agent, source, updated_at) VALUES ('s1', 'claude', 'transcript', 0)").run()
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAnalyticsIpc({ handle: (channel, fn) => void handlers.set(channel, fn as never), on: () => undefined }, { db, records })
    const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
    expect(await call('analytics:setTags', 's1', ['Idea', 'perf'])).toEqual(['idea', 'perf'])
    expect(await call('analytics:tags', 's1')).toEqual(['idea', 'perf'])
    await expect(call('analytics:setTags', 'missing', ['x'])).rejects.toThrow(/unknown session/)
    await expect(call('analytics:setTags', 's1', ['<script>'])).rejects.toThrow(/invalid tag/)
    await expect(call('analytics:setTags', 's1', 'idea')).rejects.toThrow(/list of strings/)
    await expect(call('analytics:setTags', 's1', Array.from({ length: 21 }, (_, i) => `t${i}`))).rejects.toThrow(/at most 20/)
    expect(await call('analytics:tags', 42)).toEqual([])
    db.close()
  })
})

describe('timelines', () => {
  const pr = (n: number, over: Partial<PullRequest> = {}): PullRequest =>
    ({ provider: 'github', owner: 'acme', repo: 'api', number: n, url: `https://example.com/acme/api/pull/${n}`, title: `PR ${n}`, author: 'someone', branch: 'feat', base: 'main', draft: false, state: 'open', decision: 'none', ci: 'success', mergeable: 'mergeable', headSha: 'a', ...over }) as PullRequest
  const item = (p: PullRequest) => ({ pr: p, status: 'waitingReview' as const, stale: false, ticketKeys: [] })

  it('appends detected events once, a PR first seen as opened, and one leaving the review queue as reviewed', async () => {
    const db = memoryDb()
    const timelines = new Timelines(db)
    let lists = { state: 'ready' as const, mine: [item(pr(1))], toReview: [item(pr(5, { owner: 'acme', repo: 'web', url: 'https://example.com/acme/web/pull/5' }))] }
    let memory: PrEventState = { version: 1, profiles: {} }
    let now = 9000
    const config: WorkhubConfig = { ...emptyConfig(), profiles: [{ id: 'work', name: 'Work', connections: { codeHost: 'gh' }, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false, boards: false } }] as WorkhubConfig['profiles'] }
    const service = new PrEventService({
      source: { lists: async () => lists as never, stateOf: async () => null },
      store: { load: async () => memory, save: async (s) => void (memory = s) },
      config: async () => config,
      emit: () => {},
      record: (profileId, events) => void timelines.appendPrEvents(profileId, events),
      now: () => now
    })
    await service.sync()
    now = 9500
    lists = { ...lists, mine: [item(pr(1, { ci: 'failure' }))], toReview: [] }
    await service.sync()
    await service.sync()
    expect(rows(db, 'SELECT repo, number, url, kind, at FROM pr_events ORDER BY at, kind')).toEqual([
      { repo: 'acme/api', number: 1, url: 'https://example.com/acme/api/pull/1', kind: 'opened', at: 9000 },
      { repo: 'acme/api', number: 1, url: 'https://example.com/acme/api/pull/1', kind: 'ciFailed', at: 9500 },
      { repo: 'acme/web', number: 5, url: 'https://example.com/acme/web/pull/5', kind: 'reviewed', at: 9500 }
    ])
    expect(prSlug('https://example.com/group/sub/repo/-/merge_requests/3')).toBe('group/sub/repo#3')
    db.close()
  })

  it('appends the ticket changes the watcher sees, a burst included', async () => {
    const db = memoryDb()
    const timelines = new Timelines(db)
    let current = [
      { key: 'ABC-1', title: 'One', status: 'To Do' },
      { key: 'ABC-2', title: 'Two', status: 'To Do' }
    ]
    let state = { profiles: {}, readAt: {} }
    const watcher = new TicketWatcher({
      activeProfileId: async () => 'p',
      enabled: async () => true,
      list: async () => ({ ok: true as const, value: current }),
      store: { load: () => state, save: (s) => void (state = s as typeof state) },
      announce: () => {},
      record: (profileId, changes, at) => void timelines.appendTicketChanges(profileId, changes, at),
      now: () => 5000
    })
    await watcher.tick(true)
    current = [{ key: 'ABC-1', title: 'One', status: 'Done' }]
    await watcher.tick(true)
    expect(rows(db, 'SELECT key, kind, from_value, to_value FROM ticket_events ORDER BY key')).toEqual([
      { key: 'ABC-1', kind: 'status', from_value: 'To Do', to_value: 'Done' },
      { key: 'ABC-2', kind: 'left', from_value: null, to_value: null }
    ])
    db.close()
  })
})

describe('transcript scan setup', () => {
  it('never reads transcripts in a demo', () => {
    expect(ingestsTranscripts({})).toBe(true)
    expect(ingestsTranscripts({ WORKHUB_DEMO_SCENARIO: 'team-lead' })).toBe(false)
    expect(ingestsTranscripts({ WORKHUB_DEMO_USAGE: '1' })).toBe(false)
  })

  it('names the account of a config folder, unknown when none uses it', () => {
    const config: WorkhubConfig = { ...emptyConfig(), accounts: [{ id: 'work', agentId: 'claude', name: 'Work', configDir: '/h/.claude-work' }] as WorkhubConfig['accounts'] }
    const owners = turnOwners(config, '/h', {})
    expect(owners.accountOf('claude', '/h/.claude-work')).toBe('work')
    expect(owners.accountOf('claude', '/h/.claude')).toBeNull()
    expect(owners.accountOf('claude', '/h/.claude-other')).toBe('unknown')
  })

  it('rolls folders up to the profile project holding them, a worktree to its repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wh-projects-'))
    dirs.push(root)
    const work = join(root, 'work')
    const repo = join(work, 'shop')
    mkdirSync(join(repo, '.git', 'worktrees', 'fix'), { recursive: true })
    mkdirSync(join(repo, 'api', 'src'), { recursive: true })
    writeFileSync(join(repo, '.git', 'worktrees', 'fix', 'commondir'), '../..\n')
    const wt = join(root, 'elsewhere', 'shop-fix')
    mkdirSync(join(wt, 'web'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'fix')}\n`)
    const outside = join(root, 'other', 'tool')
    mkdirSync(join(outside, '.git'), { recursive: true })
    mkdirSync(join(outside, 'lib'))
    const config: WorkhubConfig = { ...emptyConfig(), profiles: [{ id: 'p1', name: 'Work', connections: {}, accountIds: [], folders: [work], modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false, boards: false } }] as unknown as WorkhubConfig['profiles'] }
    const resolve = await turnProjects(config, root)
    expect(await resolve([join(repo, 'api', 'src'), join(wt, 'web'), join(outside, 'lib'), join(root, 'loose')])).toEqual({
      [join(repo, 'api', 'src')]: repo,
      [join(wt, 'web')]: repo,
      [join(outside, 'lib')]: outside,
      [join(root, 'loose')]: join(root, 'loose')
    })
  })
})

describe('demo usage history', () => {
  it('seeds weeks of synthetic sessions, turns, links and runs once', () => {
    const db = memoryDb()
    const now = Date.UTC(2026, 10, 13, 12)
    expect(seedScenarioAnalytics(db, '/demo', now)).toBe(true)
    const count = (t: string) => Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)
    expect(count('sessions')).toBeGreaterThan(15)
    expect(count('turns')).toBeGreaterThan(count('sessions') * 4)
    expect(count('session_links')).toBeGreaterThan(count('sessions'))
    expect(count('automation_runs')).toBeGreaterThanOrEqual(15)
    expect(rows(db, 'SELECT SUM(active_ms) AS a FROM sessions')[0]!['a']).toBe(rows(db, 'SELECT SUM(turn_ms) AS a FROM turns')[0]!['a'])
    // Projects live under the demo folder, in the platform's path form.
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM turns WHERE project NOT LIKE ?').get(`${join('/demo')}${sep}%`) as { n: number }).n).toBe(0)
    expect(seedScenarioAnalytics(db, '/demo', now)).toBe(false)
    db.close()
  })
})
