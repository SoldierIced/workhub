import { describe, expect, it } from 'vitest'
import {
  aggregateAttention,
  attentionFromTransition,
  CONFIG_VERSION,
  createGroup,
  deleteGroup,
  emptyConfig,
  EMPTY_SESSION_GROUPS,
  groupOf,
  migrateConfig,
  MIGRATIONS,
  moveBy,
  moveGroupBy,
  moveGroupOnto,
  moveOnto,
  moveToGroup,
  notificationTitle,
  parseConfig,
  raiseAttention,
  reconcileTop,
  refreshMembers,
  removeMember,
  renameGroup,
  replaceStoredSessionIdentity,
  replaceSessionIdentity,
  sessionIdentity,
  setGroupCollapsed,
  sidebarRows,
  statusLevel,
  ungroup,
  type GroupMember,
  type SessionGroups
} from '../src'

const m = (key: string, title = key): GroupMember => ({ key, title, agentKey: 'claude', cwd: '/tmp/demo' })

/** Two groups, `a` holding s1 and s2 and `b` empty, with s3 loose, in that top-level order. */
function layout(): SessionGroups {
  let s = createGroup(EMPTY_SESSION_GROUPS, 'a', 'Alpha', m('s1'))
  s = moveToGroup(s, m('s2'), 'a')
  s = createGroup(s, 'b', 'Beta')
  return reconcileTop(s, ['s3'])
}

const keys = (s: SessionGroups, id: string) => s.groups.find((g) => g.id === id)?.members.map((x) => x.key)

describe('membership by stable identity', () => {
  it('keys a session by the agent session id, then the assigned identity, then the ui id', () => {
    expect(sessionIdentity({ id: 'ui-1', agentSessionId: 'agent-1', identity: 'wh-1' })).toBe('agent-1')
    expect(sessionIdentity({ id: 'ui-1', identity: 'wh-1' })).toBe('wh-1')
    expect(sessionIdentity({ id: 'ui-1' })).toBe('ui-1')
  })

  it('keeps a closed member listed, and shows it at its place once the session is open again', () => {
    const s = layout()
    const closed = sidebarRows(s, [{ key: 's3' }])
    expect(closed.map((r) => r.type)).toEqual(['group', 'group', 'session'])
    const first = closed[0]
    expect(first?.type === 'group' && first.members.map((x) => [x.member.key, x.session])).toEqual([['s1', undefined], ['s2', undefined]])
    // The same identity opened again (a resume from History) lands in its group at its position.
    const reopened = sidebarRows(s, [{ key: 's2' }, { key: 's3' }])
    const group = reopened[0]
    expect(group?.type === 'group' && group.members.map((x) => [x.member.key, Boolean(x.session)])).toEqual([['s1', false], ['s2', true]])
    expect(reopened.filter((r) => r.type === 'session')).toHaveLength(1)
  })

  it('does not drop members when the top level is reconciled with no open sessions', () => {
    const s = reconcileTop(layout(), [])
    expect(keys(s, 'a')).toEqual(['s1', 's2'])
    expect(s.top).toEqual([{ kind: 'group', id: 'a' }, { kind: 'group', id: 'b' }])
  })

  it('removes a member only when asked to', () => {
    const s = removeMember(layout(), 's1')
    expect(keys(s, 'a')).toEqual(['s2'])
    expect(removeMember(s, 'nope')).toBe(s)
  })

  it('refreshes the remembered title and folder of open members', () => {
    const s = layout()
    const next = refreshMembers(s, [m('s1', 'Renamed')])
    expect(next.groups[0]?.members[0]?.title).toBe('Renamed')
    expect(refreshMembers(next, [m('s1', 'Renamed')])).toBe(next)
  })
})

