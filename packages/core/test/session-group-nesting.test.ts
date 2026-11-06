import { describe, expect, it } from 'vitest'
import {
  canNestGroup,
  createGroup,
  deleteGroup,
  descendantIds,
  EMPTY_SESSION_GROUPS,
  groupPath,
  groupTree,
  moveGroupBy,
  moveGroupOnto,
  moveToGroup,
  nestGroup,
  parentIdOf,
  parseConfig,
  parseGroupChoice,
  placeInGroup,
  reconcileTop,
  sidebarRows,
  subtreeMembers,
  type GroupMember,
  type SessionGroups
} from '../src'

const member = (key: string): GroupMember => ({ key, title: key, agentKey: 'claude', cwd: '/work/acme' })

/** Work > Backend > Jobs, and Side at the top level. */
function tree(): SessionGroups {
  let s = createGroup(EMPTY_SESSION_GROUPS, 'work', 'Work')
  s = createGroup(s, 'side', 'Side')
  s = createGroup(s, 'backend', 'Backend', undefined, undefined, 'work')
  s = createGroup(s, 'jobs', 'Jobs', undefined, undefined, 'backend')
  return s
}

describe('nested session groups', () => {
  it('creates a sub-group inside its parent, without a top-level slot', () => {
    const s = tree()
    expect(s.top).toEqual([
      { kind: 'group', id: 'work' },
      { kind: 'group', id: 'side' }
    ])
    expect(parentIdOf(s, 'backend')).toBe('work')
    expect(parentIdOf(s, 'jobs')).toBe('backend')
    expect(groupPath(s, 'jobs')).toEqual(['Work', 'Backend', 'Jobs'])
    expect([...descendantIds(s, 'work')]).toEqual(['backend', 'jobs'])
    // A parent that does not exist: the group goes to the top level.
    expect(createGroup(EMPTY_SESSION_GROUPS, 'x', 'X', undefined, undefined, 'missing').top).toEqual([{ kind: 'group', id: 'x' }])
  })

  it('builds the sidebar tree with depths, and the header counts roll up', () => {
    let s = moveToGroup(tree(), member('a'), 'work')
    s = moveToGroup(s, member('b'), 'jobs')
    const rows = sidebarRows(s, [{ key: 'a' }, { key: 'b' }])
    const work = rows[0]
    if (work?.type !== 'group') throw new Error('expected a group')
    expect(work.children.map((c) => [c.group.id, c.depth])).toEqual([['backend', 1]])
    expect(work.children[0]?.children.map((c) => [c.group.id, c.depth])).toEqual([['jobs', 2]])
    expect(subtreeMembers(work).map((m) => m.member.key)).toEqual(['a', 'b'])
    expect(rows).toHaveLength(2)
    expect(groupTree(s).map((g) => [g.group.id, g.depth])).toEqual([
      ['work', 0],
      ['backend', 1],
      ['jobs', 2],
      ['side', 0]
    ])
  })

  it('never moves a group into itself or one of its own sub-groups', () => {
    const s = tree()
    expect(canNestGroup(s, 'work', 'jobs')).toBe(false)
    expect(canNestGroup(s, 'work', 'work')).toBe(false)
    expect(canNestGroup(s, 'side', 'jobs')).toBe(true)
    expect(nestGroup(s, 'work', 'jobs')).toBe(s)
    expect(moveGroupOnto(s, 'work', { kind: 'group', id: 'jobs' })).toBe(s)
  })

  it('moves a group into another one and back out, next to its old top-level group', () => {
    const into = nestGroup(tree(), 'side', 'backend')
    expect(parentIdOf(into, 'side')).toBe('backend')
    expect(into.top).toEqual([{ kind: 'group', id: 'work' }])
    const out = nestGroup(into, 'side', null)
    expect(parentIdOf(out, 'side')).toBeUndefined()
    expect(out.top).toEqual([
      { kind: 'group', id: 'work' },
      { kind: 'group', id: 'side' }
    ])
  })

  it('reorders sub-groups among their siblings, and a drop on a sub-group places beside it', () => {
    let s = createGroup(tree(), 'web', 'Web', undefined, undefined, 'work')
    expect(groupTree(s).filter((g) => g.depth === 1).map((g) => g.group.id)).toEqual(['backend', 'web'])
    s = moveGroupBy(s, 'web', -1)
    expect(groupTree(s).filter((g) => g.depth === 1).map((g) => g.group.id)).toEqual(['web', 'backend'])
    const dropped = moveGroupOnto(s, 'side', { kind: 'group', id: 'backend' })
    expect(parentIdOf(dropped, 'side')).toBe('work')
    expect(dropped.top).toEqual([{ kind: 'group', id: 'work' }])
  })

  it('deleting a group moves its sub-groups and open sessions to where it was', () => {
    let s = moveToGroup(tree(), member('open'), 'backend')
    s = moveToGroup(s, member('closed'), 'backend')
    const nested = deleteGroup(s, 'backend', new Set(['open']))
    expect(parentIdOf(nested, 'jobs')).toBe('work')
    expect(nested.groups.find((g) => g.id === 'work')?.members.map((m) => m.key)).toEqual(['open'])
    const top = deleteGroup(tree(), 'work', new Set())
    expect(top.top).toEqual([
      { kind: 'group', id: 'backend' },
      { kind: 'group', id: 'side' }
    ])
    expect(parentIdOf(top, 'backend')).toBeUndefined()
  })

  it('treats a loop of parents (a hand-edited config) as top-level groups', () => {
    const looped: SessionGroups = {
      groups: [
        { id: 'a', name: 'A', collapsed: false, parentId: 'b', members: [] },
        { id: 'b', name: 'B', collapsed: false, parentId: 'a', members: [] }
      ],
      top: []
    }
    expect(parentIdOf(looped, 'a')).toBeUndefined()
    expect(reconcileTop(looped, []).top).toEqual([
      { kind: 'group', id: 'a' },
      { kind: 'group', id: 'b' }
    ])
  })

  it('keeps a stored parent, and reads older configs without one', () => {
    const groups = (parentId?: string) => ({ sessionGroups: { groups: [{ id: 'g', name: 'G', ...(parentId ? { parentId } : {}) }], top: [] } })
    expect(parseConfig(groups()).sessionGroups?.groups[0]).toMatchObject({ id: 'g', collapsed: false, members: [] })
    expect(parseConfig(groups()).sessionGroups?.groups[0]?.parentId).toBeUndefined()
    expect(parseConfig(groups('p')).sessionGroups?.groups[0]?.parentId).toBe('p')
  })
})

