import {
  CodeHostError,
  type CodeHostCapabilities,
  type DiffFile,
  type PullRequest,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestReview,
  type ReviewAction
} from './domain'
import { ticketKeysOfPullRequest } from './links'
import type { CodeHost, PullRequestQuery } from './port'

/** Days without activity after which a PR of mine counts as stale (Workhub 1). */
export const STALE_DAYS = 30

/**
 * The one word that sums a PR up, in Workhub 1's order: conflicts, failing CI, requested changes,
 * draft, approved, running CI, otherwise waiting for a review.
 */
export type PullRequestStatus =
  | 'merged'
  | 'closed'
  | 'conflicts'
  | 'ciFailed'
  | 'changesRequested'
  | 'draft'
  | 'approved'
  | 'ciRunning'
  | 'waitingReview'

export function classifyPullRequest(pr: Pick<PullRequest, 'state' | 'mergeable' | 'ci' | 'reviewDecision' | 'isDraft'>): PullRequestStatus {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.mergeable === 'conflicting') return 'conflicts'
  if (pr.ci === 'failure') return 'ciFailed'
  if (pr.reviewDecision === 'changesRequested') return 'changesRequested'
  if (pr.isDraft) return 'draft'
  if (pr.reviewDecision === 'approved') return 'approved'
  if (pr.ci === 'pending') return 'ciRunning'
  return 'waitingReview'
}

export function isStale(pr: Pick<PullRequest, 'updatedAt'>, now: number, days = STALE_DAYS): boolean {
  return pr.updatedAt !== undefined && now - pr.updatedAt > days * 86_400_000
}

/** A PR with what the lists need beyond the host's data. */
export interface PullRequestItem {
  pr: PullRequest
  status: PullRequestStatus
  stale: boolean
  ticketKeys: string[]
}

export function toItem(pr: PullRequest, now: number, { markStale }: { markStale: boolean }): PullRequestItem {
  return { pr, status: classifyPullRequest(pr), stale: markStale && isStale(pr, now), ticketKeys: ticketKeysOfPullRequest(pr) }
}

const newestFirst = (a: PullRequestItem, b: PullRequestItem) => (b.pr.updatedAt ?? 0) - (a.pr.updatedAt ?? 0)

/** My open PRs, newest activity first; those idle for `STALE_DAYS` are marked stale. */
export async function loadMyPullRequests(host: CodeHost, query: PullRequestQuery, now = Date.now()): Promise<PullRequestItem[]> {
  return (await host.listAuthored(query)).map((pr) => toItem(pr, now, { markStale: true })).sort(newestFirst)
}

/** PRs waiting for my review, newest activity first. */
export async function loadReviewQueue(host: CodeHost, query: PullRequestQuery, now = Date.now()): Promise<PullRequestItem[]> {
  return (await host.listReviewRequested(query)).map((pr) => toItem(pr, now, { markStale: false })).sort(newestFirst)
}

export interface PullRequestLists {
  mine: PullRequestItem[]
  toReview: PullRequestItem[]
}

export type PullRequestFilter = 'toReview' | 'mine' | 'stale' | 'all'
export const PULL_REQUEST_FILTERS: readonly PullRequestFilter[] = ['toReview', 'mine', 'stale', 'all']

/** The list under a filter. `mine` leaves out stale PRs, which have a filter of their own; `all` has each PR once. */
export function itemsForFilter(lists: PullRequestLists, filter: PullRequestFilter): PullRequestItem[] {
  switch (filter) {
    case 'toReview':
      return lists.toReview
    case 'mine':
      return lists.mine.filter((i) => !i.stale)
    case 'stale':
      return lists.mine.filter((i) => i.stale)
    case 'all': {
      const seen = new Set<string>()
      return [...lists.mine, ...lists.toReview].filter((i) => !seen.has(i.pr.url) && Boolean(seen.add(i.pr.url)))
    }
  }
}

export const prName = (pr: Pick<PullRequestRef, 'repo' | 'number'>, provider = 'github'): string =>
  `${pr.repo}${provider === 'gitlab' ? '!' : '#'}${pr.number}`

/** Case-insensitive search over the fields Workhub 1 searched: title, name, author, ticket keys, branches. */
export function searchPullRequests(items: readonly PullRequestItem[], query: string): PullRequestItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((i) =>
    [i.pr.title, prName(i.pr, i.pr.provider), i.pr.author, i.ticketKeys.join(' '), i.pr.branch, i.pr.base].some((f) => f.toLowerCase().includes(q))
  )
}

