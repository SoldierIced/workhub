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

function harness(stored: SavedOpenSessions, opts: { enabled?: boolean; atLaunch?: boolean; groups?: SessionGroups; missing?: string[]; failing?: string[]; broken?: { config: boolean }; hostOf?: (v: SessionView) => string } = {}) {
  let file = stored
  const checked: [string, string | undefined][] = []
  let flushed = 0
  const live: SessionView[] = []
  const engines = new Map<string, 'app' | 'console'>()
  const starts: StartSessionInput[] = []
  const extras: { dormant?: boolean; title?: string; firstPrompt?: string }[] = []
  const modes: [string, SessionMode][] = []
  const prompts = new Map<string, string>()
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
    start: async (input, extra) => {
      starts.push(input)
      extras.push({ ...(extra.dormant ? { dormant: true } : {}), ...(extra.title ? { title: extra.title } : {}), ...(extra.firstPrompt ? { firstPrompt: extra.firstPrompt } : {}) })
      if (opts.failing?.includes(input.cwd)) throw new Error('agent gone')
      const v = view(`s${starts.length}`, { cwd: input.cwd, agentSessionId: input.resumeAgentSessionId, identity: input.resumeAgentSessionId ?? input.identity, mode: input.mode ?? 'app', ...(extra.dormant ? { state: 'stopped' as const } : {}) })
      live.push(v)
      engines.set(v.id, input.mode === 'console' ? 'console' : 'app')
      return v
    },
    setMode: async (id, mode) => {
      modes.push([id, mode])
    },
    folderExists: async (path, hostId) => {
      checked.push([path, hostId])
      return !opts.missing?.includes(path)
    },
    ...(opts.hostOf ? { hostOf: opts.hostOf } : {}),
    enabled: async () => {
      if (opts.broken?.config) throw new Error('Invalid config')
      return opts.enabled ?? true
    },
    startAtLaunch: async () => opts.atLaunch ?? true,
    groups: async () => opts.groups,
    firstPrompt: (id) => prompts.get(id)
  })
  return { open, prompts, live, engines, starts, extras, modes, checked, file: () => file, flushed: () => flushed }
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
    // The shortened first prompt is stored next to the title, and read back.
    expect(savedSessionOf(view('p'), 'app', 'Refactor billing')?.firstPrompt).toBe('Refactor billing')
    expect(savedSessionOf(view('p'), 'app')).not.toHaveProperty('firstPrompt')
    expect(readSavedSessions({ sessions: [saved('p', { firstPrompt: 'Refactor billing' })] })[0]?.firstPrompt).toBe('Refactor billing')
    expect(savedSessionOf(view('n', { agentTitle: 'Fix the login bug' }), 'app')?.title).toBe('Fix the login bug')
    // A plain terminal keeps its identity, with no agent session id.
    expect(savedSessionOf(view('t', { agentId: 'shell', accountId: null, agentSessionId: undefined, identity: 'term-1' }), 'console')).toMatchObject({ identity: 'term-1', agentKey: 'shell' })
    expect(savedSessionOf(view('r', { readOnly: true }), 'app')).toBeNull()
  })

  it('reads the stored file defensively', () => {
    expect(readSavedSessions({ sessions: [saved('a'), { identity: 'b' }, saved('a'), 'junk', { ...saved('c'), mode: 'weird', engine: 'x' }] })).toEqual([saved('a'), { ...saved('c'), mode: 'app', engine: 'app' }])
    expect(readSavedSessions(null)).toEqual([])
  })

  it('keeps the worktree a session runs in, and drops a malformed one', () => {
    const worktree = { repoRoot: '/repo', path: '/_worktrees/repo-x', branch: 'x' }
    expect(savedSessionOf(view('w', { worktree }), 'app')?.worktree).toEqual(worktree)
    expect(readSavedSessions({ sessions: [saved('w', { worktree }), { ...saved('v'), worktree: { path: '/x' } }] })).toEqual([saved('w', { worktree }), saved('v')])
  })

  it('keeps the host a session ran on, never this computer, and reads older records without one', () => {
    expect(savedSessionOf(view('h'), 'app', undefined, 'wsl:Ubuntu')?.hostId).toBe('wsl:Ubuntu')
    expect(savedSessionOf(view('l'), 'app', undefined, 'local')).not.toHaveProperty('hostId')
    expect(savedSessionOf(view('n'), 'app')).not.toHaveProperty('hostId')
    expect(readSavedSessions({ sessions: [saved('h', { hostId: 'wsl:Ubuntu' }), { ...saved('l'), hostId: 'local' }, { ...saved('x'), hostId: 7 }, saved('old')] })).toEqual([
      saved('h', { hostId: 'wsl:Ubuntu' }),
      saved('l'),
      saved('x'),
      saved('old')
    ])
  })

  it('checks a stored folder on the host its session ran on, and stores the host of each open session', async () => {
    const h = harness({ sessions: [saved('w', { cwd: '/w/acme/api', hostId: 'wsl:Ubuntu' }), saved('l')] }, { hostOf: (v) => (v.cwd.startsWith('/w/') ? 'wsl:Ubuntu' : 'local') })
    await h.open.restore()
    expect(h.checked).toEqual([
      ['/w/acme/api', 'wsl:Ubuntu'],
      ['/repo/l', undefined]
    ])
    expect(h.file().sessions.map((s) => [s.identity, s.hostId])).toEqual([
      ['w', 'wsl:Ubuntu'],
      ['l', undefined]
    ])
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

  it('saves a session\'s first prompt and hands it back when the session is restored', async () => {
    const h = harness({ sessions: [saved('a', { firstPrompt: 'Refactor billing' })] })
    await h.open.restore()
    expect(h.extras).toEqual([{ firstPrompt: 'Refactor billing' }])
    h.prompts.set('s1', 'Refactor billing')
    h.open.changed()
    expect(h.file().sessions[0]?.firstPrompt).toBe('Refactor billing')
  })

  it('brings the sessions back stopped by default, with their titles, and saves them while stopped', async () => {
    const h = harness({ sessions: [saved('a', { title: 'Fix the login bug' }), saved('c', { mode: 'shell' })] }, { atLaunch: false })
    await h.open.restore()
    expect(h.starts.map((s) => s.resumeAgentSessionId)).toEqual(['a', 'c'])
    expect(h.extras).toEqual([{ dormant: true, title: 'Fix the login bug' }, { dormant: true }])
    // Nothing runs, so the shell mode waits for the user to open the session.
    expect(h.modes).toEqual([])
    expect(h.live.every((v) => v.state === 'stopped')).toBe(true)
    expect(h.file().sessions.map((s) => s.identity)).toEqual(['a', 'c'])
    // Opening one starts a live copy: the session is saved once, from the live copy.
    h.live.push(view('s9', { identity: 'a', agentSessionId: 'a', mode: 'console' }))
    h.open.changed()
    expect(h.file().sessions.filter((s) => s.identity === 'a')).toMatchObject([{ mode: 'console' }])
  })

  it('reopens nothing when the setting is off, and then follows the open sessions', async () => {
    const h = harness({ sessions: [saved('a')] }, { enabled: false })
    await h.open.restore()
    expect(h.starts).toEqual([])
    h.live.push(view('x'))
    h.open.changed()
    expect(h.file().sessions.map((s) => s.identity)).toEqual(['agent-x'])
  })

  it('keeps the stored list when the restore fails, and restores on a later try', async () => {
    const broken = { config: true }
    const h = harness({ sessions: [saved('a'), saved('b')] }, { broken })
    await expect(h.open.restore()).rejects.toThrow('Invalid config')
    // Sessions opened meanwhile, and the quit, must not replace the list that was never restored.
    h.live.push(view('x'))
    h.open.changed()
    expect(h.file().sessions.map((s) => s.identity)).toEqual(['a', 'b'])
    broken.config = false
    await h.open.restore()
    expect(h.starts.map((s) => s.resumeAgentSessionId)).toEqual(['a', 'b'])
    expect(h.file().sessions.map((s) => s.identity)).toEqual(['agent-x', 'a', 'b'])
  })

  it('never saves when the restore failed and the app quits', async () => {
    const h = harness({ sessions: [saved('a')] }, { broken: { config: true } })
    await h.open.restore().catch(() => undefined)
    h.open.freeze()
    expect(h.file().sessions.map((s) => s.identity)).toEqual(['a'])
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
