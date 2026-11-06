import { describe, expect, it, vi } from 'vitest'
import { createGroup, EMPTY_SESSION_GROUPS, type SessionGroups } from '@workhub/core'
import type { SessionView } from '../src/shared/api'
import { startPlaced, type SessionPlacementDeps } from '../src/main/session-placement'
import { folderGroups, folderSections, groupMatches, isFolderOpen, toggleExpanded } from '../src/renderer/lib/folders'
import { parsePrefs } from '../src/renderer/lib/prefs'
import { groupChoiceOf, groupOptionsOf, NEW_GROUP } from '../src/renderer/lib/sessionGroups'

const ws = (path: string, root = false) => ({ path, name: path.split('/').pop()!, root })
// Two profile folders, the first a container of repositories, the second a single project.
const workspaces = [ws('/work/acme', true), ws('/work/acme/api'), ws('/work/acme/web'), ws('/work/acme/shop-api'), ws('/work/side', true), ws('/work/side/notes')]
const sections = (query = '', favorites: string[] = []) => folderSections({ workspaces, favorites, sessions: [], profileId: 'acme', query })

describe('the folders panel, by profile folder', () => {
  it('makes one section per profile folder with the folders inside it', () => {
    const groups = folderGroups(sections().all)
    expect(groups.map((g) => [g.root.name, g.children.map((c) => c.name)])).toEqual([
      ['acme', ['api', 'web', 'shop-api']],
      ['side', ['notes']]
    ])
    // One profile folder: one section, nothing else nested.
    expect(folderGroups(folderSections({ workspaces: [ws('/solo', true), ws('/solo/a')], favorites: [], sessions: [], profileId: null, query: '' }).all)).toHaveLength(1)
  })

  it('groups the filter matches under their profile folder and keeps the others apart', () => {
    const s = folderSections({ workspaces, favorites: ['/tmp/api-notes'], sessions: [], profileId: 'acme', query: 'api' })
    const m = groupMatches(s.all, s.results!)
    expect(m.groups.map((g) => [g.root.name, g.children.map((c) => c.name)])).toEqual([['acme', ['api', 'shop-api']]])
    expect(m.other.map((f) => f.path)).toEqual(['/tmp/api-notes'])
    // A profile folder that matches by its own name brings the folders inside it (their paths match too).
    const own = sections('side')
    expect(groupMatches(own.all, own.results!).groups.map((g) => [g.root.name, g.children.map((c) => c.name)])).toEqual([['side', ['notes']]])
    // A match on a profile folder alone (nothing inside it) is still listed.
    expect(groupMatches(own.all, own.results!.filter((f) => f.root)).groups.map((g) => [g.root.name, g.children.length])).toEqual([['side', 0]])
    expect(groupMatches(sections('zzz').all, []).groups).toEqual([])
  })

  it('unfolds the sections the user opened, and every section while filtering', () => {
    expect(isFolderOpen('/work/acme', [], false)).toBe(false)
    expect(isFolderOpen('/work/acme', ['/work/acme/'], false)).toBe(true)
    expect(isFolderOpen('/work/side', [], true)).toBe(true)
    expect(toggleExpanded([], '/work/acme/')).toEqual(['/work/acme'])
    expect(toggleExpanded(['/work/acme', '/work/side'], '/work/acme')).toEqual(['/work/side'])
  })

  it('keeps the unfolded sections in the preferences, folded by default', () => {
    expect(parsePrefs(null).expandedFolders).toEqual([])
    expect(parsePrefs(JSON.stringify({ expandedFolders: ['/work/acme', 7, '', '/work/acme', '/work/side'] })).expandedFolders).toEqual(['/work/acme', '/work/side'])
    expect(parsePrefs(JSON.stringify({ expandedFolders: 'nope' })).expandedFolders).toEqual([])
  })
})

