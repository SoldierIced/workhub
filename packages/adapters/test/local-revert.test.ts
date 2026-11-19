import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { LocalReviewFile, LocalRevertTarget } from '@workhub/core'
import { LocalChanges, LocalReverter } from '../src/git-review'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).replace(/\n$/, '')
const read = (path: string) => readFileSync(path, 'utf8')
const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('')

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'workhub-local-revert-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let repo: string
let trashDir: string
let trashed: string[]
const reverter = new LocalReverter({
  trash: async (full) => {
    trashed.push(full)
    renameSync(full, join(trashDir, `${trashed.length}-${basename(full)}`))
  }
})

/** A fresh repository with `files` committed. */
function makeRepo(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(base, 'repo-'))
  git(dir, 'init', '--quiet', '-b', 'main')
  git(dir, 'config', 'core.autocrlf', 'false')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'init')
  return dir
}

/** The file as the review window shows it in the uncommitted scope. */
async function shown(path: string): Promise<LocalReviewFile> {
  const review = await new LocalChanges().load({ folder: repo, scope: 'uncommitted' })
  const file = review.repos[0]?.files.find((f) => f.path === path)
  if (!file) throw new Error(`${path} is not in the review`)
  return file
}

async function revert(path: string, target: LocalRevertTarget, digest?: string) {
  const file = await shown(path)
  return reverter.revert({ root: repo, path, target, digest: digest ?? file.digest! })
}

/** Line indexes of the shown hunk whose text matches. */
function indexesOf(file: LocalReviewFile, hunk: number, pick: (line: { kind: string; text: string }) => boolean): number[] {
  return file.hunks[hunk]!.lines.flatMap((l, i) => (pick(l) ? [i] : []))
}

const status = () => git(repo, 'status', '--porcelain=v1', '--untracked-files=all')

beforeEach(() => {
  trashed = []
  trashDir = mkdtempSync(join(base, 'trash-'))
})

