/**
 * The human review of a session's local changes (Workhub 1's LocalReview): what is compared, the
 * files and repos it shows, and the comments the user leaves on diff lines before sending them to
 * the session as one message. Pure: git is read by the adapter, delivery happens in the app.
 */
import type { DiffFile, DiffLine } from '../codehost/domain'

/** Everything the branch changed since it left its base, or only what is not committed yet. Untracked files count as added in both. */
export type LocalReviewScope = 'branch' | 'uncommitted'

/** Why a file has no text diff. */
export type LocalFileNote = 'binary' | 'tooLarge' | 'unreadable' | 'empty' | 'tooManyNew' | 'noText'

/** Why a repo is not compared with what was asked (`branch` scope). */
export type LocalRepoNote = 'noCommits' | 'unrelatedBase' | 'noBase'

export interface LocalReviewFile extends DiffFile {
  /** Diff lines past the per-file limit, counted and not loaded. */
  hiddenLines: number
  untracked: boolean
  note?: LocalFileNote
}

export interface LocalReviewRepo {
  /** The repository root; also its id. */
  root: string
  /** The folder's name, as the session sees it. */
  name: string
  /** Null on a detached HEAD. */
  branch: string | null
  /** What the files are compared with (`origin/develop`, `main`); absent for uncommitted only. */
  base?: string
  note?: LocalRepoNote
  /** A web page for the repo on its host: the branch's pull request, else a compare or tree page. */
  webUrl?: string
  /** The branch's pull request, when one is known. */
  pullRequest?: { number: number; url: string }
  files: LocalReviewFile[]
}

export interface LocalReview {
  folder: string
  scope: LocalReviewScope
  /** The repos with changes in this scope, the session's folder first. */
  repos: LocalReviewRepo[]
  /** How many repos were looked at, with changes or not. */
  scannedRepos: number
}

export type CommentSide = 'old' | 'new'

/** A comment on a diff line, kept in the app until it is sent to the session. */
export interface ReviewComment {
  id: string
  repoRoot: string
  repoName: string
  path: string
  /** Which side the line number belongs to: the new file, or the old one for a removed line. */
  side: CommentSide
  line: number
  text: string
  createdAt: number
}

export const LOOKS_GOOD_MESSAGE = 'Local review: looks good'

/** The id of a file across repos. */
export function fileKey(repoRoot: string, path: string): string {
  return `${repoRoot}\u001f${path}`
}

/** Where a comment on this diff line points: the new line number, or the old one for a removed line. */
export function commentAnchor(line: Pick<DiffLine, 'oldNumber' | 'newNumber'>): { side: CommentSide; line: number } | null {
  if (line.newNumber !== undefined) return { side: 'new', line: line.newNumber }
  if (line.oldNumber !== undefined) return { side: 'old', line: line.oldNumber }
  return null
}

export function isCommentOn(comment: Pick<ReviewComment, 'side' | 'line'>, line: Pick<DiffLine, 'oldNumber' | 'newNumber'>): boolean {
  const anchor = commentAnchor(line)
  return anchor !== null && anchor.side === comment.side && anchor.line === comment.line
}

/** "src/App.ts:44", or "src/App.ts:40 (removed line)" for a line of the old version. */
export function commentLocation(comment: Pick<ReviewComment, 'path' | 'side' | 'line'>): string {
  return comment.side === 'new' ? `${comment.path}:${comment.line}` : `${comment.path}:${comment.line} (removed line)`
}

/**
 * One message with every comment, grouped by repo (in the order they were first commented),
 * files and lines in order: "Review comments on cash-out:\n1. src/A.cs:44 — text".
 */
export function reviewMessage(comments: readonly ReviewComment[]): string {
  const repos: string[] = []
  for (const c of comments) if (!repos.includes(c.repoName)) repos.push(c.repoName)
  return repos
    .map((repo) => {
      const items = comments
        .filter((c) => c.repoName === repo && c.text.trim() !== '')
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.createdAt - b.createdAt))
      const lines = items.map((c, i) => `${i + 1}. ${commentLocation(c)} — ${c.text.trim().replace(/\n/g, '\n   ')}`)
      return [`Review comments on ${repo}:`, ...lines].join('\n')
    })
    .join('\n\n')
}

/** Adds a comment, or replaces the one with the same id. A blank text removes it instead. */
export function upsertComment(comments: readonly ReviewComment[], comment: ReviewComment): ReviewComment[] {
  if (comment.text.trim() === '') return removeComment(comments, comment.id)
  const i = comments.findIndex((c) => c.id === comment.id)
  if (i < 0) return [...comments, comment]
  const next = [...comments]
  next[i] = { ...comments[i]!, text: comment.text }
  return next
}

export function removeComment(comments: readonly ReviewComment[], id: string): ReviewComment[] {
  return comments.filter((c) => c.id !== id)
}

/** Comments per file (`fileKey`), for the badges in the file list. */
export function commentCounts(comments: readonly ReviewComment[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const c of comments) {
    const key = fileKey(c.repoRoot, c.path)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** "feat/qr → develop", or the branch alone when nothing is compared with a base. */
export function branchLine(repo: Pick<LocalReviewRepo, 'branch' | 'base'>, detached = 'detached HEAD'): string {
  const branch = repo.branch ?? detached
  if (!repo.base) return branch
  return `${branch} → ${repo.base.replace(/^origin\//, '')}`
}

/** Files whose path contains the filter (case-insensitive); all of them for an empty filter. */
export function filterFiles<T extends { path: string }>(files: readonly T[], filter: string): T[] {
  const q = filter.trim().toLowerCase()
  return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : [...files]
}

/** `git@github.com:owner/repo.git`, `https://github.com/owner/repo` → host, owner and repo. */
export function parseRemote(remote: string): { host: string; owner: string; repo: string } | null {
  const r = remote.trim()
  const m = /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(r)
  if (!m) return null
  const parts = m[2]!.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return { host: m[1]!.toLowerCase(), owner: parts.slice(0, -1).join('/'), repo: parts.at(-1)! }
}

/** A web page for a repo on GitHub: the compare page against the base, else the branch's tree. Null for other hosts. */
export function githubPageFor(remote: string, branch: string | null, base?: string): string | null {
  const r = parseRemote(remote)
  if (!r || r.host !== 'github.com') return null
  const root = `https://github.com/${r.owner}/${r.repo}`
  if (!branch) return root
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')
  const shortBase = base?.replace(/^origin\//, '')
  if (shortBase && shortBase !== branch) return `${root}/compare/${enc(shortBase)}...${enc(branch)}`
  return `${root}/tree/${enc(branch)}`
}

/** Where review comments go and what happened to the last message, per session. */
export interface LocalReviewDelivery {
  /** `delivered`: typed into the session; `queued`: waiting for the session to be idle; `dropped`: given up. */
  state: 'delivered' | 'queued' | 'dropped'
  /** Why it was dropped. */
  reason?: 'closed' | 'busy'
  at: number
}
