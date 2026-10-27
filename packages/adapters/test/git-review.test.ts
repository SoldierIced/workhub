import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pushBlockEnv } from '@workhub/core'
import { GitReview, parseNumstat, parseStatus, truncateDiff, type GitRunner } from '../src/git-review'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

describe('GitReview on a real repository', () => {
  let dir: string
  let repo: string
  let remote: string
  const g = new GitReview()

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'workhub-git-review-'))
    remote = join(dir, 'remote.git')
    repo = join(dir, 'repo')
    git(dir, 'init', '--quiet', '--bare', '-b', 'main', remote)
    git(dir, 'init', '--quiet', '-b', 'main', repo)
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'init')
    git(repo, 'checkout', '--quiet', '-b', 'develop')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '--quiet', 'origin', 'main', 'develop')
    git(repo, 'checkout', '--quiet', '-b', 'feat/x')
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    git(repo, 'commit', '--quiet', '-am', 'feat: two')
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', 'b.txt')
    git(repo, 'commit', '--quiet', '-m', 'feat: b')
    // A hook that must never run in the review worktree.
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${join(dir, 'hook-ran')}"\n`, { mode: 0o755 })
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('probes branch, HEAD, base ref, commits ahead and dirty files', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'x')
    const p = await g.probe(join(repo), 'develop')
    expect(p).toMatchObject({ branch: 'feat/x', base: 'develop', baseRef: 'origin/develop', ahead: 2, dirty: true, dirtyFiles: ['dirty.txt'] })
    expect(p?.headSha).toMatch(/^[0-9a-f]{40}$/)
    rmSync(join(repo, 'dirty.txt'))
    expect((await g.probe(repo, 'develop'))?.dirty).toBe(false)
  })

  it('falls back to the default branch when the base does not exist, and to null outside a repo', async () => {
    expect(await g.resolveBase(repo, 'nope')).toEqual({ name: 'main', ref: 'main' })
    expect(await g.probe(dir, 'develop')).toBeNull()
  })

  it('reads commits, stat and diff from the merge base', async () => {
    const mb = (await g.mergeBase(repo, 'origin/develop', 'HEAD'))!
    expect(await g.commits(repo, mb, 'HEAD')).toEqual([expect.stringMatching(/ feat: two$/), expect.stringMatching(/ feat: b$/)])
    expect(await g.diffStat(repo, mb, 'HEAD')).toContain('b.txt')
    const d = await g.diff(repo, mb, 'HEAD', 100_000)
    expect(d.truncated).toBe(false)
    expect(d.text).toContain('+two')
    expect(await g.isAncestor(repo, mb, 'HEAD')).toBe(true)
  })

  it('checks the reviewed HEAD out in a separate worktree without running hooks, and removes it', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const first = git(repo, 'rev-parse', 'HEAD~1')
    const wt = join(dir, 'data', 'ai-review', 'wt-1')
    await g.checkout(repo, wt, first)
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(existsSync(join(wt, 'b.txt'))).toBe(false)
    await g.checkout(repo, wt, head)
    expect(existsSync(join(wt, 'b.txt'))).toBe(true)
    expect(existsSync(join(dir, 'hook-ran'))).toBe(false)
    // The dev's own checkout is untouched.
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/x')
    await g.remove(repo, wt)
    expect(existsSync(wt)).toBe(false)
    expect(git(repo, 'worktree', 'list')).not.toContain('wt-1')
  })
})

describe('local changes', () => {
  let dir: string
  const g = new GitReview()

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'workhub-local-changes-'))
    for (const name of ['api', 'web']) {
      const repo = join(dir, name)
      git(dir, 'init', '--quiet', '-b', 'main', repo)
      writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '--quiet', '-m', 'init')
    }
    mkdirSync(join(dir, 'notes'))
    // api: one line changed, one added, an untracked file; web stays clean.
    writeFileSync(join(dir, 'api', 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(dir, 'api', 'new.txt'), 'x\n')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads one repository, even from a folder inside it', async () => {
    const r = await g.localChanges(join(dir, 'api'))
    expect(r).toMatchObject({ nested: false, scanned: 1, repos: [{ name: 'api', branch: 'main', files: 2, additions: 2, deletions: 1 }] })
    expect((await g.localChanges(join(dir, 'web')))?.repos[0]).toMatchObject({ files: 0, additions: 0, deletions: 0 })
  })

  it('sums a folder of repositories, listing only the ones with changes', async () => {
    const r = await g.localChanges(dir)
    expect(r?.nested).toBe(true)
    expect(r?.scanned).toBe(2)
    expect(r?.repos.map((x) => x.name)).toEqual(['api'])
  })

  it('is null for a folder with no repository', async () => {
    expect(await g.localChanges(join(dir, 'notes'))).toBeNull()
  })
})

