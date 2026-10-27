/**
 * The git side of the AI review: reads a dev session's repository (branch, HEAD, commits ahead of
 * the base, uncommitted files, diffs) and keeps a separate detached checkout of the reviewed HEAD
 * for the reviewer agent. Nothing here writes to the dev's working tree: the only writes are the
 * review worktree itself and the repository's worktree bookkeeping (`git worktree add/remove`).
 *
 * Repository hooks never run (a `post-checkout` hook may install or build things), and diffs
 * ignore external diff drivers and textconv filters configured in the repository.
 */
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RepoFacts } from '@workhub/core'

/** Options every call adds: no hooks, no pager, no colors (external diff tools are refused per diff command). */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'color.ui=false']

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  /** The command was killed for running past its timeout. */
  timedOut?: boolean
}

export type GitRunner = (cwd: string, args: string[], opts?: { maxBuffer?: number; timeoutMs?: number }) => Promise<GitResult>

/** Runs git without a shell. `GIT_OPTIONAL_LOCKS=0` keeps read commands from taking the index lock the dev's own git may need. */
export const runGit: GitRunner = (cwd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...SAFE, ...args],
      { cwd, windowsHide: true, timeout: opts.timeoutMs ?? 30_000, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), ...(err && (err as { killed?: boolean }).killed ? { timedOut: true } : {}) })
    )
  })

/** How long a pre-round fetch of the base may take. */
export const FETCH_TIMEOUT_MS = 30_000

export interface RepoProbe extends RepoFacts {
  root: string
  /** Paths with uncommitted changes (staged, unstaged or untracked). */
  dirtyFiles: string[]
}

/** Paths out of `git status --porcelain=v1 -z` entries. */
export function parseStatus(out: string): string[] {
  const parts = out.split('\0').filter(Boolean)
  const files: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    const code = entry.slice(0, 2)
    files.push(entry.slice(3))
    // A rename or copy is followed by its source path.
    if (code.includes('R') || code.includes('C')) i++
  }
  return files
}

export class GitReview {
  constructor(private readonly git: GitRunner = runGit) {}

  private async out(cwd: string, args: string[], opts?: { maxBuffer?: number }): Promise<string | null> {
    const r = await this.git(cwd, args, opts)
    return r.ok ? r.stdout.trim() : null
  }