describe('the group a new session starts in', () => {
  it('reads only a group id or a non-empty name', () => {
    expect(parseGroupChoice({ groupId: 'g1' })).toEqual({ groupId: 'g1' })
    expect(parseGroupChoice({ name: '  Backend  ' })).toEqual({ name: 'Backend' })
    expect(parseGroupChoice({ name: '   ' })).toBeUndefined()
    expect(parseGroupChoice({ groupId: 3 })).toBeUndefined()
    expect(parseGroupChoice(null)).toBeUndefined()
    expect(parseGroupChoice({ name: 'x'.repeat(500) })).toEqual({ name: 'x'.repeat(120) })
  })

  it('puts it in a group by id, reuses a group by name, or makes a new one', () => {
    const s = tree()
    expect(placeInGroup(s, member('a'), { groupId: 'jobs' }, 'new').groups.find((g) => g.id === 'jobs')?.members.map((m) => m.key)).toEqual(['a'])
    expect(placeInGroup(s, member('a'), { groupId: 'gone' }, 'new')).toBe(s)
    const reused = placeInGroup(s, member('a'), { name: ' side ' }, 'new')
    expect(reused.groups).toHaveLength(4)
    expect(reused.groups.find((g) => g.id === 'side')?.members.map((m) => m.key)).toEqual(['a'])
    const made = placeInGroup(s, member('a'), { name: 'Docs' }, 'new')
    expect(made.groups.find((g) => g.id === 'new')).toMatchObject({ name: 'Docs', members: [member('a')] })
    expect(made.top.at(-1)).toEqual({ kind: 'group', id: 'new' })
  })
})
