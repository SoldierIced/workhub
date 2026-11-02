import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, cleanBranchName, parseConfig, visibleChildren, worktreeBranch, worktreeDefault, worktreeFolderName, worktreeSettings, worktreesLocation } from '../src'

describe('worktree settings', () => {
  it('are off with defaults when the profile has none', () => {
    expect(worktreeSettings({})).toEqual({ enabled: false, location: '', branchPrefix: '', baseRef: '', onClose: 'ask' })
    expect(worktreeSettings({ worktrees: { enabled: true, location: '', branchPrefix: 'feat/', baseRef: 'develop', onClose: 'keep' } }).branchPrefix).toBe('feat/')
  })

  it('parse from an older profile with only some fields', () => {
    const parsed = parseConfig({ version: CONFIG_VERSION, profiles: [{ id: 'acme', name: 'Acme', worktrees: { enabled: true }, folderOptions: { '~/work': { worktrees: false } } }] })
    expect(parsed.profiles[0]?.folderOptions).toEqual({ '~/work': { worktrees: false } })
    expect(parsed.profiles[0]?.worktrees).toEqual({ enabled: true, location: '', branchPrefix: '', baseRef: '', onClose: 'ask' })
  })

  it('let the deepest folder option override the profile', () => {
    const profile = {
      worktrees: { enabled: true, location: '', branchPrefix: '', baseRef: '', onClose: 'ask' as const },
      folderOptions: { '~/work': { worktrees: false }, '~/work/acme-api': { worktrees: true }, '~/work/docs': { onlyGitRepos: true } }
    }
    expect(worktreeDefault(profile, '/home/u/work/acme-api/src', '/home/u')).toBe(true)
    expect(worktreeDefault(profile, '/home/u/work/acme-web', '/home/u')).toBe(false)
    expect(worktreeDefault(profile, '/home/u/elsewhere', '/home/u')).toBe(true)
    expect(worktreeDefault({ folderOptions: { '/w': { worktrees: true } } }, '/w/x')).toBe(true)
    expect(worktreeDefault(undefined, '/w/x')).toBe(false)
  })
})

describe('worktree names', () => {
  it('clean what git refuses in a branch name', () => {
    expect(cleanBranchName('  fix login bug ')).toBe('fix-login-bug')
    expect(cleanBranchName('feat/..x:y?')).toBe('feat/xy')
    expect(cleanBranchName('a//b/.hidden/c.lock')).toBe('a/b/hidden/c')
    expect(cleanBranchName('~^*')).toBe('')
  })

  it('prefix the branch once and fall back to the session id', () => {
    expect(worktreeBranch({ branchPrefix: 'feat/' }, 'login', 'ab12')).toBe('feat/login')
    expect(worktreeBranch({ branchPrefix: 'feat/' }, 'feat/login', 'ab12')).toBe('feat/login')
    expect(worktreeBranch({ branchPrefix: '' }, '', 'ab12')).toBe('session-ab12')
    expect(worktreeBranch({ branchPrefix: 'wip-' }, undefined, 'ab12')).toBe('wip-session-ab12')
  })

  it('name the folder after the repository and the branch', () => {
    expect(worktreeFolderName('/home/u/work/acme-api', 'feat/login')).toBe('acme-api-feat-login')
    expect(worktreeFolderName('C:\\work\\acme-api', 'x')).toBe('acme-api-x')
  })

  it('expand the location template', () => {
    expect(worktreesLocation({ location: '' }, { folder: '/w', repo: '/w/acme' })).toBe('/w/_worktrees')
    expect(worktreesLocation({ location: '${repo}/.trees/' }, { folder: '/w', repo: '/w/acme' })).toBe('/w/acme/.trees')
    expect(worktreesLocation({ location: '~/trees' }, { folder: '/w', repo: '/w/acme' }, '/home/u')).toBe('/home/u/trees')
  })

  it('hide the worktrees folder from folder lists', () => {
    expect(visibleChildren([{ name: 'acme' }, { name: '_worktrees' }, { name: '.git' }], {})).toEqual(['acme'])
  })
})
