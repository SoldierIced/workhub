import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { limitHunks, LocalChanges } from '../src/git-review'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

describe('LocalChanges on real repositories', () => {
  let dir: string
  let repo: string
  let folder: string
  const changes = new LocalChanges()

  beforeAll(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'workhub-local-review-')))
    repo = join(dir, 'app')
    git(dir, 'init', '--quiet', '-b', 'main', repo)
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(repo, 'gone.txt'), 'bye\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'init')
    git(repo, 'checkout', '--quiet', '-b', 'feat/x')
    writeFileSync(join(repo, 'a.txt'), 'one\n2\nthree\n')
    git(repo, 'commit', '--quiet', '-am', 'feat: two')
    // Uncommitted: a deletion, a new text file and a new binary file.
    rmSync(join(repo, 'gone.txt'))
    writeFileSync(join(repo, 'new.txt'), 'n1\nn2\n')
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]))

    // A folder holding repos: one with changes, one clean and old.
    folder = join(dir, 'workspace')
    mkdirSync(folder)
    const dirty = join(folder, 'svc-a')
    const clean = join(folder, 'svc-b')
    for (const r of [dirty, clean]) {
      git(folder, 'init', '--quiet', '-b', 'main', r)
      writeFileSync(join(r, 'x.txt'), 'x\n')
      git(r, 'add', '.')
      git(r, 'commit', '--quiet', '-m', 'init')
    }
    writeFileSync(join(dirty, 'x.txt'), 'y\n')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('compares the branch with its base, uncommitted and untracked files included', async () => {
    const review = await changes.load({ folder: repo, scope: 'branch' })
    expect(review.scannedRepos).toBe(1)
    const [r] = review.repos
    expect(r).toMatchObject({ root: repo, name: 'app', branch: 'feat/x', base: 'main' })
    expect(r!.files.map((f) => [f.path, f.status, f.untracked])).toEqual([
      ['a.txt', 'modified', false],
      ['bin.dat', 'added', true],
      ['gone.txt', 'deleted', false],
      ['new.txt', 'added', true]
    ])
    const a = r!.files.find((f) => f.path === 'a.txt')!
    expect(a).toMatchObject({ additions: 1, deletions: 1 })
    expect(a.hunks[0]!.lines.find((l) => l.kind === 'added')).toEqual({ kind: 'added', newNumber: 2, text: '2' })
    expect(r!.files.find((f) => f.path === 'bin.dat')).toMatchObject({ binary: true, note: 'binary' })
    expect(r!.files.find((f) => f.path === 'new.txt')).toMatchObject({ additions: 2, hunks: [{ header: '@@ -0,0 +1,2 @@' }] })
  })

  it('shows only what is not committed in the uncommitted scope', async () => {
    const review = await changes.load({ folder: repo, scope: 'uncommitted' })
    const r = review.repos[0]!
    expect(r.base).toBeUndefined()
    expect(r.files.map((f) => f.path)).toEqual(['bin.dat', 'gone.txt', 'new.txt'])
  })

  it('prefers the pull request base and links the pull request', async () => {
    git(repo, 'branch', '--quiet', 'develop', 'main')
    const review = await changes.load({ folder: repo, scope: 'branch', pullRequestOf: ({ branch }) => (branch === 'feat/x' ? { number: 7, url: 'https://github.com/a/app/pull/7', base: 'develop' } : undefined) })
    expect(review.repos[0]).toMatchObject({ base: 'develop', pullRequest: { number: 7 }, webUrl: 'https://github.com/a/app/pull/7' })
  })

  it('takes the repos inside a folder that the session touched', async () => {
    const review = await changes.load({ folder, scope: 'branch', since: Date.now() + 60_000 })
    expect(review.scannedRepos).toBe(2)
    expect(review.repos.map((r) => r.name)).toEqual(['svc-a'])
    // A commit made since the session started counts too.
    const all = await changes.load({ folder, scope: 'uncommitted', since: 0 })
    expect(all.repos.map((r) => r.name)).toEqual(['svc-a'])
  })

  it('reviews only the repos asked for by path, outside the folder, with the base they name', async () => {
    const review = await changes.load({ folder, scope: 'branch', since: Date.now() + 60_000, extraRepos: [{ path: join(repo, 'src-missing', '..'), base: 'origin/main' }] })
    // svc-a has changes in the folder, but the request names only app: the folder is not scanned.
    expect(review.repos.map((r) => r.name)).toEqual(['app'])
    expect(review.scannedRepos).toBe(1)
    expect(review.repos.find((r) => r.name === 'app')).toMatchObject({ root: repo, base: 'main' })
  })

  it('reports a folder with no repository', async () => {
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    expect(await changes.load({ folder: empty, scope: 'branch' })).toMatchObject({ repos: [], scannedRepos: 0 })
  })

  it('keeps the first lines of a long diff and counts the rest', () => {
    const lines = Array.from({ length: 5 }, (_, i) => ({ kind: 'added' as const, newNumber: i + 1, text: String(i) }))
    const r = limitHunks([{ header: 'h1', lines }, { header: 'h2', lines }], 7)
    expect(r.hunks.map((h) => h.lines.length)).toEqual([5, 2])
    expect(r.hidden).toBe(3)
  })
})
