import { describe, expect, it } from 'vitest'
import { emptyConfig, NO_CAPABILITIES, type GroupMember } from '@workhub/core'
import type { SessionView } from '../src/shared/api'
import { getSessions, onChanged, onEvent } from '../src/renderer/store'
import type { ConfigSnapshot } from '../src/shared/api'
import { RecentCall } from '../src/main/recent-call'
import { LongTaskBatch, perMinute } from '../src/renderer/lib/perfReport'
import { formatterCache } from '../src/renderer/i18n/I18nProvider'
import { ticketsConfigKey } from '../src/renderer/ticketsStore'
import { sameRow } from '../src/renderer/components/organisms/SessionList'

describe('RecentCall', () => {
  it('shares a running call and reuses a result only as old as the caller accepts', async () => {
    let clock = 0
    let calls = 0
    let release: (v: number) => void = () => {}
    const recent = new RecentCall(
      () =>
        new Promise<number>((r) => {
          calls++
          release = r
        }),
      () => clock
    )
    const a = recent.get()
    const b = recent.get(10_000)
    release(1)
    expect(await a).toBe(1)
    expect(await b).toBe(1)
    expect(calls).toBe(1)
    clock = 5_000
    expect(await recent.get(10_000)).toBe(1)
    expect(calls).toBe(1)
    // A caller that wants it fresh starts a new call.
    const c = recent.get()
    release(2)
    expect(await c).toBe(2)
    expect(calls).toBe(2)
  })

  it('never keeps a failure', async () => {
    let fail = true
    const recent = new RecentCall(async () => {
      if (fail) throw new Error('lister failed')
      return 'ok'
    })
    await expect(recent.get(10_000)).rejects.toThrow('lister failed')
    fail = false
    expect(await recent.get(10_000)).toBe('ok')
  })
})

describe('LongTaskBatch', () => {
  it('sums long tasks over the flush period and ignores short ones', () => {
    const batch = new LongTaskBatch(200, 5_000)
    expect(batch.add(150, 0)).toBeNull()
    expect(batch.add(250, 100)).toBeNull()
    expect(batch.add(400, 2_000)).toBeNull()
    expect(batch.add(300, 5_100)).toEqual({ kind: 'longtask', count: 3, maxMs: 400, totalMs: 950 })
    expect(batch.take()).toBeNull()
    expect(batch.add(220, 6_000)).toBeNull()
    expect(batch.take()).toEqual({ kind: 'longtask', count: 1, maxMs: 220, totalMs: 220 })
  })

  it('lets a limited number of events through per minute', () => {
    let clock = 0
    const allow = perMinute(2, () => clock)
    expect([allow(), allow(), allow()]).toEqual([true, true, false])
    clock = 60_000
    expect(allow()).toBe(true)
  })
})

describe('formatterCache', () => {
  it('builds one formatter per options and reuses it', () => {
    let built = 0
    const get = formatterCache((o) => ({ o, n: ++built }))
    const a = get({ day: 'numeric' })
    expect(get({ day: 'numeric' })).toBe(a)
    expect(get({ month: 'long' })).not.toBe(a)
    expect(get(undefined)).toBe(get(undefined))
    expect(built).toBe(3)
  })
})

describe('ticketsConfigKey', () => {
  const snap = (patch: Partial<ConfigSnapshot['config']>): ConfigSnapshot =>
    ({
      config: { ...emptyConfig(), profiles: [{ id: 'p1', name: 'Work', connections: {}, accountIds: [], modules: {} }], ...patch },
      connectionsWithSecret: [],
      issues: [],
      agents: [],
      providers: [],
      dataDir: '/tmp'
    }) as unknown as ConfigSnapshot

  it('does not change when only sidebar groups or options change', () => {
    const base = snap({})
    const folded = snap({ sessionGroups: { groups: [{ id: 'g', name: 'G', collapsed: true, members: [] }], top: [] } })
    expect(ticketsConfigKey(folded, 'p1')).toBe(ticketsConfigKey(base, 'p1'))
  })

  it('changes with the profile or its connections', () => {
    const base = ticketsConfigKey(snap({}), 'p1')
    expect(ticketsConfigKey(snap({ connections: [{ id: 'jira', kind: 'tracker', provider: 'jira', name: 'Jira', settings: {} }] as never }), 'p1')).not.toBe(base)
    expect(ticketsConfigKey(snap({ profiles: [{ id: 'p1', name: 'Renamed', connections: {}, accountIds: [], modules: {} }] as never }), 'p1')).not.toBe(base)
    expect(ticketsConfigKey(null, 'p1')).toBe('')
  })
})

describe('sameRow', () => {
  const member: GroupMember = { key: 'k1', title: 'Fix the build', agentKey: 'claude', cwd: '/repo' }
  const actions = {} as never
  const data = { view: { id: 's1' } } as never
  const row = (patch: object = {}) =>
    ({ member, entry: { key: 'k1', data }, title: 'Fix the build', subagents: [], subagentsOpen: false, nested: false, selected: false, dropping: false, slack: true, actions, ...patch }) as Parameters<typeof sameRow>[0]

  it('treats rows rebuilt with equal values as the same', () => {
    expect(sameRow(row({ account: { name: 'Work', color: '#fff' } }), row({ member: { ...member }, entry: { key: 'k1', data }, account: { name: 'Work', color: '#fff' }, subagents: [] }))).toBe(true)
  })

  it('renders again when the session data, the name or the state shown change', () => {
    expect(sameRow(row(), row({ entry: { key: 'k1', data: { view: { id: 's1' } } } }))).toBe(false)
    expect(sameRow(row(), row({ title: 'Renamed' }))).toBe(false)
    expect(sameRow(row(), row({ selected: true }))).toBe(false)
    expect(sameRow(row(), row({ member: { ...member, cwd: '/other' } }))).toBe(false)
    expect(sameRow(row(), row({ profile: { name: 'Work', color: '#000' } }))).toBe(false)
  })
})

describe('streamed events', () => {
  it('keeps the state current at once while their rendering is batched', () => {
    const view = { id: 'stream-1', identity: 'stream-1', agentId: 'claude', accountId: null, profileId: null, cwd: '/tmp', state: 'busy', permissionMode: null, startedAt: 1, label: 'Claude', agentName: 'Claude', adapter: 'native', capabilities: NO_CAPABILITIES, screens: [], modes: ['app'], mode: 'app', shellRunning: false, controls: false } as SessionView
    onChanged(view)
    onEvent({ sessionId: 'stream-1', type: 'message', role: 'agent', text: 'Hel' })
    onEvent({ sessionId: 'stream-1', type: 'message', role: 'agent', text: 'lo' })
    const items = getSessions()['stream-1']!.items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'agent', text: 'Hello' })
  })
})
