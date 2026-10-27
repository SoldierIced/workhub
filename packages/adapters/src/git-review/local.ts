/**
 * The local changes of a session's folder for the human review (Workhub 1's LocalReviewService):
 * every repo the session touched, with its files and diff against the base branch or HEAD. Read
 * only: git runs without a shell, hooks, optional locks or external diff drivers, and nothing is
 * written to the repositories.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  githubPageFor,
  parseUnifiedDiff,
  type DiffHunk,
  type LocalRepoNote,
  type LocalReview,
  type LocalReviewFile,
  type LocalReviewRepo,
  type LocalReviewScope
} from '@workhub/core'
import { runGit, type GitRunner } from './index'

/** Diff lines kept per file; the rest is counted and left out. */
export const LOCAL_LINE_LIMIT = 2_000
/** New files larger than this are listed without their content. */
export const UNTRACKED_BYTE_LIMIT = 1_000_000
/** New files read per repo; past this they are listed without their content. */
export const UNTRACKED_FILE_LIMIT = 200
/** Git's empty tree: what a repo without commits is compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export interface LocalReviewInput {
  folder: string
  scope: LocalReviewScope
  /** When the session started: repos inside the folder count as touched with a commit since then. */
  since?: number
  /** The branch's pull request, when one is known (its base is preferred as the branch to compare with). */
  pullRequestOf?: (repo: { name: string; remoteName?: string; branch: string }) => { number: number; url: string; base: string } | undefined
}

export class LocalChanges {
  constructor(private readonly git: GitRunner = runGit) {}

  private async value(cwd: string, args: string[]): Promise<string | null> {
    const r = await this.git(cwd, args)
    const out = r.stdout.trim()
    return r.ok && out ? out : null
  }

  /** The repos the session touched in `folder` and their changes in `scope`. */
  async load(input: LocalReviewInput): Promise<LocalReview> {
    const folder = resolve(input.folder)
    const own = await this.value(folder, ['rev-parse', '--show-toplevel'])
    const children = (await childRepositories(folder)).filter((c) => c !== own)
    const touched = await mapLimit(children, 6, async (repo) => ((await this.isTouched(repo, input.since)) ? repo : null))
    const candidates = [...(own ? [own] : []), ...touched.filter((r): r is string => r !== null)]
    const repos = await mapLimit(candidates, 4, (repo) => this.loadRepo(repo, folder, input).catch(() => null))
    return {
      folder,
      scope: input.scope,
      repos: repos.filter((r): r is LocalReviewRepo => r !== null && r.files.length > 0),
      scannedRepos: (own ? 1 : 0) + children.length
    }
  }

  private async isTouched(repo: string, since?: number): Promise<boolean> {
    const status = await this.git(repo, ['status', '--porcelain=v1', '--untracked-files=normal'])
    if (status.ok && status.stdout.trim()) return true
    if (since === undefined) return false
    const last = Number(await this.value(repo, ['log', '-1', '--format=%ct']))
    return Number.isFinite(last) && last * 1000 >= since
  }