describe('git-review helpers', () => {
  it('adds up numstat lines and skips binary files', () => {
    expect(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n10\t0\tb.ts\n')).toEqual({ additions: 13, deletions: 1 })
    expect(parseNumstat('')).toEqual({ additions: 0, deletions: 0 })
  })

  it('parses porcelain status with renames', () => {
    expect(parseStatus(' M a.ts\0R  new.ts\0old.ts\0?? c.ts\0')).toEqual(['a.ts', 'new.ts', 'c.ts'])
  })

  it('cuts a diff on a line boundary', () => {
    expect(truncateDiff('aaa\nbbb\nccc', 9)).toEqual({ text: 'aaa\nbbb', truncated: true })
    expect(truncateDiff('short', 9)).toEqual({ text: 'short', truncated: false })
  })
})

describe('refreshBase', () => {
  let dir: string
  let remote: string
  let repo: string
  let other: string
  const g = new GitReview()

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'workhub-git-fetch-'))
    remote = join(dir, 'remote.git')
    repo = join(dir, 'repo')
    other = join(dir, 'other')
    git(dir, 'init', '--quiet', '--bare', '-b', 'main', remote)
    git(dir, 'clone', '--quiet', remote, repo)
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'init')
    git(repo, 'push', '--quiet', 'origin', 'HEAD:refs/heads/develop')
    git(repo, 'fetch', '--quiet', 'origin')
    git(dir, 'clone', '--quiet', remote, other)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('brings the remote base up to date without touching the working tree', async () => {
    const before = git(repo, 'rev-parse', 'origin/develop')
    git(other, 'checkout', '--quiet', '-B', 'develop', 'origin/develop')
    writeFileSync(join(other, 'b.txt'), 'b\n')
    git(other, 'add', '.')
    git(other, 'commit', '--quiet', '-m', 'team commit')
    git(other, 'push', '--quiet', 'origin', 'develop')
    const head = git(repo, 'rev-parse', 'HEAD')
    expect(await g.refreshBase(repo, 'develop')).toEqual({ ok: true, remote: 'origin' })
    const after = git(repo, 'rev-parse', 'origin/develop')
    expect(after).not.toBe(before)
    expect(after).toBe(git(other, 'rev-parse', 'HEAD'))
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('reports why the base was not refreshed and leaves the local ref alone', async () => {
    const ref = git(repo, 'rev-parse', 'origin/develop')
    const missing = await g.refreshBase(repo, 'no-such-branch')
    expect(missing.ok).toBe(false)
    expect(missing).toMatchObject({ reason: expect.stringContaining('no-such-branch') })
    git(repo, 'remote', 'set-url', 'origin', join(dir, 'gone.git'))
    const offline = await g.refreshBase(repo, 'develop')
    expect(offline.ok).toBe(false)
    git(repo, 'remote', 'set-url', 'origin', remote)
    expect(git(repo, 'rev-parse', 'origin/develop')).toBe(ref)
  })

  it('has nothing to fetch from without a remote, and names a timeout', async () => {
    const lone = join(dir, 'lone')
    git(dir, 'init', '--quiet', '-b', 'main', lone)
    expect(await g.refreshBase(lone, 'develop')).toEqual({ ok: false, reason: 'the repository has no remote' })
    const slow: GitRunner = async (_cwd, args) => (args[0] === 'remote' ? { ok: true, stdout: 'origin\n', stderr: '' } : { ok: false, stdout: '', stderr: '', timedOut: true })
    expect(await new GitReview(slow).refreshBase(repo, 'develop', 30_000)).toEqual({ ok: false, reason: 'git fetch timed out after 30 s' })
  })
})

describe('a review worktree cannot push', () => {
  let dir: string
  let remote: string
  let repo: string
  const g = new GitReview()
  const gitIn = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' } })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'workhub-git-push-'))
    remote = join(dir, 'remote.git')
    repo = join(dir, 'repo')
    git(dir, 'init', '--quiet', '--bare', '-b', 'main', remote)
    git(dir, 'init', '--quiet', '-b', 'main', repo)
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'init')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'remote', 'add', 'upstream', remote)
    git(repo, 'push', '--quiet', 'origin', 'main')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('fails to push by remote name or by URL with the review environment, while the dev still pushes and the config stays the same', async () => {
    const configBefore = readFileSync(join(repo, '.git', 'config'), 'utf8')
    const review = join(dir, 'review')
    await g.checkout(repo, review, git(repo, 'rev-parse', 'HEAD'))
    const env = pushBlockEnv(await g.remotes(repo))
    expect(env['GIT_CONFIG_COUNT']).toBe('3')

    for (const target of ['origin', 'upstream', remote]) {
      const r = gitIn(review, env, 'push', target, 'HEAD:refs/heads/from-review')
      expect(r.status, target).not.toBe(0)
      expect(r.stderr).toContain('no-push')
    }
    expect(git(repo, 'ls-remote', '--heads', remote)).not.toContain('from-review')

    // Without the environment (the dev's own shell) nothing changed.
    const dev = gitIn(repo, {}, 'push', 'origin', 'HEAD:refs/heads/from-dev')
    expect(dev.status).toBe(0)
    expect(git(repo, 'ls-remote', '--heads', remote)).toContain('from-dev')

    // Reading from the remote still works in the review environment.
    expect(gitIn(review, env, 'fetch', 'origin').status).toBe(0)

    await g.remove(repo, review)
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe(configBefore)
    expect(existsSync(review)).toBe(false)
  })

  it('keeps the config entries the session already inherits', () => {
    const env = pushBlockEnv(['origin'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' })
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_1: 'remote.origin.pushurl', GIT_CONFIG_KEY_2: 'url.no-push://workhub-review/.pushInsteadOf', GIT_CONFIG_VALUE_2: '' })
    expect(env['GIT_CONFIG_KEY_0']).toBeUndefined()
  })
})
