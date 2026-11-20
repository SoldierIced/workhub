import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalChanges } from '../src/git-review'

const OLD = new Date('2020-01-01T00:00:00Z')
const SINCE = new Date('2024-01-01T00:00:00Z').getTime()
const NEW = new Date('2024-06-01T00:00:00Z')

function git(cwd: string, date: Date, ...args: string[]): string {
  const stamp = date.toISOString()
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
  }).trim()
}

/** A repo with one old commit of `x.txt` (and its file time set old). */
function makeRepo(folder: string, name: string): string {
  const repo = join(folder, name)
  git(folder, OLD, 'init', '--quiet', '-b', 'main', repo)
  writeFileSync(join(repo, 'x.txt'), 'x\n')
  writeFileSync(join(repo, 'y.txt'), 'y\n')
  git(repo, OLD, 'add', '.')
  git(repo, OLD, 'commit', '--quiet', '-m', 'init')
  utimesSync(join(repo, 'x.txt'), OLD, OLD)
  utimesSync(join(repo, 'y.txt'), OLD, OLD)
  utimesSync(repo, OLD, OLD)
  return repo
}

/** An uncommitted edit of `x.txt` whose file time is `when`. */
function edit(repo: string, when: Date, file = 'x.txt'): void {
  writeFileSync(join(repo, file), 'changed\n')
  utimesSync(join(repo, file), when, when)
}