  /**
   * The base ref to diff against: `origin/<base>`, else a local `<base>`, else the remote's
   * default branch (`origin/HEAD`), else a local main/master. Nothing is fetched here (the trigger
   * probes often); `refreshBase` fetches before a round.
   */
  async resolveBase(root: string, base: string): Promise<{ name: string; ref: string } | null> {
    const exists = async (ref: string) => (await this.out(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null
    if (await exists(`refs/remotes/origin/${base}`)) return { name: base, ref: `origin/${base}` }
    if (await exists(`refs/heads/${base}`)) return { name: base, ref: base }
    const head = await this.out(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    if (head) {
      const name = head.replace(/^refs\/remotes\/origin\//, '')
      if (await exists(head)) return { name, ref: `origin/${name}` }
    }
    for (const name of ['main', 'master']) if (await exists(`refs/heads/${name}`)) return { name, ref: name }
    return null
  }

  /** The repository's remotes (names). */
  async remotes(root: string): Promise<string[]> {
    return ((await this.out(root, ['remote'])) ?? '').split('\n').map((r) => r.trim()).filter(Boolean)
  }

  /**
   * Fetches the base branch before a round so the diff is against what the team sees. Only the
   * base is fetched, never prompting (`GIT_TERMINAL_PROMPT=0`) and giving up after `timeoutMs`;
   * the caller reviews against the local ref when this fails and says so (`reason`). The dev's
   * checkout is not touched: only the remote-tracking ref moves.
   */
  async refreshBase(root: string, base: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ ok: true; remote: string } | { ok: false; reason: string }> {
    const remotes = await this.remotes(root)
    if (!remotes.length) return { ok: false, reason: 'the repository has no remote' }
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]!
    const r = await this.git(root, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', remote, base], { timeoutMs })
    if (r.ok) return { ok: true, remote }
    if (r.timedOut) return { ok: false, reason: `git fetch timed out after ${Math.round(timeoutMs / 1000)} s` }
    const line = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !l.startsWith('hint:')) ?? 'git fetch failed'
    return { ok: false, reason: line.slice(0, 200) }
  }

  /** The repository facts the trigger needs; null when `cwd` is not inside a git work tree with a commit. */
  async probe(cwd: string, base: string): Promise<RepoProbe | null> {
    const root = await this.out(cwd, ['rev-parse', '--show-toplevel'])
    if (!root) return null
    const headSha = await this.out(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (!headSha) return null
    const branch = (await this.out(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || null
    const resolved = await this.resolveBase(root, base)
    const ahead = resolved ? Number.parseInt((await this.out(root, ['rev-list', '--count', `${resolved.ref}..HEAD`])) ?? '0', 10) || 0 : 0
    const status = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    const dirtyFiles = status.ok ? parseStatus(status.stdout) : []
    return { root, branch, headSha, base: resolved?.name ?? base, baseRef: resolved?.ref ?? null, ahead, dirty: dirtyFiles.length > 0, dirtyFiles }
  }

  async mergeBase(root: string, a: string, b: string): Promise<string | null> {
    return this.out(root, ['merge-base', a, b])
  }

  /** Whether `ancestor` is an ancestor of `sha` (a rebase or force-push breaks the delta). */
  async isAncestor(root: string, ancestor: string, sha: string): Promise<boolean> {
    return (await this.git(root, ['merge-base', '--is-ancestor', ancestor, sha])).ok
  }

  /** `<short sha> <subject>` per commit in `from..to`, oldest first. */
  async commits(root: string, from: string, to: string, limit = 200): Promise<string[]> {
    const out = await this.out(root, ['log', '--no-color', '--reverse', `--max-count=${limit}`, '--format=%h %s', `${from}..${to}`])
    return out ? out.split('\n').filter(Boolean) : []
  }

  async diffStat(root: string, from: string, to: string): Promise<string> {
    return (await this.out(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--stat=160', from, to])) ?? ''
  }

  /** The diff, cut at `maxChars` on a line boundary. */
  async diff(root: string, from: string, to: string, maxChars: number): Promise<{ text: string; truncated: boolean }> {
    const text = (await this.out(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', from, to], { maxBuffer: 256 * 1024 * 1024 })) ?? ''
    return truncateDiff(text, maxChars)
  }

  /**
   * A detached checkout of `sha` at `path`, for the reviewer only. An existing review worktree
   * is moved to the new commit; a stale folder from a crashed run is replaced.
   */
  async checkout(root: string, path: string, sha: string): Promise<void> {
    const listed = (await this.out(root, ['worktree', 'list', '--porcelain'])) ?? ''
    if (listed.split('\n').some((l) => l === `worktree ${path}`)) {
      const r = await this.git(path, ['checkout', '--quiet', '--detach', '--force', sha])
      if (r.ok) return
      await this.remove(root, path)
    }
    await rm(path, { recursive: true, force: true })
    await this.git(root, ['worktree', 'prune'])
    await mkdir(dirname(path), { recursive: true })
    const r = await this.git(root, ['worktree', 'add', '--quiet', '--detach', '--force', path, sha])
    if (!r.ok) throw new Error(`git worktree add failed: ${r.stderr.trim() || 'unknown error'}`)
  }

  /** Drops the review worktree; the dev's own checkout is never touched. */
  async remove(root: string, path: string): Promise<void> {
    await this.git(root, ['worktree', 'remove', '--force', path])
    await rm(path, { recursive: true, force: true })
    await this.git(root, ['worktree', 'prune'])
  }
}

export function truncateDiff(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const cut = text.lastIndexOf('\n', maxChars)
  return { text: text.slice(0, cut > 0 ? cut : maxChars), truncated: true }
}

export { childRepositories, limitHunks, LocalChanges, untrackedFile, LOCAL_LINE_LIMIT, type LocalReviewInput } from './local'
