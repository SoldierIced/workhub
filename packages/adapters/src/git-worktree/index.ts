/**
 * Git worktrees for dev sessions (`Worktrees` port). Unlike the AI review's read-only checkout,
 * these are the user's own working copies: repository hooks run (`post-checkout`, and later the
 * user's commit hooks), as in any checkout the user makes.
 */
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorktreeStatus, Worktrees } from '@workhub/core'
import { worktreeOf } from '../token-spend/git-worktree'

export interface GitOutput {
  ok: boolean
  stdout: string
  stderr: string
}

export type WorktreeGit = (cwd: string, args: string[]) => Promise<GitOutput>

/** Runs git without a shell or a pager; hooks are left as the repository has them. */
export const runWorktreeGit: WorktreeGit = (cwd, args) =>
  new Promise((done) => {
    execFile(
      'git',
      ['-c', 'core.pager=cat', '-c', 'color.ui=false', ...args],
      { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => done({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    )
  })

const failure = (what: string, r: GitOutput) => new Error(`${what} failed: ${r.stderr.trim() || r.stdout.trim() || 'unknown error'}`)

export class GitWorktrees implements Worktrees {
  constructor(private readonly git: WorktreeGit = runWorktreeGit) {}

  async repoRootOf(path: string): Promise<string | null> {
    const linked = await worktreeOf(path)
    if (linked) return linked.main
    const r = await this.git(path, ['rev-parse', '--show-toplevel'])
    return r.ok && r.stdout.trim() ? resolve(r.stdout.trim()) : null
  }

  async create(repoRoot: string, opts: { path: string; branch: string; base?: string }): Promise<void> {
    const check = await this.git(repoRoot, ['check-ref-format', '--branch', opts.branch])
    if (!check.ok) throw new Error(`"${opts.branch}" is not a valid branch name`)
    await mkdir(dirname(opts.path), { recursive: true })
    await this.excludeIfInside(repoRoot, opts.path)
    const exists = (await this.git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`])).ok
    const args = exists ? ['worktree', 'add', opts.path, opts.branch] : ['worktree', 'add', '-b', opts.branch, opts.path, opts.base?.trim() || (await this.defaultBase(repoRoot))]
    const r = await this.git(repoRoot, args)
    if (!r.ok) throw failure('git worktree add', r)
  }

  async status(path: string): Promise<WorktreeStatus> {
    const [st, ahead, branch] = await Promise.all([
      this.git(path, ['status', '--porcelain=v1']),
      // Commits no remote-tracking branch has: unpushed whether or not the branch has an upstream.
      this.git(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']),
      this.git(path, ['branch', '--show-current'])
    ])
    if (!st.ok) throw failure('git status', st)
    return { dirty: st.stdout.trim().length > 0, unpushed: ahead.ok ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0, branch: branch.stdout.trim() }
  }

  async remove(repoRoot: string, path: string, opts: { force: boolean }): Promise<void> {
    const r = await this.git(repoRoot, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), path])
    if (!r.ok) throw failure('git worktree remove', r)
    await this.git(repoRoot, ['worktree', 'prune'])
  }

  /** `origin/HEAD`'s branch when the remote has one, else the current HEAD. */
  private async defaultBase(repoRoot: string): Promise<string> {
    const r = await this.git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    return r.ok && r.stdout.trim() ? r.stdout.trim() : 'HEAD'
  }

  /** A worktree inside the repository's own folder would show as untracked files: list it in `info/exclude`. */
  private async excludeIfInside(repoRoot: string, path: string): Promise<void> {
    const rel = relative(repoRoot, path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
    const common = await this.git(repoRoot, ['rev-parse', '--git-common-dir'])
    if (!common.ok) return
    const gitDir = resolve(repoRoot, common.stdout.trim())
    const file = join(gitDir, 'info', 'exclude')
    const top = rel.split(sep)[0]!
    const line = `/${top}/`
    const current = await readFile(file, 'utf8').catch(() => '')
    if (current.split(/\r?\n/).includes(line)) return
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`)
  }
}