describe('LocalChanges: the session repos of a folder', () => {
  let dir: string
  let folder: string
  const changes = new LocalChanges()
  const names = (r: { repos: { name: string }[] }) => r.repos.map((x) => x.name)

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'workhub-local-split-')))
    folder = join(dir, 'workspace')
    mkdirSync(folder)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('without the new fields and without since, lists every repo with changes', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    makeRepo(folder, 'clean')
    edit(a, OLD)
    edit(b, OLD)
    const review = await changes.load({ folder, scope: 'uncommitted' })
    expect(names(review)).toEqual(['a', 'b'])
    expect(review.untouched).toBeUndefined()
    expect(review.scannedRepos).toBe(3)
  })

  it('with since only and everything recent, nothing changes either', async () => {
    const a = makeRepo(folder, 'a')
    edit(a, NEW)
    const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE })
    expect(names(review)).toEqual(['a'])
    expect(review.untouched).toBeUndefined()
  })

  it('splits by touched paths: the others go to untouched with their counts', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, NEW)
    edit(b, NEW)
    writeFileSync(join(b, 'new.txt'), '1\n2\n3\n')
    const review = await changes.load({ folder, scope: 'uncommitted', touched: [join(a, 'x.txt')], since: SINCE })
    expect(names(review)).toEqual(['a'])
    expect(review.untouched).toEqual([{ name: 'b', root: b, files: 2, additions: 4, deletions: 1 }])
  })

  it('resolves symlinks on both sides', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, NEW)
    edit(b, NEW)
    const link = join(dir, 'link')
    symlinkSync(folder, link)
    const review = await changes.load({ folder, scope: 'uncommitted', touched: [join(link, 'b', 'x.txt')] })
    expect(names(review)).toEqual(['b'])
    expect(review.untouched?.map((o) => o.name)).toEqual(['a'])
  })

  it('touched wins over time: an old edit in a touched repo stays, a recent one elsewhere is untouched', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, OLD)
    edit(b, NEW)
    const review = await changes.load({ folder, scope: 'uncommitted', touched: [join(a, 'x.txt')], since: SINCE })
    expect(names(review)).toEqual(['a'])
    expect(review.untouched?.map((o) => o.name)).toEqual(['b'])
  })

  it('touched with entries and none in a child: no child is the session\'s, except on Windows', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, OLD)
    edit(b, NEW)
    const worktree = join(dir, 'worktree', 'file.ts')
    const other = await changes.load({ folder, scope: 'uncommitted', touched: [worktree], since: SINCE, platform: 'darwin' })
    expect(names(other)).toEqual([])
    expect(other.untouched?.map((o) => o.name)).toEqual(['a', 'b'])
    const win = await changes.load({ folder, scope: 'uncommitted', touched: ['/c/x/app/file.ts'], since: SINCE, platform: 'win32' })
    expect(names(win)).toEqual(['b'])
    expect(win.untouched?.map((o) => o.name)).toEqual(['a'])
  })

  it('touched with no entries falls back to time on every platform', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, OLD)
    edit(b, NEW)
    for (const platform of ['darwin', 'win32'] as const) {
      const review = await changes.load({ folder, scope: 'uncommitted', touched: [], since: SINCE, platform })
      expect(names(review)).toEqual(['b'])
      expect(review.untouched?.map((o) => o.name)).toEqual(['a'])
    }
  })

  it('with unmatched touched paths on Windows and no since, every child is the session\'s', async () => {
    const a = makeRepo(folder, 'a')
    edit(a, OLD)
    const review = await changes.load({ folder, scope: 'uncommitted', touched: ['/c/x/app/file.ts'], platform: 'win32' })
    expect(names(review)).toEqual(['a'])
    expect(review.untouched).toBeUndefined()
  })

  describe('the time rule', () => {
    it('an old uncommitted change is untouched, one modified after since is the session\'s', async () => {
      const old = makeRepo(folder, 'old')
      const fresh = makeRepo(folder, 'fresh')
      edit(old, OLD)
      edit(fresh, NEW)
      const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE })
      expect(names(review)).toEqual(['fresh'])
      expect(review.untouched).toEqual([{ name: 'old', root: old, files: 1, additions: 1, deletions: 1 }])
    })

    it('a deleted file counts by the nearest folder that still exists', async () => {
      const gone = makeRepo(folder, 'gone')
      const quiet = makeRepo(folder, 'quiet')
      rmSync(join(gone, 'x.txt'))
      utimesSync(gone, NEW, NEW)
      rmSync(join(quiet, 'x.txt'))
      utimesSync(quiet, OLD, OLD)
      const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE })
      expect(names(review)).toEqual(['gone'])
      expect(review.untouched?.map((o) => o.name)).toEqual(['quiet'])
    })

    it('an untracked folder counts by the newest of it and its direct entries', async () => {
      const a = makeRepo(folder, 'a')
      const b = makeRepo(folder, 'b')
      for (const [repo, when] of [[a, NEW], [b, OLD]] as const) {
        mkdirSync(join(repo, 'dir'))
        writeFileSync(join(repo, 'dir', 'f.txt'), 'f\n')
        utimesSync(join(repo, 'dir', 'f.txt'), when, when)
        utimesSync(join(repo, 'dir'), OLD, OLD)
        utimesSync(repo, OLD, OLD)
      }
      const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE })
      expect(names(review)).toEqual(['a'])
      expect(review.untouched?.map((o) => o.name)).toEqual(['b'])
    })

    it('a commit after since makes the repo the session\'s', async () => {
      const committed = makeRepo(folder, 'committed')
      const other = makeRepo(folder, 'other')
      edit(other, OLD)
      edit(committed, OLD)
      git(committed, NEW, 'commit', '--quiet', '-am', 'later')
      edit(committed, OLD, 'y.txt')
      const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE })
      expect(names(review)).toEqual(['committed'])
      expect(review.untouched?.map((o) => o.name)).toEqual(['other'])
    })

    it('a name with a space is read right', async () => {
      const spaced = makeRepo(folder, 'my app')
      const other = makeRepo(folder, 'other')
      writeFileSync(join(spaced, 'a file.txt'), 'n\n')
      utimesSync(join(spaced, 'a file.txt'), NEW, NEW)
      edit(other, OLD)
      const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE })
      expect(names(review)).toEqual(['my app'])
      expect(review.untouched?.map((o) => o.name)).toEqual(['other'])
    })

    it('a renamed file is read by its new path', async () => {
      const moved = makeRepo(folder, 'moved')
      git(moved, OLD, 'mv', 'x.txt', 'renamed x.txt')
      utimesSync(join(moved, 'renamed x.txt'), NEW, NEW)
      const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE })
      expect(names(review)).toEqual(['moved'])
    })
  })

  it('alsoRepos always load, even outside the folder and when nothing traces them to the session', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, NEW)
    edit(b, OLD)
    const outside = join(dir, 'elsewhere')
    mkdirSync(outside)
    const out = makeRepo(outside, 'out')
    edit(out, OLD)
    const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE, alsoRepos: [b, out] })
    expect(names(review).sort()).toEqual(['a', 'b', 'out'])
    expect(review.untouched).toBeUndefined()
  })

  it('alsoRepos join extraRepos that resolve, which still replace the scan', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    const c = makeRepo(folder, 'c')
    edit(a, NEW)
    edit(b, NEW)
    edit(c, NEW)
    const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE, extraRepos: [{ path: a }], alsoRepos: [b] })
    expect(names(review)).toEqual(['a', 'b'])
    expect(review.untouched).toBeUndefined()
  })

  it('extraRepos that resolve to nothing mean a normal scan with the split', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, NEW)
    edit(b, OLD)
    const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE, extraRepos: [{ path: join(dir, 'missing') }] })
    expect(names(review)).toEqual(['a'])
    expect(review.untouched?.map((o) => o.name)).toEqual(['b'])
  })

  it('wholeFolder lists every repo with changes, no split', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, NEW)
    edit(b, OLD)
    const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE, touched: [join(a, 'x.txt')], wholeFolder: true })
    expect(names(review)).toEqual(['a', 'b'])
    expect(review.untouched).toBeUndefined()
    expect(review.wholeFolder).toBe(true)
  })

  it('extraRepos that resolve to nothing plus wholeFolder scan without the split and say so', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, NEW)
    edit(b, OLD)
    const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE, touched: [join(a, 'x.txt')], extraRepos: [{ path: join(dir, 'missing') }], wholeFolder: true })
    expect(names(review)).toEqual(['a', 'b'])
    expect(review.untouched).toBeUndefined()
    expect(review.wholeFolder).toBe(true)
  })

  it('extraRepos that resolve plus wholeFolder: no scan ran, so it does not say so', async () => {
    const a = makeRepo(folder, 'a')
    const b = makeRepo(folder, 'b')
    edit(a, NEW)
    edit(b, NEW)
    const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE, extraRepos: [{ path: a }], wholeFolder: true })
    expect(names(review)).toEqual(['a'])
    expect(review.wholeFolder).toBeUndefined()
  })

  it('without wholeFolder the result does not carry it', async () => {
    const a = makeRepo(folder, 'a')
    edit(a, NEW)
    const review = await changes.load({ folder, scope: 'uncommitted', since: SINCE })
    expect(review.wholeFolder).toBeUndefined()
  })

  it('the folder\'s own repository always goes to repos', async () => {
    const own = makeRepo(dir, 'workspace-own')
    const child = makeRepo(own, 'child')
    edit(own, OLD)
    edit(child, OLD)
    const review = await changes.load({ folder: own, scope: 'uncommitted', since: SINCE })
    expect(review.repos[0]).toMatchObject({ name: 'workspace-own' })
    expect(review.untouched?.map((o) => o.name)).toEqual(['child'])
  })
})