describe('the New session dialog group', () => {
  const groups: SessionGroups = createGroup(createGroup(EMPTY_SESSION_GROUPS, 'work', 'Work'), 'backend', 'Backend', undefined, undefined, 'work')

  it('maps the select to what the session start asks for', () => {
    expect(groupChoiceOf('', '', groups.groups)).toBeUndefined()
    expect(groupChoiceOf('backend', '', groups.groups)).toEqual({ groupId: 'backend' })
    expect(groupChoiceOf('deleted', '', groups.groups)).toBeUndefined()
    expect(groupChoiceOf(NEW_GROUP, '  Docs ', groups.groups)).toEqual({ name: 'Docs' })
    expect(groupChoiceOf(NEW_GROUP, '   ', groups.groups)).toBeUndefined()
  })

  it('lists the groups in sidebar order, a sub-group by its path', () => {
    expect(groupOptionsOf(groups)).toEqual([
      { value: 'work', label: 'Work' },
      { value: 'backend', label: 'Work / Backend' }
    ])
  })
})

describe('placing a new session in its group (main)', () => {
  const view = (over: Partial<SessionView> = {}) => ({ id: 's1', identity: 'provisional', agentId: 'claude', accountId: null, cwd: '/work/acme/api', profileId: 'acme', agentName: 'Claude', ...over }) as SessionView
  function deps(start: SessionGroups, current: () => SessionView | undefined) {
    const store = { groups: start }
    const d: SessionPlacementDeps = {
      start: vi.fn(async () => view()),
      groups: async () => store.groups,
      saveGroups: vi.fn(async (g: SessionGroups) => {
        store.groups = g
        return { ok: true }
      }),
      replaceIdentity: vi.fn(async () => ({ ok: true })),
      current,
      changed: vi.fn(),
      newId: () => 'g-new'
    }
    return { d, store }
  }

  it('starts the session without the group field and saves its place', async () => {
    const { d, store } = deps(createGroup(EMPTY_SESSION_GROUPS, 'work', 'Work'), () => view())
    await startPlaced({ profileId: 'acme', agentKey: 'claude', cwd: '/work/acme/api', group: { groupId: 'work' } }, d)
    expect(d.start).toHaveBeenCalledWith({ profileId: 'acme', agentKey: 'claude', cwd: '/work/acme/api' })
    expect(store.groups.groups[0]?.members).toMatchObject([{ key: 'provisional', title: 'api', agentKey: 'claude', profileId: 'acme' }])
    expect(d.replaceIdentity).not.toHaveBeenCalled()
    expect(d.changed).toHaveBeenCalledTimes(1)
  })

  it('makes a new group by name', async () => {
    const { d, store } = deps(EMPTY_SESSION_GROUPS, () => view())
    await startPlaced({ profileId: 'acme', agentKey: 'claude', cwd: '/work/acme/api', group: { name: 'Docs' } }, d)
    expect(store.groups.groups).toMatchObject([{ id: 'g-new', name: 'Docs' }])
  })

  it('moves the place to the real identity the agent reported meanwhile', async () => {
    const { d } = deps(createGroup(EMPTY_SESSION_GROUPS, 'work', 'Work'), () => view({ identity: 'real', agentSessionId: 'real' }))
    await startPlaced({ profileId: 'acme', agentKey: 'claude', cwd: '/work/acme/api', group: { groupId: 'work' } }, d)
    expect(d.replaceIdentity).toHaveBeenCalledWith('provisional', 'real')
  })

  it('leaves the groups alone without a group, or with one that is gone', async () => {
    const { d } = deps(EMPTY_SESSION_GROUPS, () => view())
    await startPlaced({ profileId: 'acme', agentKey: 'claude', cwd: '/work/acme/api' }, d)
    await startPlaced({ profileId: 'acme', agentKey: 'claude', cwd: '/work/acme/api', group: { groupId: 'gone' } }, d)
    expect(d.saveGroups).not.toHaveBeenCalled()
  })
})
