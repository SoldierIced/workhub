import { describe, expect, it } from 'vitest'
import { emptyConfig, RETYPE_SECRET_TO_TEST, type Connection, type Profile, type SecretStore, type WorkhubConfig } from '@workhub/core'
import type { HttpClient } from '@workhub/adapters/http'
import type { GitRunner } from '@workhub/adapters/git-review'
import { buildTracker, githubReposOfFolders, TicketService } from '../src/main/tickets-service'

const jira: Connection = { id: 'work-jira', kind: 'tracker', provider: 'jira', endpoint: 'https://acme.example.com', secretRef: 'connection/work-jira', settings: { email: 'dana@example.com', projectKeys: 'ABC, WEB', ignoredStatuses: 'Blocked' } }
const linear: Connection = { id: 'lin', kind: 'tracker', provider: 'linear', secretRef: 'connection/lin', settings: {} }
const profile = (tracker?: string): Profile => ({ id: 'work', name: 'Work', connections: tracker ? { tracker } : {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false, boards: false } })

function service(opts: { connections?: Connection[]; tracker?: string; secrets?: Record<string, string>; demo?: boolean; http?: HttpClient }) {
  const config: WorkhubConfig = { ...emptyConfig(), connections: opts.connections ?? [], profiles: [profile(opts.tracker)], activeProfileId: 'work' }
  const secrets: SecretStore = {
    get: async (ref) => opts.secrets?.[ref] ?? null,
    set: async () => {},
    delete: async () => {},
    has: async (ref) => ref in (opts.secrets ?? {})
  }
  return new TicketService({ current: async () => config } as never, secrets, opts.demo ?? false, opts.http)
}

describe('githubReposOfFolders', () => {
  it("reads each folder's origin with the git it is given, skipping folders without a GitHub one", async () => {
    const origins: Record<string, string> = { '/w/acme/api': 'git@github.com:acme/api.git\n', '/w/acme/lab': 'https://gitlab.com/acme/lab.git' }
    const git: GitRunner = async (cwd) => (origins[cwd] ? { ok: true, stdout: origins[cwd]!, stderr: '' } : { ok: false, stdout: '', stderr: 'not a git repository' })
    expect(await githubReposOfFolders(['/w/acme/api', '/w/acme/lab', '/w/notes'], 'github.com', git)).toEqual(['acme/api'])
  })
})

describe('buildTracker', () => {
  it('needs the site, email and token for Jira', () => {
    expect(buildTracker({ ...jira, endpoint: undefined }, 't')).toEqual({ missing: 'incomplete', detail: 'site' })
    expect(buildTracker({ ...jira, settings: {} }, 't')).toEqual({ missing: 'incomplete', detail: 'email' })
    expect(buildTracker(jira, null)).toEqual({ missing: 'incomplete', detail: 'token' })
    expect('tracker' in buildTracker(jira, 't')).toBe(true)
  })
  it('needs only a key for Linear, and no token at all for GitHub Issues', () => {
    expect(buildTracker(linear, null)).toEqual({ missing: 'incomplete', detail: 'token' })
    expect('tracker' in buildTracker(linear, 'k')).toBe(true)
    expect('tracker' in buildTracker({ ...linear, provider: 'github-issues', secretRef: undefined }, null, undefined, { run: async () => ({ code: 0, stdout: '', stderr: '' }) })).toBe(true)
  })
})

