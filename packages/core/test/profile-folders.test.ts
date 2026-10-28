import { describe, expect, it } from 'vitest'
import {
  containingFolder,
  emptyConfig,
  expandProfileFolders,
  folderSpend,
  historyInProfile,
  owningProfile,
  planWorkhub1Import,
  fillWorkhub1FolderFlags,
  profileRootFor,
  projectChildren,
  spendKey,
  type FolderProfile,
  type Profile
} from '../src'

const work: FolderProfile = { id: 'work', folders: ['~/work'] }
const client: FolderProfile = { id: 'client', folders: ['/home/u/work/client-x'] }
const personal: FolderProfile = { id: 'personal', folders: ['/home/u/code'], ownsOutside: true }
const all = [work, client, personal]
const HOME = '/home/u'

describe('owningProfile', () => {
  it('gives a folder to the profile whose deepest folder holds it', () => {
    expect(owningProfile('/home/u/work/api', all, HOME)?.id).toBe('work')
    expect(owningProfile('/home/u/work', all, HOME)?.id).toBe('work')
    expect(owningProfile('/home/u/work/client-x/src', all, HOME)?.id).toBe('client')
    expect(owningProfile('/home/u/code/', all, HOME)?.id).toBe('personal')
  })

  it('gives folders outside every profile to the one that also owns them, else to none', () => {
    expect(owningProfile('/tmp/x', all, HOME)?.id).toBe('personal')
    expect(owningProfile('/home/u/work-old', all, HOME)?.id).toBe('personal')
    expect(owningProfile('/tmp/x', [work, client], HOME)).toBeUndefined()
    expect(owningProfile('', all, HOME)).toBeUndefined()
    expect(owningProfile(undefined, all, HOME)).toBeUndefined()
  })

  it('keeps the first profile on a tie and leaves `~` alone without a home', () => {
    expect(owningProfile('/a/b', [{ id: 'one', folders: ['/a'] }, { id: 'two', folders: ['/a/'] }])?.id).toBe('one')
    expect(owningProfile('/home/u/work/api', [work])).toBeUndefined()
  })
})

describe('profile roots', () => {
  it('picks the deepest folder holding a path, else the first folder', () => {
    const p = { folders: ['~/a', '~/a/b', '/x'] }
    expect(containingFolder('/home/u/a/b/c', p, HOME)).toEqual({ folder: '~/a/b', path: '/home/u/a/b' })
    expect(profileRootFor('/x/y', p, HOME)).toBe('/x')
    expect(profileRootFor('/elsewhere', p, HOME)).toBe('/home/u/a')
    expect(profileRootFor('/elsewhere', { folders: [] }, HOME)).toBeUndefined()
  })
})

describe('expandProfileFolders', () => {
  const listing = {
    '/home/u/work': [{ name: 'web', isGitRepo: true }, { name: 'notes', isGitRepo: false }, { name: '.cache', isGitRepo: true }, { name: 'api10' }, { name: 'api9', isGitRepo: true }],
    '/home/u/solo': [{ name: 'src' }]
  }

  it('lists each folder, then its visible child folders in natural order', () => {
    const list = expandProfileFolders({ folders: ['~/work', '/home/u/work/', '~/missing', ''] }, listing, HOME)
    expect(list.map((p) => [p.name, p.root])).toEqual([
      ['work', true],
      ['api9', false],
      ['api10', false],
      ['notes', false],
      ['web', false]
    ])
    expect(list[1]).toEqual({ path: '/home/u/work/api9', name: 'api9', root: false, folder: '~/work' })
  })

  it('keeps only git repositories in a folder marked "Only git repos"', () => {
    const list = expandProfileFolders({ folders: ['~/work', '~/solo'], folderOptions: { '/home/u/work': { onlyGitRepos: true } } }, listing, HOME)
    expect(list.map((p) => p.name)).toEqual(['work', 'api9', 'web', 'solo', 'src'])
  })

  it('splits a folder into projects when "Each subfolder is its own project" is on, not when it is off', () => {
    const profile = { folders: ['~/work', '~/solo'], folderOptions: { '~/work': { subfoldersAreProjects: true, onlyGitRepos: true }, '~/solo': { subfoldersAreProjects: false } } }
    expect(projectChildren(profile, listing, HOME)).toEqual({ '/home/u/work': ['api9', 'web'], '/home/u/solo': [] })
  })

  it('left unset, splits every folder that is not a repository, as before the switch existed', () => {
    const profile = { folders: ['~/work', '~/solo'] }
    expect(projectChildren(profile, listing, HOME, (p) => p === '/home/u/solo')).toEqual({ '/home/u/work': ['api9', 'api10', 'notes', 'web'], '/home/u/solo': [] })
  })
})

