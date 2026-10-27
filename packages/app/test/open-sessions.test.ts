import { describe, expect, it } from 'vitest'
import type { SessionGroups } from '@workhub/core'
import { OpenSessions, readSavedSessions, restoreOrder, savedSessionOf, type SavedOpenSession, type SavedOpenSessions } from '../src/main/open-sessions'
import type { SessionMode, SessionView, StartSessionInput } from '../src/shared/api'

const view = (id: string, over: Partial<SessionView> = {}): SessionView =>
  ({ id, agentId: 'claude', accountId: 'work', profileId: 'p', cwd: `/repo/${id}`, mode: 'app', agentSessionId: `agent-${id}`, identity: `agent-${id}`, state: 'ready', ...over }) as SessionView

const saved = (identity: string, over: Partial<SavedOpenSession> = {}): SavedOpenSession => ({
  identity,
  agentKey: 'claude:work',
  profileId: 'p',
  cwd: `/repo/${identity}`,
  mode: 'app',
  engine: 'app',
  agentSessionId: identity,
  ...over
})

function harness(stored: SavedOpenSessions, opts: { enabled?: boolean; groups?: SessionGroups; missing?: string[]; failing?: string[] } = {}) {
  let file = stored
  let flushed = 0
  const live: SessionView[] = []
  const engines = new Map<string, 'app' | 'console'>()
  const starts: StartSessionInput[] = []
  const modes: [string, SessionMode][] = []
  const open = new OpenSessions({
    store: {
      load: () => file,
      save: (v) => {
        file = v
      },
      flush: () => flushed++
    },
    list: () => live,
    engineOf: (id) => engines.get(id),
    start: async (input) => {
      starts.push(input)
      if (opts.failing?.includes(input.cwd)) throw new Error('agent gone')
      const v = view(`s${starts.length}`, { cwd: input.cwd, agentSessionId: input.resumeAgentSessionId, identity: input.resumeAgentSessionId ?? input.identity, mode: input.mode ?? 'app' })
      live.push(v)
      engines.set(v.id, input.mode === 'console' ? 'console' : 'app')
      return v
    },
    setMode: async (id, mode) => {
      modes.push([id, mode])
    },
    folderExists: async (path) => !opts.missing?.includes(path),
    enabled: async () => opts.enabled ?? true,
    groups: async () => opts.groups
  })
  return { open, live, engines, starts, modes, file: () => file, flushed: () => flushed }
}

describe('open sessions across launches', () => {
  it('stores what reopening a session needs, and skips AI reviewers', () => {
    expect(savedSessionOf(view('a', { mode: 'shell', currentModelId: 'opus' }), 'console')).toEqual({
      identity: 'agent-a',
      agentKey: 'claude:work',
      profileId: 'p',
      cwd: '/repo/a',
      mode: 'shell',
      engine: 'console',
      agentSessionId: 'agent-a',
      model: 'opus'
    })
    // A plain terminal keeps its identity, with no agent session id.
    expect(savedSessionOf(view('t', { agentId: 'shell', accountId: null, agentSessionId: undefined, identity: 'term-1' }), 'console')).toMatchObject({ identity: 'term-1', agentKey: 'shell' })
    expect(savedSessionOf(view('r', { readOnly: true }), 'app')).toBeNull()
  })

  it('reads the stored file defensively', () => {
    expect(readSavedSessions({ sessions: [saved('a'), { identity: 'b' }, saved('a'), 'junk', { ...saved('c'), mode: 'weird', engine: 'x' }] })).toEqual([saved('a'), { ...saved('c'), mode: 'app', engine: 'app' }])
    expect(readSavedSessions(null)).toEqual([])
  })

  it('reopens in sidebar order: top level, then each group in place, the rest after', () => {
    const groups: SessionGroups = {
      groups: [{ id: 'g', name: 'G', collapsed: false, members: [{ key: 'c', title: 'c', agentKey: 'claude', cwd: '/c' }, { key: 'a', title: 'a', agentKey: 'claude', cwd: '/a' }] }],
      top: [{ kind: 'session', key: 'd' }, { kind: 'group', id: 'g' }]
    }
    expect(restoreOrder([saved('a'), saved('b'), saved('c'), saved('d')], groups).map((s) => s.identity)).toEqual(['d', 'c', 'a', 'b'])
    expect(restoreOrder([saved('a'), saved('b')], undefined).map((s) => s.identity)).toEqual(['a', 'b'])
  })

  it('reopens the stored sessions once, resuming them with their mode, and never saves before that', async () => {
    const h = harness({
      sessions: [saved('a'), saved('b', { mode: 'console', engine: 'console' }), saved('c', { mode: 'shell', engine: 'app' }), saved('gone'), saved('broken'), saved('term', { agentKey: 'shell', agentSessionId: undefined })]
    }, { missing: ['/repo/gone'], failing: ['/repo/broken'] })
    // Changes before the restore must not replace the stored list.
    h.open.changed()
    expect(h.file().sessions).toHaveLength(6)
    await Promise.all([h.open.restore(), h.open.restore()])
    expect(h.starts).toEqual([
      { profileId: 'p', agentKey: 'claude:work', cwd: '/repo/a', mode: 'app', resumeAgentSessionId: 'a' },
      { profileId: 'p', agentKey: 'claude:work', cwd: '/repo/b', mode: 'console', resumeAgentSessionId: 'b' },
      { profileId: 'p', agentKey: 'claude:work', cwd: '/repo/c', mode: 'app', resumeAgentSessionId: 'c' },
      { profileId: 'p', agentKey: 'claude:work', cwd: '/repo/broken', mode: 'app', resumeAgentSessionId: 'broken' },
      { profileId: 'p', agentKey: 'shell', cwd: '/repo/term', mode: 'app', identity: 'term' }
    ])
    expect(h.modes).toEqual([['s3', 'shell']])
    // Saved again from what is open now: the missing folder and the failed start are gone.
    expect(h.file().sessions.map((s) => s.identity)).toEqual(['a', 'b', 'c', 'term'])
  })

  it('reopens nothing when the setting is off, and then follows the open sessions', async () => {
    const h = harness({ sessions: [saved('a')] }, { enabled: false })
    await h.open.restore()
    expect(h.starts).toEqual([])
    h.live.push(view('x'))
    h.open.changed()
    expect(h.file().sessions.map((s) => s.identity)).toEqual(['agent-x'])
  })

  it('keeps the list of the moment the app quits while the sessions stop', async () => {
    const h = harness({ sessions: [] })
    await h.open.restore()
    h.live.push(view('x'))
    h.open.freeze()
    expect(h.flushed()).toBe(1)
    h.live.splice(0)
    h.open.changed()
    expect(h.file().sessions.map((s) => s.identity)).toEqual(['agent-x'])
  })
})