describe('TicketService', () => {
  it('reports the state of the profile tracker', async () => {
    expect((await service({}).status('work')).state).toBe('noConnection')
    expect((await service({ connections: [jira], tracker: 'work-jira' }).status('work')).state).toBe('incomplete')
    const ready = await service({ connections: [jira], tracker: 'work-jira', secrets: { 'connection/work-jira': 'tok' } }).status('work')
    expect(ready).toEqual({ state: 'ready', provider: 'jira', connectionName: 'work-jira', projectKeys: ['ABC', 'WEB'], backlog: 'ready' })
  })

  it('offers the backlog once the connection has a query or project keys, and only where the tracker has one', async () => {
    const secrets = { 'connection/work-jira': 'tok', 'connection/lin': 'k' }
    const bare = { ...jira, settings: { email: 'dana@example.com' } }
    expect((await service({ connections: [bare], tracker: 'work-jira', secrets }).status('work')).backlog).toBe('unconfigured')
    expect((await service({ connections: [{ ...bare, settings: { ...bare.settings, backlogQuery: 'project = PAY' } }], tracker: 'work-jira', secrets }).status('work')).backlog).toBe('ready')
    expect((await service({ connections: [linear], tracker: 'lin', secrets }).status('work')).backlog).toBeUndefined()
    expect(await service({ connections: [linear], tracker: 'lin', secrets }).backlog('work')).toEqual({ ok: false, error: 'This ticket tracker has no backlog view' })
  })

  it('reads the backlog with the connection query, project keys and ignored statuses', async () => {
    const seen: string[] = []
    const http: HttpClient = async (req) => {
      if (req.url.includes('/search/jql')) seen.push(new URL(req.url).searchParams.get('jql') ?? '')
      return { status: 200, text: req.url.includes('/field') ? '[]' : JSON.stringify({ issues: [] }) }
    }
    const conn = { ...jira, settings: { ...jira.settings, backlogQuery: 'project = PAY' } }
    expect(await service({ connections: [conn], tracker: 'work-jira', secrets: { 'connection/work-jira': 'tok' }, http }).backlog('work')).toEqual({ ok: true, value: [] })
    expect(seen).toEqual(['(project = PAY) AND status NOT IN ("Blocked") ORDER BY Rank ASC'])
  })

  it('serves the demo backlog: my tickets and the team\'s, some unassigned', async () => {
    const s = service({ demo: true })
    expect((await s.status('work')).backlog).toBe('ready')
    const mine = await s.call('work', (t) => t.listAssigned())
    const team = await s.backlog('work')
    if (!mine.ok || !team.ok) throw new Error('demo failed')
    expect(team.value.length).toBeGreaterThan(mine.value.length)
    expect(mine.value.every((t) => t.assignee === 'Demo User')).toBe(true)
    expect(team.value.some((t) => !t.assignee)).toBe(true)
    expect(team.value.some((t) => t.assignee && t.assignee !== 'Demo User')).toBe(true)
  })

  it('serves the demo tracker, keeping its changes, with no connection at all', async () => {
    const s = service({ demo: true })
    expect((await s.status('work')).state).toBe('demo')
    const before = await s.call('work', (t) => t.listAssigned())
    expect(before.ok && before.value.length).toBeGreaterThan(0)
    await s.call('work', (t) => t.transition('DEMO-104', 'done'))
    const after = await s.call('work', (t) => t.listAssigned())
    expect(after.ok && after.value.some((t) => t.key === 'DEMO-104')).toBe(false)
  })

  it('lists through the connection, passing the ignored statuses and the stored token', async () => {
    const seen: { url: string; auth?: string }[] = []
    const http: HttpClient = async (req) => {
      seen.push({ url: req.url, auth: req.headers['Authorization'] })
      return { status: 200, text: req.url.includes('/field') ? '[]' : JSON.stringify({ issues: [] }) }
    }
    const s = service({ connections: [jira], tracker: 'work-jira', secrets: { 'connection/work-jira': 'tok' }, http })
    expect(await s.call('work', (t, ignored) => t.listAssigned({ ignoredStatuses: ignored }))).toEqual({ ok: true, value: [] })
    const search = seen.find((r) => r.url.includes('/search/jql'))!
    expect(new URL(search.url).searchParams.get('jql')).toContain('status NOT IN ("Blocked")')
    expect(search.auth).toBe(`Basic ${Buffer.from('dana@example.com:tok').toString('base64')}`)
  })

  it('turns failures into readable errors', async () => {
    const down: HttpClient = async () => ({ status: 401, text: '' })
    const s = service({ connections: [jira], tracker: 'work-jira', secrets: { 'connection/work-jira': 'tok' }, http: down })
    expect(await s.call('work', (t) => t.getTicket('ABC-1'))).toEqual({ ok: false, error: 'Jira rejected the email or API token' })
    expect(await service({}).call('work', (t) => t.listAssigned())).toEqual({ ok: false, error: 'This profile has no ticket tracker connection' })
  })

  it('tests a typed connection with the typed token, or the stored one', async () => {
    const http: HttpClient = async (req) => ({ status: req.headers['Authorization']?.includes(Buffer.from('dana@example.com:typed').toString('base64')) || req.headers['Authorization']?.includes(Buffer.from('dana@example.com:stored').toString('base64')) ? 200 : 401, text: JSON.stringify({ displayName: 'Dana Test' }) })
    const s = service({ connections: [jira], secrets: { 'connection/work-jira': 'stored' }, http })
    expect(await s.test(jira, { action: 'set', value: 'typed' })).toEqual({ ok: true, account: 'Dana Test' })
    expect(await s.test(jira, { action: 'keep' })).toEqual({ ok: true, account: 'Dana Test' })
    expect(await s.test(jira, { action: 'clear' })).toEqual({ ok: false, error: 'The token is missing' })
    expect(await s.test({ ...jira, endpoint: 'http://insecure.example.com' }, { action: 'set', value: 'x' })).toEqual({ ok: false, error: 'The Jira site must use https' })
  })

  it('never sends the stored token to an address or a secret the form picked', async () => {
    const seen: string[] = []
    const http: HttpClient = async (req) => (seen.push(`${new URL(req.url).host} ${req.headers['Authorization'] ?? ''}`), { status: 200, text: JSON.stringify({ displayName: 'Dana Test' }) })
    const other: Connection = { ...jira, id: 'other', secretRef: 'connection/other' }
    const s = service({ connections: [jira, other], secrets: { 'connection/work-jira': 'stored', 'connection/other': 'other-token' }, http })
    expect(await s.test({ ...jira, endpoint: 'https://attacker.example.net' }, { action: 'keep' })).toEqual({ ok: false, error: RETYPE_SECRET_TO_TEST })
    // A renderer-chosen secretRef is ignored: only the connection's own stored token is read.
    expect(await s.test({ ...jira, secretRef: 'connection/other' }, { action: 'keep' })).toEqual({ ok: true, account: 'Dana Test' })
    // A connection that was never saved has no stored token to keep.
    expect(await s.test({ ...jira, id: 'new', secretRef: 'connection/work-jira' }, { action: 'keep' })).toEqual({ ok: false, error: 'The token is missing' })
    expect(seen).toEqual([`acme.example.com Basic ${Buffer.from('dana@example.com:stored').toString('base64')}`])
  })
})
