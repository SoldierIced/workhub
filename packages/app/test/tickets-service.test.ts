import { describe, expect, it } from 'vitest'
import { emptyConfig, type Connection, type Profile, type SecretStore, type WorkhubConfig } from '@workhub/core'
import type { HttpClient } from '@workhub/adapters/http'
import { buildTracker, TicketService } from '../src/main/tickets-service'

const jira: Connection = { id: 'work-jira', kind: 'tracker', provider: 'jira', endpoint: 'https://acme.example.com', secretRef: 'connection/work-jira', settings: { email: 'dana@example.com', projectKeys: 'ABC, WEB', ignoredStatuses: 'Blocked' } }
const linear: Connection = { id: 'lin', kind: 'tracker', provider: 'linear', secretRef: 'connection/lin', settings: {} }
const profile = (tracker?: string): Profile => ({ id: 'work', name: 'Work', connections: tracker ? { tracker } : {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false } })

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

describe('buildTracker', () => {
  it('needs the site, email and token for Jira', () => {
    expect(buildTracker({ ...jira, endpoint: undefined }, 't')).toEqual({ missing: 'incomplete', detail: 'site' })
    expect(buildTracker({ ...jira, settings: {} }, 't')).toEqual({ missing: 'incomplete', detail: 'email' })
    expect(buildTracker(jira, null)).toEqual({ missing: 'incomplete', detail: 'token' })
    expect('tracker' in buildTracker(jira, 't')).toBe(true)
  })
  it('needs only a key for Linear and has no adapter for GitHub Issues', () => {
    expect(buildTracker(linear, null)).toEqual({ missing: 'incomplete', detail: 'token' })
    expect('tracker' in buildTracker(linear, 'k')).toBe(true)
    expect(buildTracker({ ...linear, provider: 'github-issues' }, 'k')).toEqual({ missing: 'unsupported' })
  })
})

describe('TicketService', () => {
  it('reports the state of the profile tracker', async () => {
    expect((await service({}).status('work')).state).toBe('noConnection')
    expect((await service({ connections: [jira], tracker: 'work-jira' }).status('work')).state).toBe('incomplete')
    const ready = await service({ connections: [jira], tracker: 'work-jira', secrets: { 'connection/work-jira': 'tok' } }).status('work')
    expect(ready).toEqual({ state: 'ready', provider: 'jira', connectionName: 'work-jira', projectKeys: ['ABC', 'WEB'] })
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
    const s = service({ secrets: { 'connection/work-jira': 'stored' }, http })
    expect(await s.test(jira, { action: 'set', value: 'typed' })).toEqual({ ok: true, account: 'Dana Test' })
    expect(await s.test(jira, { action: 'keep' })).toEqual({ ok: true, account: 'Dana Test' })
    expect(await s.test(jira, { action: 'clear' })).toEqual({ ok: false, error: 'The token is missing' })
    expect(await s.test({ ...jira, endpoint: 'http://insecure.example.com' }, { action: 'set', value: 'x' })).toEqual({ ok: false, error: 'The Jira site must use https' })
  })
})
