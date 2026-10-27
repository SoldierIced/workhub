import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitReview, parseStatus, truncateDiff } from '../src/git-review'

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

describe('git-review helpers', () => {
  it('parses porcelain status with renames', () => {
    expect(parseStatus(' M a.ts\0R  new.ts\0old.ts\0?? c.ts\0')).toEqual(['a.ts', 'new.ts', 'c.ts'])
  })

  it('cuts a diff on a line boundary', () => {
    expect(truncateDiff('aaa\nbbb\nccc', 9)).toEqual({ text: 'aaa\nbbb', truncated: true })
    expect(truncateDiff('short', 9)).toEqual({ text: 'short', truncated: false })
  })
})