  /** The base branch to compare with: the hint (the PR's base), else `origin/HEAD`, else main/develop/master. */
  async baseBranch(repo: string, hint?: string): Promise<string | null> {
    const refs = new Set(((await this.value(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin', 'refs/heads'])) ?? '').split('\n'))
    const existing = (name: string) => (refs.has(`refs/remotes/origin/${name}`) ? `origin/${name}` : refs.has(`refs/heads/${name}`) ? name : null)
    if (hint) {
      const found = existing(hint)
      if (found) return found
    }
    const head = await this.value(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (head && head !== 'origin/HEAD') return head
    for (const name of ['main', 'develop', 'master']) {
      const found = existing(name)
      if (found) return found
    }
    return null
  }

  async loadRepo(repo: string, folder: string, input: LocalReviewInput): Promise<LocalReviewRepo | null> {
    const [branchValue, head, remote] = await Promise.all([
      this.value(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
      this.value(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']),
      this.value(repo, ['remote', 'get-url', 'origin'])
    ])
    const branch = branchValue && branchValue !== 'HEAD' ? branchValue : null
    const name = basename(repo === folder ? folder : repo)
    const remoteName = remote ? remote.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') : undefined
    const pr = branch ? input.pullRequestOf?.({ name, remoteName, branch }) : undefined

    let revision = head ? 'HEAD' : EMPTY_TREE
    let base: string | undefined
    let note: LocalRepoNote | undefined
    if (input.scope === 'branch') {
      if (!head) note = 'noCommits'
      else {
        const found = await this.baseBranch(repo, pr?.base)
        const mergeBase = found ? await this.value(repo, ['merge-base', found, 'HEAD']) : null
        if (found && mergeBase) {
          revision = mergeBase
          base = found
        } else note = found ? 'unrelatedBase' : 'noBase'
      }
    }

    const common = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M']
    const [patch, untrackedOut] = await Promise.all([
      this.git(repo, [...common, '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', revision, '--'], { maxBuffer: 256 * 1024 * 1024 }),
      this.git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
    ])
    if (!patch.ok) return null
    const files: LocalReviewFile[] = parseUnifiedDiff(patch.stdout).map((f) => {
      const limited = limitHunks(f.hunks, LOCAL_LINE_LIMIT)
      const note = f.binary ? 'binary' : f.hunks.length === 0 ? 'noText' : undefined
      return { ...f, hunks: f.binary ? [] : limited.hunks, hiddenLines: limited.hidden, untracked: false, ...(note ? { note } : {}) }
    })
    const tracked = new Set(files.map((f) => f.path))
    const untracked = untrackedOut.ok ? untrackedOut.stdout.split('\0').filter((p) => p && !p.endsWith('/') && !tracked.has(p)) : []
    for (const [i, path] of untracked.entries()) {
      files.push(i < UNTRACKED_FILE_LIMIT ? await untrackedFile(repo, path) : { ...addedFile(path), note: 'tooManyNew' })
    }
    files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }))
    const webUrl = pr?.url ?? (remote ? (githubPageFor(remote, branch, base) ?? undefined) : undefined)
    return {
      root: repo,
      name,
      branch,
      ...(base ? { base } : {}),
      ...(note ? { note } : {}),
      ...(webUrl ? { webUrl } : {}),
      ...(pr ? { pullRequest: { number: pr.number, url: pr.url } } : {}),
      files
    }
  }
}

function addedFile(path: string): LocalReviewFile {
  return { path, status: 'added', binary: false, additions: 0, deletions: 0, hunks: [], hiddenLines: 0, untracked: true }
}

/** A file git does not track yet, shown as added: every line is new. */
export async function untrackedFile(repo: string, path: string, lineLimit = LOCAL_LINE_LIMIT): Promise<LocalReviewFile> {
  const file = addedFile(path)
  const full = join(repo, path)
  try {
    const info = await stat(full)
    if (!info.isFile()) return { ...file, note: 'unreadable' }
    if (info.size > UNTRACKED_BYTE_LIMIT) return { ...file, note: 'tooLarge' }
    const data = await readFile(full)
    if (data.subarray(0, 8000).includes(0)) return { ...file, binary: true, note: 'binary' }
    const lines = data.toString('utf8').split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop()
    if (!lines.length) return { ...file, note: 'empty' }
    const hunk: DiffHunk = { header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.slice(0, lineLimit).map((text, i) => ({ kind: 'added', newNumber: i + 1, text })) }
    return { ...file, additions: lines.length, hunks: [hunk], hiddenLines: Math.max(lines.length - lineLimit, 0) }
  } catch {
    return { ...file, note: 'unreadable' }
  }
}

/** Keeps the first `limit` lines of a file's hunks; the rest is counted. */
export function limitHunks(hunks: DiffHunk[], limit: number): { hunks: DiffHunk[]; hidden: number } {
  let left = limit
  let hidden = 0
  const kept: DiffHunk[] = []
  for (const h of hunks) {
    if (left <= 0) {
      hidden += h.lines.length
      continue
    }
    const lines = h.lines.slice(0, left)
    hidden += h.lines.length - lines.length
    left -= lines.length
    kept.push({ header: h.header, lines })
  }
  return { hunks: kept, hidden }
}

/** Repositories directly inside a folder (never in the home folder or the root), sorted by name. */
export async function childRepositories(folder: string): Promise<string[]> {
  const path = resolve(folder)
  if (path === '/' || path === resolve(homedir()) || /^[a-zA-Z]:\\?$/.test(path)) return []
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  const repos: string[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = join(path, e.name)
    if (await stat(join(dir, '.git')).then(() => true, () => false)) repos.push(dir)
  }
  return repos.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

/** `fn` over `items` with at most `limit` running at once, results in the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
