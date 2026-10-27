import type { CiStatus, CommentThread, DiffFile, Mergeability, PullRequestComment, PullRequestDetail, PullRequestItem, PullRequestReview, PullRequestStatus, ReviewDecision } from '@workhub/core'
import { isPullRequestWindowTab, type CodeHostLists, type PullRequestWindowTab } from '../../shared/codehost-api'
import type { Tone } from '../components/atoms'
import type { MessageKey } from '../i18n/translate'

/** Badge tone and copy per PR status, in the order Workhub 1 colors them. */
export const STATUS_META: Record<PullRequestStatus, { label: MessageKey; tone: Tone }> = {
  merged: { label: 'pr.status.merged', tone: 'accent' },
  closed: { label: 'pr.status.closed', tone: 'neutral' },
  conflicts: { label: 'pr.status.conflicts', tone: 'danger' },
  ciFailed: { label: 'pr.status.ciFailed', tone: 'danger' },
  changesRequested: { label: 'pr.status.changesRequested', tone: 'warning' },
  draft: { label: 'pr.status.draft', tone: 'neutral' },
  approved: { label: 'pr.status.approved', tone: 'success' },
  ciRunning: { label: 'pr.status.ciRunning', tone: 'info' },
  waitingReview: { label: 'pr.status.waitingReview', tone: 'info' }
}

export const REVIEW_META: Record<ReviewDecision, { label: MessageKey; tone: Tone }> = {
  approved: { label: 'pr.review.approved', tone: 'success' },
  changesRequested: { label: 'pr.review.changesRequested', tone: 'warning' },
  reviewRequired: { label: 'pr.review.reviewRequired', tone: 'info' },
  none: { label: 'pr.review.none', tone: 'neutral' }
}

export const CI_META: Record<CiStatus, { label: MessageKey; tone: Tone }> = {
  success: { label: 'pr.ci.success', tone: 'success' },
  failure: { label: 'pr.ci.failure', tone: 'danger' },
  pending: { label: 'pr.ci.pending', tone: 'info' },
  none: { label: 'pr.ci.none', tone: 'neutral' }
}

export const MERGE_META: Record<Mergeability, { label: MessageKey; tone: Tone }> = {
  mergeable: { label: 'pr.merge.mergeable', tone: 'success' },
  conflicting: { label: 'pr.merge.conflicting', tone: 'danger' },
  unknown: { label: 'pr.merge.unknown', tone: 'neutral' }
}

/** The Pull requests screen opens on "To review" when something waits for the user, else on "Mine" (Workhub 1 opened on To review). */
export function defaultFilter(lists: Pick<CodeHostLists, 'toReview' | 'mine'> | undefined): 'toReview' | 'mine' {
  return lists && lists.toReview.length === 0 && lists.mine.length > 0 ? 'mine' : 'toReview'
}

/** The CLI hint shown when the user must sign in. */
export function loginCommand(cli: string | undefined): string {
  return cli === 'glab' ? 'glab auth login' : 'gh auth login'
}

export function installUrl(cli: string | undefined): string {
  return cli === 'glab' ? 'https://gitlab.com/gitlab-org/cli' : 'https://cli.github.com'
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000]
]

/** "3 hours ago" / "hace 3 horas" for an epoch time. */
export function relativeTime(at: number, now: number, locale: string): string {
  const diff = at - now
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
  }
  return rtf.format(0, 'minute')
}

/** Two letters for an avatar bubble. */
export function initials(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'
}

/** Lines of a diff file, for the "too long" guard. */
export function diffLineCount(file: DiffFile): number {
  return file.hunks.reduce((n, h) => n + h.lines.length + 1, 0)
}

export const MAX_DIFF_LINES = 1500

/** The item of a lists snapshot with this URL, in either list. */
export function findItem(lists: Pick<CodeHostLists, 'mine' | 'toReview'> | undefined, url: string): PullRequestItem | undefined {
  return lists?.mine.find((i) => i.pr.url === url) ?? lists?.toReview.find((i) => i.pr.url === url)
}

/** The hash a pull request window is opened with: `#pr?profile=<id>&url=<pull request url>`. */
export function prWindowHash(profileId: string | null, url: string, tab?: PullRequestWindowTab): string {
  return `#pr?profile=${encodeURIComponent(profileId ?? '')}&url=${encodeURIComponent(url)}${tab ? `&tab=${tab}` : ''}`
}

export function parsePrWindowHash(hash: string): { profileId: string | null; url: string; tab?: PullRequestWindowTab } | null {
  const m = /^#pr\?(.*)$/.exec(hash)
  if (!m) return null
  const params = new URLSearchParams(m[1])
  const url = params.get('url')
  if (!url) return null
  const tab = params.get('tab')
  return { profileId: params.get('profile') || null, url, ...(isPullRequestWindowTab(tab) ? { tab } : {}) }
}

/** One entry of a PR's conversation: a comment, a review with something to say, or a thread on code lines. */
export type TimelineEntry =
  | { kind: 'comment'; id: string; at: number; comment: PullRequestComment }
  | { kind: 'review'; id: string; at: number; review: PullRequestReview }
  | { kind: 'thread'; id: string; at: number; thread: CommentThread }

/**
 * The conversation in time order (Workhub 1's timeline). A review that only wraps inline comments
 * has no body and no verdict worth showing; its threads show on their own.
 */
export function conversationTimeline(detail: Pick<PullRequestDetail, 'comments' | 'reviews' | 'threads'>): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...detail.comments.map((comment): TimelineEntry => ({ kind: 'comment', id: `c${comment.id}`, at: comment.createdAt ?? 0, comment })),
    ...detail.reviews
      .filter((r) => r.body.trim() !== '' || r.state === 'approved' || r.state === 'changesRequested')
      .map((review): TimelineEntry => ({ kind: 'review', id: `r${review.id}`, at: review.submittedAt ?? 0, review })),
    ...detail.threads.filter((t) => t.comments.length > 0).map((thread): TimelineEntry => ({ kind: 'thread', id: `t${thread.id}`, at: thread.comments[0]?.createdAt ?? 0, thread }))
  ]
  return entries.sort((a, b) => a.at - b.at)
}