describe('groups', () => {
  it('renames, collapses and deletes; open members return to the top level, closed ones go with the group', () => {
    let s = renameGroup(layout(), 'a', 'Work')
    s = setGroupCollapsed(s, 'a', true)
    expect(s.groups[0]).toMatchObject({ name: 'Work', collapsed: true })
    s = deleteGroup(s, 'a', new Set(['s2']))
    expect(s.groups.map((g) => g.id)).toEqual(['b'])
    expect(s.top).toEqual([{ kind: 'session', key: 's2' }, { kind: 'group', id: 'b' }, { kind: 'session', key: 's3' }])
  })

  it('moves sessions into, between and out of groups', () => {
    let s = moveToGroup(layout(), m('s3'), 'b')
    expect(keys(s, 'b')).toEqual(['s3'])
    expect(s.top).toEqual([{ kind: 'group', id: 'a' }, { kind: 'group', id: 'b' }])
    s = moveToGroup(s, m('s1'), 'b')
    expect(keys(s, 'a')).toEqual(['s2'])
    expect(keys(s, 'b')).toEqual(['s3', 's1'])
    s = ungroup(s, 's3')
    expect(s.top).toEqual([{ kind: 'group', id: 'a' }, { kind: 'group', id: 'b' }, { kind: 'session', key: 's3' }].filter(Boolean))
    expect(groupOf(s, 's3')).toBeUndefined()
  })

  it('puts an ungrouped session below its group when it leaves it, and at the top on a header drop', () => {
    const s = ungroup(layout(), 's1')
    expect(s.top.slice(0, 2)).toEqual([{ kind: 'group', id: 'a' }, { kind: 'session', key: 's1' }])
    expect(ungroup(layout(), 's3', 0).top[0]).toEqual({ kind: 'session', key: 's3' })
    expect(ungroup(layout(), 's3')).toEqual(layout())
  })

  it('reorders inside a group the way a drag does', () => {
    let s = moveToGroup(layout(), m('s4'), 'a')
    expect(keys(s, 'a')).toEqual(['s1', 's2', 's4'])
    s = moveOnto(s, m('s4'), 's1')
    expect(keys(s, 'a')).toEqual(['s4', 's1', 's2'])
    s = moveOnto(s, m('s4'), 's2')
    expect(keys(s, 'a')).toEqual(['s1', 's2', 's4'])
  })

  it('drops a top-level session onto a grouped one and joins that group', () => {
    const s = moveOnto(layout(), m('s3'), 's2')
    expect(keys(s, 'a')).toEqual(['s1', 's3', 's2'])
    expect(s.top.some((x) => x.kind === 'session' && x.key === 's3')).toBe(false)
  })

  it('Move Up and Move Down act inside the container and stop at its ends', () => {
    let s = moveBy(layout(), 's2', -1)
    expect(keys(s, 'a')).toEqual(['s2', 's1'])
    expect(moveBy(s, 's2', -1)).toBe(s)
    s = moveBy(s, 's3', -1)
    expect(s.top).toEqual([{ kind: 'group', id: 'a' }, { kind: 'session', key: 's3' }, { kind: 'group', id: 'b' }])
  })

  it('moves groups among the top-level rows', () => {
    let s = moveGroupBy(layout(), 'a', 1)
    expect(s.top.map((x) => (x.kind === 'group' ? x.id : x.key))).toEqual(['b', 'a', 's3'])
    // Dropped on a row below it, a group lands below that row (as a session does).
    s = moveGroupOnto(s, 'a', { kind: 'session', key: 's3' })
    expect(s.top.map((x) => (x.kind === 'group' ? x.id : x.key))).toEqual(['b', 's3', 'a'])
    s = moveGroupOnto(s, 'a', { kind: 'group', id: 'b' })
    expect(s.top.map((x) => (x.kind === 'group' ? x.id : x.key))).toEqual(['a', 'b', 's3'])
  })
})

describe('replaceSessionIdentity', () => {
  it('hands the group and position to the replacement', () => {
    const s = replaceSessionIdentity(layout(), 's1', 'n1', { title: 'Restarted' })
    expect(s.groups[0]?.members).toEqual([{ ...m('n1'), title: 'Restarted' }, m('s2')])
  })

  it('hands over a top-level place too', () => {
    const s = replaceSessionIdentity(layout(), 's3', 'n3')
    expect(s.top).toEqual([{ kind: 'group', id: 'a' }, { kind: 'group', id: 'b' }, { kind: 'session', key: 'n3' }])
  })

  it('never lists a session twice when the replacement already has a place', () => {
    const s = replaceSessionIdentity(layout(), 's1', 's2')
    expect(keys(s, 'a')).toEqual(['s2'])
  })

  it('is a no-op for an unknown or equal identity, at config level too', () => {
    const base = layout()
    expect(replaceSessionIdentity(base, 'x', 'y')).toEqual(base)
    expect(replaceSessionIdentity(base, 's1', 's1')).toBe(base)
    const config = { ...emptyConfig(), sessionGroups: base }
    const moved = replaceStoredSessionIdentity(config, 's2', 'n2')
    expect(moved.ok && keys(moved.value.sessionGroups!, 'a')).toEqual(['s1', 'n2'])
    const untouched = replaceStoredSessionIdentity(emptyConfig(), 'a', 'b')
    expect(untouched.ok && untouched.value).toEqual(emptyConfig())
  })
})