export interface PullRequestView {
  detail: PullRequestDetail
  /** Null while the diff could not be read; `filesError` says why. The conversation still shows. */
  files: DiffFile[] | null
  filesError?: string
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Everything the detail view shows. A failing diff does not hide the rest. */
export async function loadPullRequestView(host: CodeHost, ref: PullRequestRef): Promise<PullRequestView> {
  const [detail, files] = await Promise.allSettled([host.detail(ref), host.diff(ref)])
  if (detail.status === 'rejected') throw detail.reason
  return files.status === 'fulfilled'
    ? { detail: detail.value, files: files.value }
    : { detail: detail.value, files: null, filesError: messageOf(files.reason) }
}

export type ReviewRefusal = 'unsupported' | 'ownPullRequest' | 'bodyRequired'

/**
 * Whether a review can be sent. Approving or sending back one's own PR is refused (Workhub 1), and
 * so is a verdict the host does not support; "request changes" and "comment" need a body.
 */
export function reviewRefusal(
  capabilities: CodeHostCapabilities,
  action: ReviewAction,
  body: string,
  isMine: boolean
): ReviewRefusal | null {
  if (!capabilities.reviewActions.includes(action)) return 'unsupported'
  if (isMine && action !== 'comment') return 'ownPullRequest'
  if (action !== 'approve' && body.trim() === '') return 'bodyRequired'
  return null
}

/** Sends a review after `reviewRefusal` allows it. */
export async function submitReview(host: CodeHost, ref: PullRequestRef, action: ReviewAction, body: string, isMine: boolean): Promise<void> {
  const refusal = reviewRefusal(host.capabilities, action, body, isMine)
  if (refusal) throw new CodeHostError(`review refused: ${refusal}`, 'unsupported')
  await host.submitReview(ref, action, body.trim())
}

/** Posts a conversation comment; an empty one is refused. */
export async function postComment(host: CodeHost, ref: PullRequestRef, body: string): Promise<void> {
  if (body.trim() === '') throw new CodeHostError('comment refused: bodyRequired', 'unsupported')
  await host.comment(ref, body.trim())
}

/** Long-lived branches Workhub never deletes when it closes a PR (Workhub 1's default list). */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['develop', 'development', 'dev', 'master', 'main', 'staging', 'stage', 'production', 'prod', 'qa', 'test']

/** Whether closing a PR may delete this branch: never a listed long-lived one, nor any `release…` branch. */
export function isLongLivedBranch(branch: string, protectedBranches: readonly string[] = DEFAULT_PROTECTED_BRANCHES): boolean {
  const name = branch.trim().toLowerCase()
  return name === '' || name.startsWith('release') || protectedBranches.some((b) => b.toLowerCase() === name)
}

/** A comma/space/newline separated list typed in Settings as branch names: trimmed, no blanks, no duplicates. */
export function parseBranchList(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[\s,;]+/)) {
    const name = part.trim()
    if (name) seen.add(name)
  }
  return [...seen]
}

export type CloseRefusal = 'notMine' | 'notOpen'

/** Why the user cannot close this PR from Workhub: only their own open PRs (Workhub 1 offered it on "mine" only). */
export function closeRefusal(pr: Pick<PullRequest, 'state'>, isMine: boolean): CloseRefusal | null {
  if (!isMine) return 'notMine'
  if (pr.state !== 'open') return 'notOpen'
  return null
}

/** Closes a PR after `closeRefusal` allows it; a protected head branch is kept whatever was asked. */
export async function closePullRequest(host: CodeHost, ref: PullRequestRef, pr: Pick<PullRequest, 'state' | 'branch'>, isMine: boolean, options: { comment: string; deleteBranch: boolean; protectedBranches?: readonly string[] }): Promise<void> {
  const refusal = closeRefusal(pr, isMine)
  if (refusal) throw new CodeHostError(`close refused: ${refusal}`, 'unsupported')
  await host.close(ref, { comment: options.comment.trim(), deleteBranch: options.deleteBranch && !isLongLivedBranch(pr.branch, options.protectedBranches), branch: pr.branch })
}

export interface ReviewerState {
  name: string
  state: 'approved' | 'changesRequested' | 'dismissed' | 'requested'
}

/** Each reviewer's latest verdict, then the ones still asked to review. */
export function reviewerStates(detail: Pick<PullRequestDetail, 'reviews' | 'requestedReviewers'>): ReviewerState[] {
  const latest = new Map<string, { state: PullRequestReview['state']; at: number }>()
  for (const r of detail.reviews) {
    if (r.state !== 'approved' && r.state !== 'changesRequested' && r.state !== 'dismissed') continue
    const at = r.submittedAt ?? 0
    const prev = latest.get(r.author)
    if (!prev || at >= prev.at) latest.set(r.author, { state: r.state, at })
  }
  const decided: ReviewerState[] = [...latest.entries()]
    .map(([name, v]) => ({ name, state: v.state as ReviewerState['state'] }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const pending = detail.requestedReviewers.filter((n) => !latest.has(n)).map((name) => ({ name, state: 'requested' as const }))
  return [...decided, ...pending]
}
