import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SubagentSummary } from '@workhub/core'
import { profileWorkspaces } from '../src/main/workspaces'
import { folderSections, newSessionProfile, RECENT_FOLDERS, toggleFavorite, type FolderSessionInfo } from '../src/renderer/lib/folders'
import { parsePrefs } from '../src/renderer/lib/prefs'
import { SUBAGENT_RETENTION_MS, visibleSubagents } from '../src/renderer/lib/subagentView'

const ws = (path: string, root = false) => ({ path, name: path.split('/').pop()!, root })
const run = (cwd: string, startedAt: number, fields: Partial<FolderSessionInfo> = {}): FolderSessionInfo => ({ cwd, startedAt, state: 'ready', profileId: 'acme', ...fields })

describe('the sidebar folder browser', () => {
  const workspaces = [ws('/work', true), ws('/work/api'), ws('/work/web'), ws('/work/shop-api')]

  it('lists Favorites, Recent (newest first, without favorites) and All folders', () => {
    const s = folderSections({
      workspaces,
      favorites: ['/work/web/'],
      sessions: [run('/work/api', 1), run('/work/web', 3), run('/tmp/scratch', 2), run('/work/api', 4, { state: 'busy' })],
      profileId: 'acme',
      query: ''
    })
    expect(s.favorites.map((f) => [f.path, f.favorite, f.open])).toEqual([['/work/web', true, 1]])
    expect(s.recent.map((f) => f.path)).toEqual(['/work/api', '/tmp/scratch'])
    expect(s.recent[0]?.open).toBe(2)
    expect(s.recent[1]?.name).toBe('scratch')
    expect(s.all.map((f) => [f.name, f.root])).toEqual([['work', true], ['api', false], ['web', false], ['shop-api', false]])
    expect(s.results).toBeNull()
  })

  it('keeps Recent to the active profile and to six folders', () => {
    const many = Array.from({ length: 9 }, (_, i) => run(`/r/${i}`, i))
    const s = folderSections({ workspaces: [], favorites: [], sessions: [...many, run('/other', 99, { profileId: 'side' })], profileId: 'acme', query: '' })
    expect(s.recent).toHaveLength(RECENT_FOLDERS)
    expect(s.recent[0]?.path).toBe('/r/8')
    expect(s.recent.some((f) => f.path === '/other')).toBe(false)
  })

  it('filters every folder by name or path, names that start with the text first', () => {
    const s = folderSections({ workspaces, favorites: [], sessions: [run('/tmp/api-notes', 1)], profileId: 'acme', query: '  API ' })
    expect(s.results?.map((f) => f.path)).toEqual(['/tmp/api-notes', '/work/api', '/work/shop-api'])
    expect(folderSections({ workspaces, favorites: [], sessions: [], profileId: null, query: 'zzz' }).results).toEqual([])
  })

  it('stars and unstars a folder', () => {
    expect(toggleFavorite([], '/work/api/')).toEqual(['/work/api'])
    expect(toggleFavorite(['/work/api', '/work/web'], '/work/api')).toEqual(['/work/web'])
  })

  it('keeps the starred folders in the preferences, dropping anything that is not a path', () => {
    expect(parsePrefs(JSON.stringify({ favoriteFolders: ['/a', 3, '', '/a', '/b'] })).favoriteFolders).toEqual(['/a', '/b'])
    expect(parsePrefs(null).favoriteFolders).toEqual([])
  })
})

describe('the folders of a profile (main)', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'workhub-folders-'))
    for (const d of ['work/b-repo', 'work/a-repo', 'work/.hidden', 'work/repo10', 'work/repo9', 'solo']) mkdirSync(join(home, d), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('lists each folder, then the folders inside it in natural order, hidden ones and missing folders left out', async () => {
    const list = await profileWorkspaces({ folders: ['~/work', join(home, 'work'), '~/missing', ''] }, home)
    expect(list.map((f) => [f.name, f.root])).toEqual([
      ['work', true],
      ['a-repo', false],
      ['b-repo', false],
      ['repo9', false],
      ['repo10', false]
    ])
    expect(list[1]?.path).toBe(join(home, 'work', 'a-repo'))
  })

  it('lists only the git repositories of a folder marked "Only git repos"', async () => {
    mkdirSync(join(home, 'work', 'a-repo', '.git'), { recursive: true })
    writeFileSync(join(home, 'work', 'repo9', '.git'), 'gitdir: elsewhere')
    const list = await profileWorkspaces({ folders: ['~/work'], folderOptions: { '~/work': { onlyGitRepos: true } } }, home)
    expect(list.map((f) => f.name)).toEqual(['work', 'a-repo', 'repo9'])
  })
})

describe('sub-agents under a session row', () => {
  const now = 10_000_000
  const sub = (id: string, fields: Partial<SubagentSummary>): SubagentSummary => ({ id, ...fields })

  it('lists the ones at work and the ones that ended within the retention time, newest first', () => {
    const list = visibleSubagents(
      [
        sub('running', { status: 'running', startedAt: 1, lastActivityAt: 1 }),
        sub('recent', { status: 'completed', startedAt: 5, lastActivityAt: now - SUBAGENT_RETENTION_MS + 1_000 }),
        sub('old', { status: 'completed', startedAt: 3, lastActivityAt: now - SUBAGENT_RETENTION_MS - 1 }),
        sub('failed-old', { status: 'failed', startedAt: 2 }),
        sub('unknown', { startedAt: 4 })
      ],
      now
    )
    expect(list.map((s) => s.id)).toEqual(['recent', 'unknown', 'running'])
    expect(visibleSubagents(undefined, now)).toEqual([])
  })
})

describe('the profile of a new session', () => {
  const profiles = [
    { id: 'work', folders: ['~/work'] },
    { id: 'home', folders: ['/srv/home'], ownsOutside: true }
  ]
  it('starts in the profile that owns the folder, else the active one', () => {
    expect(newSessionProfile('/u/work/api', 'home', profiles, '/u')).toBe('work')
    expect(newSessionProfile('/elsewhere', 'work', profiles, '/u')).toBe('home')
    expect(newSessionProfile('/elsewhere', 'work', [profiles[0]!], '/u')).toBe('work')
    expect(newSessionProfile('', null, profiles, '/u')).toBeNull()
  })
})
