/**
 * The local changes of a session's folder for the human review (Workhub 1's LocalReviewService):
 * every repo the session touched, with its files and diff against the base branch or HEAD. Read
 * only: git runs without a shell, hooks, optional locks or external diff drivers, and nothing is
 * written to the repositories.
 */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  githubPageFor,
  parseUnifiedDiff,
  splitDiffSections,
  type DiffHunk,
  type LocalRepoNote,
  type LocalReview,
  type LocalReviewFile,
  type LocalReviewOther,
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
/** Paths of `git status` looked at per repo for their time; a repo with more counts as the session's. */
export const STATUS_PATH_LIMIT = 500
/** Git's empty tree: what a repo without commits is compared with. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** The diff the review shows, against `revision`; the revert reads the same one to check what the window saw. */
export function localDiffArgs(revision: string): string[] {
  return ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', revision, '--']
}

/** Max bytes of a whole diff read at once. */
export const DIFF_MAX_BUFFER = 256 * 1024 * 1024

/** The digest of one file's raw diff section: what a revert checks the window saw. */
export function diffDigest(section: string): string {
  return createHash('sha256').update('diff\0').update(section).digest('hex')
}

export interface LocalReviewInput {
  folder: string
  scope: LocalReviewScope
  /** When the session started: repos inside the folder count as touched with a commit since then. */
  since?: number
  /**
   * Repos asked for by name (a tool the agent ran, through Workhub's control endpoint), reviewed
   * even outside the folder or untouched since the session started; `base` overrides the branch
   * compared with (`origin/main` or `main`). When present they are the whole review: the folder's
   * other repos are not scanned, since a container folder often holds unrelated uncommitted work.
   */
  extraRepos?: { path: string; base?: string }[]
  /** Absolute paths the session changed: the repos of the folder that contain one are the session's. */
  touched?: readonly string[]
  /** Repos loaded next to the folder's own (and next to `extraRepos`), whatever the split says. */
  alsoRepos?: readonly string[]
  /** No split between the session's repos and the folder's others: every repo with changes is loaded. */
  wholeFolder?: boolean
  /** The platform the paths come from; defaults to `process.platform`. Only Windows reads `touched` paths no child contains by time. */
  platform?: NodeJS.Platform
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
    // git prints forward slashes on Windows: compare and report native paths.
    const toplevel = await this.value(folder, ['rev-parse', '--show-toplevel'])
    const own = toplevel ? resolve(toplevel) : null
    const asked = new Map<string, string | undefined>()
    for (const extra of input.extraRepos ?? []) {
      const top = await this.value(resolve(extra.path), ['rev-parse', '--show-toplevel'])
      if (top) asked.set(resolve(top), extra.base)
    }
    // Repos asked for by name replace the folder scan: only those are reviewed.
    const children = asked.size ? [] : (await childRepositories(folder)).filter((c) => c !== own)
    const touchedChildren = await mapLimit(children, 6, async (repo) => ((await this.isTouched(repo, input.since)) ? repo : null))
    const changed = touchedChildren.filter((r): r is string => r !== null)
    const mine = input.wholeFolder || !changed.length ? null : await this.sessionRepos(children, changed, input)
    const also = new Set<string>()
    for (const path of input.alsoRepos ?? []) {
      const top = await this.value(resolve(path), ['rev-parse', '--show-toplevel'])
      if (top) also.add(resolve(top))
    }
    const own1 = own ? [own] : []
    const kept = mine ? changed.filter((r) => mine.has(r)) : changed
    const base = asked.size ? [...asked.keys()] : [...own1, ...kept]
    const candidates = [...base, ...[...also].filter((r) => !base.includes(r))]
    const others = mine ? changed.filter((r) => !mine.has(r) && !also.has(r)) : []
    const [repos, rest] = await Promise.all([
      mapLimit(candidates, 4, (repo) => this.loadRepo(repo, folder, input, asked.get(repo)).catch(() => null)),
      mapLimit(others, 4, (repo) => this.loadRepo(repo, folder, input).catch(() => null))
    ])
    const untouched: LocalReviewOther[] = []
    for (const r of rest) {
      if (!r || !r.files.length) continue
      untouched.push({
        name: r.name,
        root: r.root,
        files: r.files.length,
        additions: r.files.reduce((n, f) => n + f.additions, 0),
        deletions: r.files.reduce((n, f) => n + f.deletions, 0)
      })
    }
    return {
      folder,
      scope: input.scope,
      repos: repos.filter((r): r is LocalReviewRepo => r !== null && r.files.length > 0),
      ...(untouched.length ? { untouched } : {}),
      // Scanned without the split because it was asked to; repos that resolved replace the scan.
      ...(input.wholeFolder && !asked.size ? { wholeFolder: true as const } : {}),
      scannedRepos: asked.size || (own ? 1 : 0) + children.length
    }
  }

  /**
   * The children that are the session's, or null when there is no way to tell (no `since`): then every
   * child counts. By `touched` when one of its paths is inside a child; `touched` with entries and none
   * in a child means none (Windows: by time); no entries, by time.
   */
  private async sessionRepos(children: string[], changed: string[], input: LocalReviewInput): Promise<Set<string> | null> {
    const paths: string[] = []
    for (const p of input.touched ?? []) paths.push(await realpath(resolve(p)).catch(() => resolve(p)))
    const entries = paths.length > 0
    if (entries) {
      const roots = new Map<string, string>()
      for (const child of children) roots.set(child, await realpath(child).catch(() => child))
      const hit = children.filter((c) => {
        const root = roots.get(c)!
        return paths.some((p) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep))
      })
      if (hit.length) return new Set(hit)
      // Paths the session changed, none in a child: outside the folder, so no child is the session's.
      // On Windows a Git Bash path (`/c/x/app`) never matches, so the time rule decides there.
      if ((input.platform ?? process.platform) !== 'win32') return new Set()
    }
    if (input.since === undefined) return null
    const since = input.since
    const flags = await mapLimit(changed, 6, async (repo) => (await this.changedSince(repo, since)))
    return new Set(changed.filter((_, i) => flags[i]))
  }

  /** Whether something in the repo changed at or after `since`: a path of `git status` or the last commit. */
  private async changedSince(repo: string, since: number): Promise<boolean> {
    const last = Number(await this.value(repo, ['log', '-1', '--format=%ct']))
    if (Number.isFinite(last) && last * 1000 >= since) return true
    const status = await this.git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    if (!status.ok) return false
    const parts = status.stdout.split('\0')
    const paths: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!
      if (entry.length < 4) continue
      paths.push(entry.slice(3))
      // A rename or copy is followed by its old path, which is not read.
      if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i++
    }
    if (paths.length > STATUS_PATH_LIMIT) return true
    for (const path of paths) if ((await modifiedAt(join(repo, path))) >= since) return true
    return false
  }

  private async isTouched(repo: string, since?: number): Promise<boolean> {
    const status = await this.git(repo, ['status', '--porcelain=v1', '--untracked-files=normal'])
    if (status.ok && status.stdout.trim()) return true
    if (since === undefined) return false
    const last = Number(await this.value(repo, ['log', '-1', '--format=%ct']))
    return Number.isFinite(last) && last * 1000 >= since
  }

  /**
   * What to compare with: the hint (a branch, with or without `origin/`, or any commit a tool asked
   * for, such as the last pushed one), else `origin/HEAD`, else main/develop/master.
   */
  async baseBranch(repo: string, hint?: string): Promise<string | null> {
    const refs = new Set(((await this.value(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin', 'refs/heads'])) ?? '').split('\n'))
    const existing = (name: string) => (refs.has(`refs/remotes/origin/${name}`) ? `origin/${name}` : refs.has(`refs/heads/${name}`) ? name : null)
    if (hint) {
      const found = existing(hint.replace(/^origin\//, ''))
      if (found) return found
      // Not a branch: a commit, tag or other ref. `--end-of-options` keeps it from reading as an option.
      if (!hint.startsWith('-') && (await this.value(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${hint}^{commit}`]))) return hint
    }
    const head = await this.value(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (head && head !== 'origin/HEAD') return head
    for (const name of ['main', 'develop', 'master']) {
      const found = existing(name)
      if (found) return found
    }
    return null
  }

  async loadRepo(repo: string, folder: string, input: LocalReviewInput, baseHint?: string): Promise<LocalReviewRepo | null> {
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
        const found = await this.baseBranch(repo, baseHint ?? pr?.base)
        const mergeBase = found ? await this.value(repo, ['merge-base', found, 'HEAD']) : null
        if (found && mergeBase) {
          revision = mergeBase
          base = found
        } else note = found ? 'unrelatedBase' : 'noBase'
      }
    }

    const [patch, untrackedOut] = await Promise.all([
      this.git(repo, localDiffArgs(revision), { maxBuffer: DIFF_MAX_BUFFER }),
      this.git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
    ])
    if (!patch.ok) return null
    const parsed = parseUnifiedDiff(patch.stdout)
    // Only uncommitted changes of a repo with commits can be reverted: each file carries the digest of its raw diff.
    const sections = input.scope === 'uncommitted' && head ? splitDiffSections(patch.stdout) : []
    const revertible = sections.length === parsed.length
    const files: LocalReviewFile[] = parsed.map((f, i) => {
      const limited = limitHunks(f.hunks, LOCAL_LINE_LIMIT)
      const note = f.binary ? 'binary' : f.hunks.length === 0 ? 'noText' : undefined
      const digest = revertible ? diffDigest(sections[i]!) : undefined
      return { ...f, hunks: f.binary ? [] : limited.hunks, hiddenLines: limited.hidden, untracked: false, ...(note ? { note } : {}), ...(digest ? { digest } : {}) }
    })
    const tracked = new Set(files.map((f) => f.path))
    const untracked = untrackedOut.ok ? untrackedOut.stdout.split('\0').filter((p) => p && !p.endsWith('/') && !tracked.has(p)) : []
    for (const [i, path] of untracked.entries()) {
      const file = i < UNTRACKED_FILE_LIMIT ? await untrackedFile(repo, path) : { ...addedFile(path), note: 'tooManyNew' as const }
      if (input.scope !== 'uncommitted' || !head) delete file.digest
      files.push(file)
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

/** The digest of an untracked file: its content when it was read, else its kind, size and modification time. */
function untrackedDigest(info: { size: number; mtimeMs: number; isFile(): boolean }, data?: Buffer): string {
  const hash = createHash('sha256').update('untracked\0')
  if (data) hash.update(data)
  else hash.update(`${info.isFile() ? 'file' : 'other'}:${info.size}:${info.mtimeMs}`)
  return hash.digest('hex')
}

/**
 * A file git does not track yet, shown as added: every line is new. A symbolic link is not followed
 * (it may point outside the repository) and shows as `unreadable`, as anything that is not a plain
 * file does. `digest` tells a later revert whether it is still the file that was shown.
 */
export async function untrackedFile(repo: string, path: string, lineLimit = LOCAL_LINE_LIMIT): Promise<LocalReviewFile> {
  const added = addedFile(path)
  const full = join(repo, path)
  try {
    const info = await lstat(full)
    if (!info.isFile()) return { ...added, note: 'unreadable', digest: untrackedDigest(info) }
    if (info.size > UNTRACKED_BYTE_LIMIT) return { ...added, note: 'tooLarge', digest: untrackedDigest(info) }
    const data = await readFile(full)
    const file = { ...added, digest: untrackedDigest(info, data) }
    if (data.subarray(0, 8000).includes(0)) return { ...file, binary: true, note: 'binary' }
    const lines = data.toString('utf8').split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop()
    if (!lines.length) return { ...file, note: 'empty' }
    const hunk: DiffHunk = { header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.slice(0, lineLimit).map((text, i) => ({ kind: 'added', newNumber: i + 1, text })) }
    return { ...file, additions: lines.length, hunks: [hunk], hiddenLines: Math.max(lines.length - lineLimit, 0) }
  } catch {
    return { ...added, note: 'unreadable' }
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

/**
 * When a path was last modified: a deleted one, the nearest folder above it that still exists; a
 * folder (an untracked one), the newest of it and its direct entries.
 */
async function modifiedAt(path: string): Promise<number> {
  let current = path.replace(/[\\/]+$/, '')
  const original = current
  for (;;) {
    const info = await lstat(current).catch(() => null)
    if (info) {
      let newest = info.mtimeMs
      if (info.isDirectory() && current === original) {
        for (const name of await readdir(current).catch(() => [])) {
          const child = await lstat(join(current, name)).catch(() => null)
          if (child && child.mtimeMs > newest) newest = child.mtimeMs
        }
      }
      return newest
    }
    const up = dirname(current)
    if (up === current) return 0
    current = up
  }
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
