import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitWorktrees } from '../src/git-worktree'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()

describe('GitWorktrees on a real repository', () => {
  let dir: string
  let repo: string
  const w = new GitWorktrees()
  const prevEnv = { ...process.env }

  beforeAll(() => {
    Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })
    // `native` also expands Windows short names (`RUNNER~1`), as git reports the path.
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'workhub-worktree-')))
    const remote = join(dir, 'remote.git')
    repo = join(dir, 'work', 'acme')
    mkdirSync(repo, { recursive: true })
    git(dir, 'init', '--quiet', '--bare', '-b', 'main', remote)
    git(repo, 'init', '--quiet', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'init')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '--quiet', '-u', 'origin', 'main')
    git(repo, 'remote', 'set-head', 'origin', 'main')
    git(repo, 'checkout', '--quiet', '-b', 'local-only')
    // A hook that a dev worktree must run (the reviewer's checkout never does).
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${join(dir, 'hook-ran')}"\n`, { mode: 0o755 })
    mkdirSync(join(repo, 'src'))
  })

  afterAll(() => {
    process.env = prevEnv
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds the repository root, also from a subfolder, and nothing outside one', async () => {
    expect(await w.repoRootOf(join(repo, 'src'))).toBe(repo)
    expect(await w.repoRootOf(dir)).toBeNull()
  })

  it('creates a new branch from the default branch, runs hooks, and resolves back to the main repository', async () => {
    const path = join(dir, 'work', '_worktrees', 'acme-feat-login')
    await w.create(repo, { path, branch: 'feat/login' })
    expect(git(path, 'branch', '--show-current')).toBe('feat/login')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'origin/main'))
    expect(existsSync(join(dir, 'hook-ran'))).toBe(true)
    expect(await w.repoRootOf(path)).toBe(repo)
    expect(await w.status(path)).toEqual({ dirty: false, unpushed: 0, branch: 'feat/login' })
    // No upstream: a plain `git push` must not go to main.
    expect(() => execFileSync('git', ['rev-parse', '--abbrev-ref', '@{u}'], { cwd: path, stdio: 'pipe' })).toThrow()

    writeFileSync(join(path, 'b.txt'), 'b\n')
    expect((await w.status(path)).dirty).toBe(true)
    git(path, 'add', '.')
    git(path, 'commit', '--quiet', '-m', 'feat: b')
    expect(await w.status(path)).toEqual({ dirty: false, unpushed: 1, branch: 'feat/login' })

    writeFileSync(join(path, 'c.txt'), 'c\n')
    await expect(w.remove(repo, path, { force: false })).rejects.toThrow(/git worktree remove failed/)
    await w.remove(repo, path, { force: true })
    expect(existsSync(path)).toBe(false)
    // The branch stays.
    expect(git(repo, 'branch', '--list', 'feat/login')).toContain('feat/login')
  })

  it('checks out an existing branch and keeps a worktree inside the repository out of its status', async () => {
    const path = join(repo, '_worktrees', 'acme-local-only-2')
    git(repo, 'branch', 'existing')
    await w.create(repo, { path, branch: 'existing', base: 'main' })
    expect(git(path, 'branch', '--show-current')).toBe('existing')
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/_worktrees/\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')
    await w.create(repo, { path: join(repo, '_worktrees', 'other'), branch: 'other', base: 'main' })
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').match(/\/_worktrees\//g)).toHaveLength(1)
  })

  it('refuses a base that is not a commit or looks like an option', async () => {
    await expect(w.create(repo, { path: join(dir, 'y'), branch: 'feat/y', base: '--detach' })).rejects.toThrow(/not a commit/)
    await expect(w.create(repo, { path: join(dir, 'y'), branch: 'feat/y', base: 'no-such-branch' })).rejects.toThrow(/not a commit/)
    expect(existsSync(join(dir, 'y'))).toBe(false)
  })

  it('reports nothing unpushed in a repository with no remote', async () => {
    const solo = join(dir, 'solo')
    mkdirSync(solo)
    git(solo, 'init', '--quiet', '-b', 'main')
    writeFileSync(join(solo, 'a.txt'), 'a\n')
    git(solo, 'add', '.')
    git(solo, 'commit', '--quiet', '-m', 'init')
    git(solo, 'commit', '--quiet', '--allow-empty', '-m', 'two')
    expect(await w.status(solo)).toEqual({ dirty: false, unpushed: 0, branch: 'main' })
  })

  it('refuses a branch name git does not accept', async () => {
    await expect(w.create(repo, { path: join(dir, 'x'), branch: 'bad..name' })).rejects.toThrow(/not a valid branch name/)
  })
})