describe('LocalReverter on real repositories', () => {
  it('gives every uncommitted file a digest, and none in the branch scope', async () => {
    repo = makeRepo({ 'a.txt': 'a\n' })
    writeFileSync(join(repo, 'a.txt'), 'b\n')
    writeFileSync(join(repo, 'new.txt'), 'n\n')
    const uncommitted = await new LocalChanges().load({ folder: repo, scope: 'uncommitted' })
    expect(uncommitted.repos[0]!.files.every((f) => /^[0-9a-f]{64}$/.test(f.digest ?? ''))).toBe(true)
    const branch = await new LocalChanges().load({ folder: repo, scope: 'branch' })
    expect(branch.repos[0]!.files.map((f) => f.digest)).toEqual([undefined, undefined])
  })

  it('reverts a whole modified file, staged and unstaged changes included', async () => {
    repo = makeRepo({ 'a.txt': lines(5) })
    writeFileSync(join(repo, 'a.txt'), 'staged\n' + lines(5))
    git(repo, 'add', 'a.txt')
    writeFileSync(join(repo, 'a.txt'), 'staged\n' + lines(5) + 'unstaged\n')
    expect(await revert('a.txt', { kind: 'file' })).toEqual({ ok: true })
    expect(read(join(repo, 'a.txt'))).toBe(lines(5))
    expect(status()).toBe('')
  })

  it('reverts one hunk and leaves the others', async () => {
    repo = makeRepo({ 'a.txt': lines(30) })
    writeFileSync(join(repo, 'a.txt'), lines(30).replace('line 2\n', 'TWO\n').replace('line 28\n', 'TWENTY-EIGHT\n'))
    const file = await shown('a.txt')
    expect(file.hunks).toHaveLength(2)
    expect(await revert('a.txt', { kind: 'hunk', hunk: 1 })).toEqual({ ok: true })
    expect(read(join(repo, 'a.txt'))).toBe(lines(30).replace('line 2\n', 'TWO\n'))
  })

  it('reverts only the selected lines of a hunk', async () => {
    repo = makeRepo({ 'a.txt': lines(6) })
    // One hunk: line 3 replaced, two lines added after line 4.
    writeFileSync(join(repo, 'a.txt'), lines(6).replace('line 3\n', 'THREE\n').replace('line 4\n', 'line 4\nadd 1\nadd 2\n'))
    const file = await shown('a.txt')
    expect(file.hunks).toHaveLength(1)
    // Undo "add 1" and the replacement of line 3 (its removed and added lines); keep "add 2".
    const picked = indexesOf(file, 0, (l) => l.text === 'add 1' || (l.kind !== 'context' && /line 3|THREE/.test(l.text)))
    expect(picked).toHaveLength(3)
    expect(await revert('a.txt', { kind: 'lines', hunk: 0, lines: picked })).toEqual({ ok: true })
    expect(read(join(repo, 'a.txt'))).toBe(lines(6).replace('line 4\n', 'line 4\nadd 2\n'))
  })

  it('restores a removed line alone, leaving the line that replaced it', async () => {
    repo = makeRepo({ 'a.txt': lines(3) })
    writeFileSync(join(repo, 'a.txt'), lines(3).replace('line 2\n', 'TWO\n'))
    const file = await shown('a.txt')
    const removed = indexesOf(file, 0, (l) => l.kind === 'removed')
    expect(await revert('a.txt', { kind: 'lines', hunk: 0, lines: removed })).toEqual({ ok: true })
    expect(read(join(repo, 'a.txt'))).toBe('line 1\nline 2\nTWO\nline 3\n')
  })

  it('refuses with `changed` when the file changed since it was shown, and changes nothing', async () => {
    repo = makeRepo({ 'a.txt': lines(3) })
    writeFileSync(join(repo, 'a.txt'), lines(3) + 'agent 1\n')
    const before = await shown('a.txt')
    // The agent keeps writing after the window loaded.
    writeFileSync(join(repo, 'a.txt'), lines(3) + 'agent 1\nagent 2\n')
    expect(await reverter.revert({ root: repo, path: 'a.txt', target: { kind: 'hunk', hunk: 0 }, digest: before.digest! })).toEqual({ ok: false, error: 'changed' })
    expect(await reverter.revert({ root: repo, path: 'a.txt', target: { kind: 'file' }, digest: before.digest! })).toEqual({ ok: false, error: 'changed' })
    expect(read(join(repo, 'a.txt'))).toBe(lines(3) + 'agent 1\nagent 2\n')
    // Gone from the diff (someone reverted it already): changed too.
    git(repo, 'checkout', '--', 'a.txt')
    expect(await reverter.revert({ root: repo, path: 'a.txt', target: { kind: 'file' }, digest: before.digest! })).toEqual({ ok: false, error: 'changed' })
  })

  it('refuses a hunk index or line that is not there', async () => {
    repo = makeRepo({ 'a.txt': lines(3) })
    writeFileSync(join(repo, 'a.txt'), lines(3) + 'x\n')
    const file = await shown('a.txt')
    expect(await revert('a.txt', { kind: 'hunk', hunk: 5 })).toMatchObject({ ok: false, error: 'changed' })
    // A context line is not a change.
    const context = indexesOf(file, 0, (l) => l.kind === 'context')
    expect(await revert('a.txt', { kind: 'lines', hunk: 0, lines: context })).toMatchObject({ ok: false })
    expect(await revert('a.txt', { kind: 'lines', hunk: 0, lines: [999_999] })).toMatchObject({ ok: false, error: 'hidden' })
    expect(read(join(repo, 'a.txt'))).toBe(lines(3) + 'x\n')
  })

  it('reverts a rename: the new path goes to the trash and the old one comes back', async () => {
    repo = makeRepo({ 'old.txt': lines(20) })
    git(repo, 'mv', 'old.txt', 'new.txt')
    writeFileSync(join(repo, 'new.txt'), lines(20) + 'more\n')
    const file = await shown('new.txt')
    expect(file).toMatchObject({ status: 'renamed', oldPath: 'old.txt' })
    expect(await revert('new.txt', { kind: 'file' })).toEqual({ ok: true })
    expect(read(join(repo, 'old.txt'))).toBe(lines(20))
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect(trashed).toEqual([join(repo, 'new.txt')])
    expect(status()).toBe('')
  })

  it('reverts a hunk of a renamed file and keeps the rename', async () => {
    repo = makeRepo({ 'old.txt': lines(20) })
    git(repo, 'mv', 'old.txt', 'new.txt')
    writeFileSync(join(repo, 'new.txt'), lines(20) + 'more\n')
    expect(await revert('new.txt', { kind: 'hunk', hunk: 0 })).toEqual({ ok: true })
    expect(read(join(repo, 'new.txt'))).toBe(lines(20))
    expect(existsSync(join(repo, 'old.txt'))).toBe(false)
    expect(status()).toBe('R  old.txt -> new.txt')
  })

  it('moves an untracked file to the trash, and reverts no hunk of it', async () => {
    repo = makeRepo({ 'a.txt': 'a\n' })
    writeFileSync(join(repo, 'note.md'), 'draft\n')
    expect(await revert('note.md', { kind: 'hunk', hunk: 0 })).toEqual({ ok: false, error: 'unsupported' })
    const file = await shown('note.md')
    writeFileSync(join(repo, 'note.md'), 'draft, edited\n')
    expect(await reverter.revert({ root: repo, path: 'note.md', target: { kind: 'file' }, digest: file.digest! })).toEqual({ ok: false, error: 'changed' })
    expect(await revert('note.md', { kind: 'file' })).toEqual({ ok: true })
    expect(existsSync(join(repo, 'note.md'))).toBe(false)
    expect(trashed).toEqual([join(repo, 'note.md')])
    expect(read(join(trashDir, '1-note.md'))).toBe('draft, edited\n')
  })

  it('reports a trash that fails and keeps the file', async () => {
    repo = makeRepo({ 'a.txt': 'a\n' })
    writeFileSync(join(repo, 'note.md'), 'draft\n')
    const file = await shown('note.md')
    const broken = new LocalReverter({ trash: async () => Promise.reject(new Error('no trash here')) })
    expect(await broken.revert({ root: repo, path: 'note.md', target: { kind: 'file' }, digest: file.digest! })).toEqual({ ok: false, error: 'failed', detail: 'no trash here' })
    expect(existsSync(join(repo, 'note.md'))).toBe(true)
  })

  it('reverts a new staged file to the trash and out of the index', async () => {
    repo = makeRepo({ 'a.txt': 'a\n' })
    writeFileSync(join(repo, 'added.txt'), 'n1\nn2\n')
    git(repo, 'add', 'added.txt')
    expect(await revert('added.txt', { kind: 'file' })).toEqual({ ok: true })
    expect(existsSync(join(repo, 'added.txt'))).toBe(false)
    expect(trashed).toHaveLength(1)
    expect(status()).toBe('')
  })

  it('reverts some lines of a new staged file in the working tree and the index', async () => {
    repo = makeRepo({ 'a.txt': 'a\n' })
    writeFileSync(join(repo, 'added.txt'), 'n1\nn2\nn3\n')
    git(repo, 'add', 'added.txt')
    const file = await shown('added.txt')
    expect(await revert('added.txt', { kind: 'lines', hunk: 0, lines: indexesOf(file, 0, (l) => l.text === 'n2') })).toEqual({ ok: true })
    expect(read(join(repo, 'added.txt'))).toBe('n1\nn3\n')
    expect(git(repo, 'show', ':added.txt')).toBe('n1\nn3')
    expect(status()).toBe('A  added.txt')
  })

  it('restores a deleted file and a binary file, and reverts no hunk of either', async () => {
    repo = makeRepo({ 'gone.txt': 'bye\n', 'img.bin': Buffer.from([0, 1, 2, 3]) })
    rmSync(join(repo, 'gone.txt'))
    writeFileSync(join(repo, 'img.bin'), Buffer.from([0, 9, 9, 9, 9]))
    expect(await revert('gone.txt', { kind: 'hunk', hunk: 0 })).toEqual({ ok: false, error: 'unsupported' })
    expect(await revert('img.bin', { kind: 'hunk', hunk: 0 })).toEqual({ ok: false, error: 'unsupported' })
    expect(await revert('gone.txt', { kind: 'file' })).toEqual({ ok: true })
    expect(await revert('img.bin', { kind: 'file' })).toEqual({ ok: true })
    expect(read(join(repo, 'gone.txt'))).toBe('bye\n')
    expect([...readFileSync(join(repo, 'img.bin'))]).toEqual([0, 1, 2, 3])
    expect(status()).toBe('')
  })

  it.skipIf(process.platform === 'win32')('restores a mode change', async () => {
    repo = makeRepo({ 'run.sh': 'echo hi\n' })
    chmodSync(join(repo, 'run.sh'), 0o755)
    expect(await revert('run.sh', { kind: 'file' })).toEqual({ ok: true })
    expect(statSync(join(repo, 'run.sh')).mode & 0o111).toBe(0)
  })

  it('reverts a hunk of a file staged whole, in the index too', async () => {
    repo = makeRepo({ 'a.txt': lines(30) })
    writeFileSync(join(repo, 'a.txt'), lines(30).replace('line 2\n', 'TWO\n').replace('line 28\n', 'TWENTY-EIGHT\n'))
    git(repo, 'add', 'a.txt')
    expect(await revert('a.txt', { kind: 'hunk', hunk: 0 })).toEqual({ ok: true })
    const expected = lines(30).replace('line 28\n', 'TWENTY-EIGHT\n')
    expect(read(join(repo, 'a.txt'))).toBe(expected)
    expect(git(repo, 'show', ':a.txt') + '\n').toBe(expected)
    expect(status()).toBe('M  a.txt')
  })

  it('with staged and unstaged changes: reverts an unstaged hunk in the working tree only and a staged one in both', async () => {
    repo = makeRepo({ 'a.txt': lines(30) })
    writeFileSync(join(repo, 'a.txt'), lines(30).replace('line 2\n', 'TWO\n'))
    git(repo, 'add', 'a.txt')
    writeFileSync(join(repo, 'a.txt'), lines(30).replace('line 2\n', 'TWO\n').replace('line 28\n', 'TWENTY-EIGHT\n'))
    // Hunk 1 (line 28) is only in the working tree.
    expect(await revert('a.txt', { kind: 'hunk', hunk: 1 })).toEqual({ ok: true })
    expect(read(join(repo, 'a.txt'))).toBe(lines(30).replace('line 2\n', 'TWO\n'))
    expect(status()).toBe('M  a.txt')
    // Hunk 0 (line 2) is staged too: it leaves both.
    writeFileSync(join(repo, 'a.txt'), lines(30).replace('line 2\n', 'TWO\n').replace('line 28\n', 'TWENTY-EIGHT\n'))
    expect(await revert('a.txt', { kind: 'hunk', hunk: 0 })).toEqual({ ok: true })
    expect(read(join(repo, 'a.txt'))).toBe(lines(30).replace('line 28\n', 'TWENTY-EIGHT\n'))
    expect(git(repo, 'show', ':a.txt') + '\n').toBe(lines(30))
    expect(status()).toBe(' M a.txt')
  })

  it('refuses a hunk whose lines differ between the index and the working tree', async () => {
    repo = makeRepo({ 'a.txt': lines(5) })
    writeFileSync(join(repo, 'a.txt'), lines(5).replace('line 3\n', 'staged three\n'))
    git(repo, 'add', 'a.txt')
    writeFileSync(join(repo, 'a.txt'), lines(5).replace('line 3\n', 'worktree three\n'))
    expect(await revert('a.txt', { kind: 'hunk', hunk: 0 })).toEqual({ ok: false, error: 'staged' })
    expect(read(join(repo, 'a.txt'))).toBe(lines(5).replace('line 3\n', 'worktree three\n'))
    // The whole file still reverts.
    expect(await revert('a.txt', { kind: 'file' })).toEqual({ ok: true })
    expect(status()).toBe('')
  })

  it('keeps carriage returns of a CRLF file', async () => {
    repo = makeRepo({ 'win.txt': 'one\r\ntwo\r\nthree\r\n' })
    writeFileSync(join(repo, 'win.txt'), 'one\r\nTWO\r\nthree\r\nfour\r\n')
    const file = await shown('win.txt')
    expect(await revert('win.txt', { kind: 'lines', hunk: 0, lines: indexesOf(file, 0, (l) => l.text === 'four') })).toEqual({ ok: true })
    expect(read(join(repo, 'win.txt'))).toBe('one\r\nTWO\r\nthree\r\n')
    expect(await revert('win.txt', { kind: 'hunk', hunk: 0 })).toEqual({ ok: true })
    expect(read(join(repo, 'win.txt'))).toBe('one\r\ntwo\r\nthree\r\n')
  })

  it('handles a file without a newline at its end', async () => {
    repo = makeRepo({ 'a.txt': 'one\ntwo' })
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree')
    expect(await revert('a.txt', { kind: 'hunk', hunk: 0 })).toEqual({ ok: true })
    expect(read(join(repo, 'a.txt'))).toBe('one\ntwo')
    // Lines added after a last line without a newline: undo one of two.
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour')
    const file = await shown('a.txt')
    expect(await revert('a.txt', { kind: 'lines', hunk: 0, lines: indexesOf(file, 0, (l) => l.text === 'three') })).toEqual({ ok: true })
    expect(read(join(repo, 'a.txt'))).toBe('one\ntwo\nfour')
  })

  it('refuses a hunk cut by the line limit, but reverts its shown lines and the whole file', async () => {
    repo = makeRepo({ 'big.txt': '' })
    writeFileSync(join(repo, 'big.txt'), lines(2_100, 'x'))
    const file = await shown('big.txt')
    expect(file.hiddenLines).toBeGreaterThan(0)
    expect(await revert('big.txt', { kind: 'hunk', hunk: 0 })).toEqual({ ok: false, error: 'hidden' })
    expect(await revert('big.txt', { kind: 'lines', hunk: 0, lines: [0] })).toEqual({ ok: true })
    expect(read(join(repo, 'big.txt'))).toBe(lines(2_100, 'x').replace('x 1\n', ''))
    expect(await revert('big.txt', { kind: 'file' })).toEqual({ ok: true })
    expect(read(join(repo, 'big.txt'))).toBe('')
  })

  // Windows file names cannot hold ':'.
  it.skipIf(process.platform === 'win32')('takes a path with pathspec magic as a plain name', async () => {
    repo = makeRepo({ 'a.txt': 'a\n', ':(glob)b.txt': 'b\n' })
    writeFileSync(join(repo, 'a.txt'), 'A\n')
    writeFileSync(join(repo, ':(glob)b.txt'), 'B\n')
    expect(await revert(':(glob)b.txt', { kind: 'file' })).toEqual({ ok: true })
    expect(read(join(repo, ':(glob)b.txt'))).toBe('b\n')
    expect(read(join(repo, 'a.txt'))).toBe('A\n')
  })

  it('refuses a repository without commits', async () => {
    repo = mkdtempSync(join(base, 'empty-'))
    git(repo, 'init', '--quiet', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    expect(await reverter.revert({ root: repo, path: 'a.txt', target: { kind: 'file' }, digest: 'x' })).toEqual({ ok: false, error: 'unsupported' })
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
  })
})
