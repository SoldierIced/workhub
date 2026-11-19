/**
 * Reverts uncommitted changes from the local review: a whole file, one hunk or some lines of a
 * hunk. The only class in git-review that writes to a repository; `LocalChanges` and `GitReview`
 * stay read only.
 *
 * Every revert first reads the same diff the review showed (`git diff HEAD`) and refuses with
 * `changed` when the file's digest differs from the one the window sent, so it never undoes
 * something the user did not see. A hunk or lines are undone with a patch built from that raw diff
 * (`buildRevertPatch`) and `git apply -R`; a file with `git restore --source=HEAD`. Content that
 * HEAD does not have (an untracked file, a new or renamed-to path) goes to the system trash instead
 * of being deleted. Hooks never run, pathspecs are literal and `git apply` ignores whitespace
 * settings, as the read side does.
 */
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRevertPatch, parseUnifiedDiff, splitDiffSections, type LocalRevertAnswer, type LocalRevertTarget } from '@workhub/core'
import { runGit, type GitRunner } from './index'
import { DIFF_MAX_BUFFER, diffDigest, LOCAL_LINE_LIMIT, limitHunks, localDiffArgs, untrackedFile } from './local'

export interface LocalRevertInput {
  /** The repository root. */
  root: string
  /** The file's path as the review names it (the new path of a rename), relative to `root`. */
  path: string
  target: LocalRevertTarget
  digest: string
}

export interface LocalReverterDeps {
  git?: GitRunner
  /** Moves a file to the system trash (Electron's `shell.trashItem`); tests pass a fake. */
  trash(fullPath: string): Promise<void>
  /** Where patch files are written for `git apply`; the system's temp folder by default. */
  tmpDir?: string
}

/** Git with pathspecs read as plain paths: a file named `:(glob)*` names only itself. */
const LITERAL = '--literal-pathspecs'

const failed = (detail: string): LocalRevertAnswer => ({ ok: false, error: 'failed', detail: detail.trim().slice(0, 2_000) })

export class LocalReverter {
  private readonly git: GitRunner

  constructor(private readonly deps: LocalReverterDeps) {
    this.git = deps.git ?? runGit
  }

  async revert(input: LocalRevertInput): Promise<LocalRevertAnswer> {
    const { root, path, target, digest } = input
    const head = await this.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (!head.ok || !head.stdout.trim()) return { ok: false, error: 'unsupported' }
    const diff = await this.git(root, localDiffArgs('HEAD'), { maxBuffer: DIFF_MAX_BUFFER })
    if (!diff.ok) return failed(diff.stderr)
    const sections = splitDiffSections(diff.stdout)
    const parsed = parseUnifiedDiff(diff.stdout)
    const at = sections.length === parsed.length ? parsed.findIndex((f) => f.path === path) : -1
    if (at < 0) return this.revertUntracked(root, path, target, digest)
    const section = sections[at]!
    const file = parsed[at]!
    if (diffDigest(section) !== digest) return { ok: false, error: 'changed' }

    if (target.kind === 'file') return this.restoreFile(root, file.path, file.status, file.oldPath)
    if (file.binary || file.status === 'deleted') return { ok: false, error: 'unsupported' }
    // Only what the window showed: a hunk cut by the line limit is not reverted whole.
    const shown = limitHunks(file.hunks, LOCAL_LINE_LIMIT).hunks[target.hunk]
    const full = file.hunks[target.hunk]
    if (!shown || !full) return { ok: false, error: 'changed' }
    if (target.kind === 'hunk' && shown.lines.length < full.lines.length) return { ok: false, error: 'hidden' }
    if (target.kind === 'lines' && target.lines.some((i) => i >= shown.lines.length)) return { ok: false, error: 'hidden' }
    const built = buildRevertPatch(section, target.hunk, target.kind === 'lines' ? target.lines : undefined)
    if (!built.ok) return { ok: false, error: built.reason === 'unsupported' ? 'unsupported' : 'changed' }
    return this.applyReverse(root, file.path, built.patch)
  }

  /** A file git does not track: only a whole-file revert, to the trash, while it is still what was shown. */
  private async revertUntracked(root: string, path: string, target: LocalRevertTarget, digest: string): Promise<LocalRevertAnswer> {
    const listed = await this.git(root, [LITERAL, 'ls-files', '--others', '--exclude-standard', '-z', '--', path])
    if (!listed.ok || !listed.stdout.split('\0').includes(path)) return { ok: false, error: 'changed' }
    if ((await untrackedFile(root, path)).digest !== digest) return { ok: false, error: 'changed' }
    if (target.kind !== 'file') return { ok: false, error: 'unsupported' }
    return this.toTrash(join(root, path))
  }

  private async toTrash(full: string): Promise<LocalRevertAnswer> {
    const exists = await lstat(full).then(() => true, () => false)
    if (!exists) return { ok: true }
    try {
      await this.deps.trash(full)
      return { ok: true }
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * The file as HEAD has it, in the index and the working tree: mode, binary content and deletions
   * included. A path HEAD does not have (a new file, the new name of a rename) leaves the index and
   * its working copy goes to the trash; a rename's old path comes back.
   */
  private async restoreFile(root: string, path: string, status: string, oldPath?: string): Promise<LocalRevertAnswer> {
    if (status === 'added' || status === 'renamed') {
      const trashed = await this.toTrash(join(root, path))
      if (!trashed.ok) return trashed
      const unstage = await this.git(root, [LITERAL, 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', path])
      if (!unstage.ok) return failed(unstage.stderr)
      if (status === 'added') return { ok: true }
    }
    const restore = await this.git(root, [LITERAL, 'restore', '--source=HEAD', '--staged', '--worktree', '--', status === 'renamed' && oldPath ? oldPath : path])
    return restore.ok ? { ok: true } : failed(restore.stderr)
  }

  /**
   * Undoes the change of `patch` in the working tree, and in the index when it is staged there too.
   * A file with staged and unstaged changes is patched in the index only when the index has the
   * same lines; when the index has none of the change (it is unstaged there) only the working tree
   * changes; anything in between is refused (`staged`) instead of leaving the two out of step.
   */
  private async applyReverse(root: string, path: string, patch: string): Promise<LocalRevertAnswer> {
    const dir = await mkdtemp(join(this.deps.tmpDir ?? tmpdir(), 'workhub-revert-'))
    const file = join(dir, 'revert.patch')
    try {
      await writeFile(file, patch)
      const apply = (...flags: string[]) => this.git(root, ['apply', '--recount', '--whitespace=nowarn', ...flags, file])
      const worktree = await apply('-R', '--check')
      if (!worktree.ok) return { ok: false, error: 'changed', detail: worktree.stderr.trim() }
      const staged = await this.git(root, [LITERAL, 'diff', '--cached', '--name-only', '-z', 'HEAD', '--', path])
      if (!staged.ok) return failed(staged.stderr)
      let inIndex = false
      if (staged.stdout.split('\0').includes(path)) {
        if ((await apply('-R', '--cached', '--check')).ok) inIndex = true
        else if (!(await apply('--cached', '--check')).ok) return { ok: false, error: 'staged' }
      }
      const done = await apply('-R')
      if (!done.ok) return failed(done.stderr)
      if (inIndex) {
        const index = await apply('-R', '--cached')
        if (!index.ok) return failed(index.stderr)
      }
      return { ok: true }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
