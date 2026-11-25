import { fenceUntrusted, prName, type CommentThread, type PromptOverrides, type PullRequest, type PullRequestCheck, type PullRequestDetail, type PullRequestReview } from '@workhub/core'
import type { PullRequestTarget } from '@shared/links-api'
import { translate, type Locale } from '../i18n/translate'
import { draftPrompt } from './promptText'

/**
 * "Fix CI" and "Address review comments": a prompt about a pull request's failing checks or its
 * review feedback, sent to the session linked to the pull request when the user clicks. Check
 * names, links, titles and comments come from the code host and may be written by anyone, so
 * they go inside one fenced block, after a sentence saying they are data.
 */
export type PrFeedbackKind = 'fixCi' | 'addressReview'

/** Characters of one comment or review body, and of the whole fenced block. */
export const PR_FEEDBACK_LIMITS = { comment: 2000, block: 20_000, checks: 40 } as const

export const failingChecks = (detail: Pick<PullRequestDetail, 'checks'>): PullRequestCheck[] => detail.checks.filter((c) => c.status === 'failure')

export const unresolvedThreads = (detail: Pick<PullRequestDetail, 'threads'>): CommentThread[] => detail.threads.filter((t) => t.resolved !== true && t.comments.length > 0)

/** The last "changes requested" review of each reviewer whose latest verdict it still is. */
export function changesRequestedReviews(detail: Pick<PullRequestDetail, 'reviews'>): PullRequestReview[] {
  const latest = new Map<string, PullRequestReview>()
  for (const r of detail.reviews) if (r.state === 'approved' || r.state === 'changesRequested' || r.state === 'dismissed') latest.set(r.author, r)
  return [...latest.values()].filter((r) => r.state === 'changesRequested')
}

/** Which of the two actions a pull request offers. A list row lacks the threads: it goes by its CI and review decision only. */
export function feedbackKinds(pr: Pick<PullRequest, 'state' | 'ci' | 'reviewDecision'> & Partial<Pick<PullRequestDetail, 'checks' | 'threads' | 'reviews'>>): PrFeedbackKind[] {
  if (pr.state !== 'open') return []
  const kinds: PrFeedbackKind[] = []
  if (pr.ci === 'failure' || (pr.checks && failingChecks({ checks: pr.checks }).length > 0)) kinds.push('fixCi')
  const threads = pr.threads ? unresolvedThreads({ threads: pr.threads }).length : 0
  const requested = pr.reviews ? changesRequestedReviews({ reviews: pr.reviews }).length : 0
  if (pr.reviewDecision === 'changesRequested' || threads > 0 || requested > 0) kinds.push('addressReview')
  return kinds
}

/** The facts of a pull request a session needs, from its list or detail data. */
export function targetOf(pr: PullRequest): PullRequestTarget {
  return { provider: pr.provider, owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url, title: pr.title, branch: pr.branch, base: pr.base, author: pr.author }
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const cut = (text: string) => (text.length > PR_FEEDBACK_LIMITS.comment ? `${text.slice(0, PR_FEEDBACK_LIMITS.comment)}…` : text)

function checksBlock(title: string, checks: readonly PullRequestCheck[]): string {
  const lines = checks.slice(0, PR_FEEDBACK_LIMITS.checks).map((c) => `- ${oneLine(c.name)}${c.url ? `: ${oneLine(c.url)}` : ''}`)
  if (checks.length > PR_FEEDBACK_LIMITS.checks) lines.push(`- … ${checks.length - PR_FEEDBACK_LIMITS.checks} more`)
  return `Title: ${oneLine(title)}\nFailing checks:\n${lines.length ? lines.join('\n') : '- (the code host named none; read the checks of the head commit)'}`
}

function reviewBlock(title: string, detail: Pick<PullRequestDetail, 'reviews' | 'threads'>): string {
  const parts = [`Title: ${oneLine(title)}`]
  for (const r of changesRequestedReviews(detail)) if (r.body.trim()) parts.push(`Review by ${oneLine(r.author)} (changes requested):\n${cut(r.body.trim())}`)
  for (const t of unresolvedThreads(detail)) {
    const where = t.line !== undefined ? `${oneLine(t.path)}:${t.line}` : oneLine(t.path)
    parts.push(`${where}\n${t.comments.map((c) => `${oneLine(c.author)}: ${cut(c.body.trim())}`).join('\n')}`)
  }
  if (parts.length === 1) parts.push('(no comment text: the reviewers asked for changes without one; read the reviews on the code host)')
  return parts.join('\n\n')
}

/** The prompt for one action, built from the pull request's detail. */
export function feedbackPrompt(locale: Locale, kind: PrFeedbackKind, pr: PullRequestTarget, detail: Pick<PullRequestDetail, 'checks' | 'reviews' | 'threads'>, overrides?: PromptOverrides): string {
  const fenced = fenceUntrusted(kind === 'fixCi' ? checksBlock(pr.title, failingChecks(detail)) : reviewBlock(pr.title, detail), PR_FEEDBACK_LIMITS.block)
  // The note that the data is untrusted is fixed: it always goes right before the data, wherever the text puts `{data}`.
  const data = `${translate(locale, kind === 'fixCi' ? 'prFeedback.note.fixCi' : 'prFeedback.note.addressReview')}\n${fenced}`
  const params = { name: prName(pr, pr.provider), url: pr.url, branch: pr.branch, data }
  return kind === 'fixCi' ? draftPrompt(overrides, 'links.fixCi', locale, 'prFeedback.prompt.fixCi', params) : draftPrompt(overrides, 'links.addressReview', locale, 'prFeedback.prompt.addressReview', params)
}