describe('ownership in history and token spend', () => {
  it('lists a past session under the profile that owns its folder', () => {
    const entry = (cwd: string) => ({ cwd, accountId: null })
    const scope = { profiles: all, home: HOME }
    expect(historyInProfile(entry('/home/u/work/api'), { ...work, accountIds: [] }, scope)).toBe(true)
    expect(historyInProfile(entry('/home/u/work/client-x'), { ...work, accountIds: [] }, scope)).toBe(false)
    expect(historyInProfile(entry('/srv/other'), { ...personal, accountIds: [] }, scope)).toBe(true)
    expect(historyInProfile(entry('/srv/other'), { ...work, accountIds: [] }, scope)).toBe(false)
  })

  it("goes by folder when profiles share an account: another profile's folder is not listed", () => {
    const shared = ['acc-a', 'acc-b']
    const scope = { profiles: [{ ...work, accountIds: shared }, { ...personal, accountIds: shared }], home: HOME }
    expect(historyInProfile({ cwd: '/srv/other', accountId: 'acc-a' }, { ...work, accountIds: shared }, scope)).toBe(false)
    expect(historyInProfile({ cwd: '/home/u/work/api', accountId: 'acc-a' }, { ...work, accountIds: shared }, scope)).toBe(true)
  })

  it('counts spend only where the profile owns the work, and outside work under its own folder', () => {
    const day = '2026-10-27'
    const buckets = {
      [spendKey(day, 'claude', '/home/u/work/api')]: 5,
      [spendKey(day, 'claude', '/home/u/work/client-x/src')]: 9,
      [spendKey(day, 'codex', '/srv/scripts')]: 4,
      [spendKey(day, 'claude', '/tmp/run')]: 2
    }
    const owns = (id: string) => (path: string) => owningProfile(path, all, HOME)?.id === id
    expect(folderSpend(buckets, ['/home/u/work'], { sinceDay: day, owns: owns('work') }).map((e) => [e.name, e.tokens])).toEqual([['work', 5]])
    expect(folderSpend(buckets, ['/home/u/code'], { sinceDay: day, owns: owns('personal') }).map((e) => [e.name, e.path, e.tokens])).toEqual([['scripts', '/srv/scripts', 4]])
  })
})

describe('Workhub 1 import of the folder switches', () => {
  it('keeps "Only git repos", "Each subfolder is its own project" and the profile owning everything outside', () => {
    const plan = planWorkhub1Import(
      {
        profiles: [
          { id: 'a', name: 'A', folders: [{ path: '~/work', onlyGitRepos: true, isContainer: true }, { path: '~/plain' }], catchesOtherFolders: true },
          { id: 'b', name: 'B', folders: [{ path: '~/b', isContainer: true }], catchesOtherFolders: true }
        ]
      },
      emptyConfig(),
      HOME
    )
    const [a, b] = plan.profiles
    expect(a?.folderOptions).toEqual({ '/home/u/work': { onlyGitRepos: true, subfoldersAreProjects: true } })
    expect(a?.ownsOutside).toBe(true)
    expect(b?.folderOptions).toEqual({ '/home/u/b': { subfoldersAreProjects: true } })
    expect(b?.ownsOutside).toBeUndefined()
  })
})

describe('fillWorkhub1FolderFlags', () => {
  const v1 = {
    profiles: [
      { id: 'Wayni', name: 'Wayni', folders: [{ path: '~/wayni', onlyGitRepos: true, isContainer: true }, { path: '~/notes' }], catchesOtherFolders: true },
      { id: 'other', name: 'Other', folders: [{ path: '~/o', isContainer: true }] }
    ]
  }
  const base = (extra: Partial<Profile> = {}): Profile => ({ id: 'wayni', name: 'Wayni', connections: {}, accountIds: [], modules: {} as Profile['modules'], folders: ['/home/u/wayni/', '/home/u/notes'], ...extra })

  it('fills the switches Workhub 1 turned on into profiles that leave them unset', () => {
    const [filled, ...rest] = fillWorkhub1FolderFlags(v1, { profiles: [base()] }, HOME)
    expect(rest).toEqual([])
    expect(filled?.folderOptions).toEqual({ '/home/u/wayni/': { onlyGitRepos: true, subfoldersAreProjects: true } })
    expect(filled?.ownsOutside).toBe(true)
  })

  it('never changes a value set in Workhub 2, on or off, and keeps one owner of the outside folders', () => {
    const set = base({ folderOptions: { '/home/u/wayni': { subfoldersAreProjects: false } }, ownsOutside: false })
    expect(fillWorkhub1FolderFlags(v1, { profiles: [set] }, HOME)[0]?.folderOptions).toEqual({ '/home/u/wayni': { subfoldersAreProjects: false, onlyGitRepos: true } })
    expect(fillWorkhub1FolderFlags(v1, { profiles: [set] }, HOME)[0]?.ownsOutside).toBe(false)
    const owner = { ...base({ id: 'x', folders: [] }), ownsOutside: true }
    expect(fillWorkhub1FolderFlags(v1, { profiles: [base(), owner] }, HOME)[0]?.ownsOutside).toBeUndefined()
    const done = base({ folderOptions: { '/home/u/wayni': { onlyGitRepos: true, subfoldersAreProjects: true } }, ownsOutside: true })
    expect(fillWorkhub1FolderFlags(v1, { profiles: [done] }, HOME)).toEqual([])
  })
})