describe('reconcileTop', () => {
  it('adds open sessions at the end, drops closed ungrouped ones and never lists a grouped session loose', () => {
    const s = reconcileTop(layout(), ['s2', 's5', 's3'])
    expect(s.top).toEqual([{ kind: 'group', id: 'a' }, { kind: 'group', id: 'b' }, { kind: 'session', key: 's3' }, { kind: 'session', key: 's5' }])
  })

  it('returns the same object when nothing changes', () => {
    const s = layout()
    expect(reconcileTop(s, ['s3'])).toBe(s)
  })
})

describe('attention', () => {
  it('flags only what happens off screen and keeps the most urgent reason', () => {
    expect(raiseAttention(undefined, 'replied', true)).toBeUndefined()
    expect(raiseAttention(undefined, 'replied', false)).toBe('replied')
    expect(raiseAttention('replied', 'needsAnswer', false)).toBe('needsAnswer')
    expect(raiseAttention('error', 'replied', false)).toBe('error')
    expect(raiseAttention('replied', 'error', true)).toBe('replied')
  })

  it('reads a finished turn, a failure and nothing else from state changes', () => {
    expect(attentionFromTransition('busy', 'ready')).toBe('replied')
    expect(attentionFromTransition('starting', 'ready')).toBeNull()
    expect(attentionFromTransition('busy', 'stopped')).toBeNull()
    expect(attentionFromTransition('busy', 'error')).toBe('error')
    expect(attentionFromTransition(undefined, 'error')).toBe('error')
    expect(attentionFromTransition('ready', 'ready')).toBeNull()
  })

  it('shows error over needs answer over ready to review over working', () => {
    expect(statusLevel({ state: 'busy' })).toBe('working')
    expect(statusLevel({ state: 'ready', unseen: 'replied' })).toBe('readyToReview')
    expect(statusLevel({ state: 'busy', unseen: 'replied' })).toBe('readyToReview')
    expect(statusLevel({ state: 'ready', awaitingAnswer: true })).toBe('needsAnswer')
    expect(statusLevel({ state: 'error' })).toBe('error')
    expect(statusLevel({ state: 'ready' })).toBeNull()
    expect(statusLevel({ state: 'stopped' })).toBeNull()
  })

  it('aggregates a count of unseen sessions and the top state', () => {
    expect(aggregateAttention([])).toEqual({ count: 0, level: null })
    expect(aggregateAttention([{ state: 'busy' }, { state: 'ready' }])).toEqual({ count: 0, level: 'working' })
    expect(aggregateAttention([{ state: 'busy' }, { state: 'ready', unseen: 'replied' }])).toEqual({ count: 1, level: 'readyToReview' })
    expect(
      aggregateAttention([
        { state: 'ready', unseen: 'replied' },
        { state: 'busy', unseen: 'needsAnswer' },
        { state: 'error', unseen: 'error' }
      ])
    ).toEqual({ count: 3, level: 'error' })
  })

  it('puts the group name in front of the session title', () => {
    expect(notificationTitle('Claude', 'Backend')).toBe('Backend · Claude')
    expect(notificationTitle('Claude')).toBe('Claude')
  })
})

describe('config version 3', () => {
  it('migrates a version 2 document unchanged, with the notification switches on', () => {
    const migrated = migrateConfig({ version: 2, profiles: [{ id: 'acme', name: 'Acme' }] }, MIGRATIONS, 3)
    expect(migrated).toEqual({ version: 3, profiles: [{ id: 'acme', name: 'Acme' }] })
    const parsed = parseConfig({ version: 2, options: { claudePlanUsage: true } })
    expect(parsed.version).toBe(CONFIG_VERSION)
    expect(parsed.options).toEqual({ claudePlanUsage: true, notifyReplied: true, notifyNeedsAnswer: true, notifyError: true })
    expect(parsed.sessionGroups).toBeUndefined()
  })

  it('round-trips stored groups and fills their defaults', () => {
    const parsed = parseConfig({
      version: 2,
      sessionGroups: { groups: [{ id: 'g1', name: 'Work', members: [m('s1')] }], top: [{ kind: 'group', id: 'g1' }] }
    })
    expect(parsed.sessionGroups?.groups[0]).toEqual({ id: 'g1', name: 'Work', collapsed: false, members: [m('s1')] })
    expect(parseConfig(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })
})
