import { parseDisputes } from './parser'
import { formatDevMessage, formatOpinionMessage, formatRawDevMessage } from './prompt'
import {
  BLOCKING_SEVERITIES,
  type AiReviewSettings,
  type BranchReview,
  type EscalationReason,
  type FindingStatus,
  type ParsedReview,
  type ReviewEscalation,
  type ReviewFinding,
  type ReviewTrigger
} from './types'

/** A finding stays open after this many fix attempts: the user is asked to step in. */
export const REOPEN_LIMIT = 2

/** One review per dev session and branch. */
export function reviewKey(devIdentity: string, branch: string): string {
  return `${devIdentity}::${branch}`
}

export function roundLimit(review: Pick<BranchReview, 'extraRounds'>, settings: Pick<AiReviewSettings, 'maxRounds'>): number {
  return settings.maxRounds + review.extraRounds
}

export const isBlocking = (f: ReviewFinding): boolean => f.status === 'open' && BLOCKING_SEVERITIES.includes(f.severity)

export function blockingOpen(review: Pick<BranchReview, 'findings'>): ReviewFinding[] {
  return review.findings.filter(isBlocking)
}

export interface StartRoundInput {
  devIdentity: string
  profileId: string | null
  repoRoot: string
  branch: string
  base: string
  baseRef: string
  sha: string
  trigger: ReviewTrigger
  reviewerAgentKey: string
  uncommitted: boolean
  now: number
}

/**
 * Opens the next round. A stopped review starts over; any other one continues its numbering. A
 * manual round past the limit grants itself the extra round (the button is always available).
 */
export function startRound(prev: BranchReview | undefined, input: StartRoundInput, settings: Pick<AiReviewSettings, 'maxRounds'>): BranchReview {
  const fresh = !prev || prev.status === 'stopped'
  const base: BranchReview = fresh
    ? {
        id: reviewKey(input.devIdentity, input.branch),
        devIdentity: input.devIdentity,
        profileId: input.profileId,
        repoRoot: input.repoRoot,
        branch: input.branch,
        base: input.base,
        baseRef: input.baseRef,
        status: 'reviewing',
        rounds: [],
        findings: [],
        extraRounds: 0,
        userNotes: [],
        awaitingDevReply: false,
        createdAt: input.now,
        updatedAt: input.now
      }
    : { ...prev, repoRoot: input.repoRoot, base: input.base, baseRef: input.baseRef }
  const n = base.rounds.length + 1
  const extraRounds = input.trigger === 'manual' && n > roundLimit(base, settings) ? n - settings.maxRounds : base.extraRounds
  const fromSha = base.lastReviewedSha && base.lastReviewedSha !== input.sha ? base.lastReviewedSha : undefined
  const { escalation: _cleared, pendingDelivery: _dropped, pendingFindingIds: _carried, ...rest } = base
  return {
    ...rest,
    status: 'reviewing',
    extraRounds,
    awaitingDevReply: false,
    lastAttemptedSha: input.sha,
    updatedAt: input.now,
    rounds: [
      ...base.rounds,
      {
        n,
        trigger: input.trigger,
        sha: input.sha,
        ...(fromSha ? { fromSha } : {}),
        startedAt: input.now,
        reviewerAgentKey: input.reviewerAgentKey,
        uncommitted: input.uncommitted,
        parsed: false,
        newFindingIds: []
      }
    ]
  }
}

/** Records the reviewer session that runs the current round. */
export function attachReviewer(review: BranchReview, sessionId: string, now: number): BranchReview {
  return patchLastRound(review, { reviewerSessionId: sessionId }, now)
}

function patchLastRound(review: BranchReview, patch: Partial<BranchReview['rounds'][number]>, now: number): BranchReview {
  const rounds = review.rounds.slice()
  const last = rounds[rounds.length - 1]
  if (last) rounds[rounds.length - 1] = { ...last, ...patch }
  return { ...review, rounds, updatedAt: now }
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const fingerprint = (f: Pick<ReviewFinding, 'file' | 'title'>) => `${norm(f.file)}|${norm(f.title)}`

/** Merges a parsed reply into the findings: verdicts on earlier ones, then the new ones (deduplicated). */
export function mergeFindings(findings: readonly ReviewFinding[], parsed: ParsedReview, round: number): { findings: ReviewFinding[]; newIds: string[] } {
  const out = findings.map((f) => ({ ...f }))
  for (const verdict of parsed.previous) {
    const f = out.find((x) => x.id === verdict.id)
    if (!f || f.status === 'dismissed') continue
    if (verdict.note) f.note = verdict.note
    if (verdict.status === 'fixed') {
      if (f.status !== 'disputed') f.status = 'fixed'
    } else {
      if (f.sent) f.reopenCount += 1
      if (f.status === 'fixed') f.status = 'open'
    }
  }
  let next = out.reduce((max, f) => Math.max(max, Number(f.id.slice(1)) || 0), 0)
  const newIds: string[] = []
  for (const raw of parsed.findings) {
    const same = out.find((f) => fingerprint(f) === fingerprint(raw))
    if (same) {
      // Reported again: a "fixed" one is back; anything else is a duplicate of a known finding.
      if (same.status === 'fixed') {
        same.status = 'open'
        if (same.sent) same.reopenCount += 1
      }
      continue
    }
    const id = `F${++next}`
    newIds.push(id)
    out.push({ ...raw, id, status: 'open', round, reopenCount: 0, sent: false })
  }
  return { findings: out, newIds }
}

/** Why the loop must stop for the user, after a parsed round. Empty: it can go on (or it is done). */
export function escalationsAfterRound(review: BranchReview, parsed: ParsedReview, settings: Pick<AiReviewSettings, 'maxRounds'>): { reason: EscalationReason; detail: string }[] {
  const out: { reason: EscalationReason; detail: string }[] = []
  const scopeFlag = parsed.scope.assessment === 'scope_creep' || parsed.scope.assessment === 'too_demanding'
  if (parsed.escalate.needed || scopeFlag) out.push({ reason: 'reviewer', detail: parsed.escalate.reason || parsed.scope.note || parsed.scope.assessment })
  const reopened = review.findings.filter((f) => f.status === 'open' && f.reopenCount >= REOPEN_LIMIT)
  if (reopened.length) out.push({ reason: 'reopened', detail: reopened.map((f) => `${f.id} ${f.title}`).join('; ') })
  const blocking = blockingOpen(review)
  if (blocking.length && review.rounds.length >= roundLimit(review, settings)) out.push({ reason: 'maxRounds', detail: blocking.map((f) => `${f.id} ${f.title}`).join('; ') })
  return out
}

export interface RoundResult {
  /** The reviewer's whole reply. */
  raw: string
  parsed: ParsedReview | null
  /** Set when the reviewer could not run or did not answer. */
  error?: string
}

/**
 * Closes the current round with the reviewer's reply and decides what comes next:
 * - could not run: `failed` (a new commit or the button retries);
 * - unreadable reply: `paused` with the raw text (Continue forwards it to the dev session);
 * - a reason to stop (see `escalationsAfterRound`): `paused`, nothing sent yet;
 * - no blocker or major open: `ready`;
 * - otherwise `awaitingFixes`, with the message for the dev session queued.
 */
export function completeRound(review: BranchReview, result: RoundResult, settings: AiReviewSettings, now: number): BranchReview {
  const round = review.rounds[review.rounds.length - 1]
  if (!round || review.status !== 'reviewing') return review
  if (result.error) {
    return { ...patchLastRound(review, { endedAt: now, error: result.error, ...(result.raw ? { raw: result.raw } : {}) }, now), status: 'failed' }
  }
  if (!result.parsed) {
    const done = patchLastRound(review, { endedAt: now, raw: result.raw, parsed: false }, now)
    return { ...done, status: 'paused', lastReviewedSha: round.sha, escalation: { reason: 'unparsed', detail: '', at: now } }
  }
  const { findings, newIds } = mergeFindings(review.findings, result.parsed, round.n)
  const merged: BranchReview = {
    ...patchLastRound(review, { endedAt: now, raw: result.raw, parsed: true, summary: result.parsed.summary, scope: result.parsed.scope, newFindingIds: newIds }, now),
    findings,
    lastReviewedSha: round.sha
  }
  const reasons = escalationsAfterRound(merged, result.parsed, settings)
  if (reasons.length) return pause(merged, reasons, now)
  return settle(merged, settings, now)
}

function pause(review: BranchReview, reasons: { reason: EscalationReason; detail: string }[], now: number): BranchReview {
  const first = reasons[0]!
  const escalation: ReviewEscalation = { reason: first.reason, detail: reasons.map((r) => r.detail).filter(Boolean).join(' | '), at: now }
  return { ...review, status: 'paused', escalation, updatedAt: now }
}

/**
 * Ready when nothing blocking is open; else the open findings go to the dev session. A ready
 * branch still gets its minors and nits once, if they were never sent.
 */
function settle(review: BranchReview, settings: AiReviewSettings, now: number): BranchReview {
  const { escalation: _cleared, ...rest } = review
  const ready = !blockingOpen(review).length
  const unsent = review.findings.some((f) => f.status === 'open' && !f.sent)
  if (ready && !unsent) return { ...rest, status: 'ready', updatedAt: now }
  const round = review.rounds[review.rounds.length - 1]?.n ?? 1
  const message = formatDevMessage({ language: settings.language, branch: review.branch, base: review.base, round, maxRounds: roundLimit(review, settings), findings: review.findings })
  const carried = review.findings.filter((f) => f.status === 'open').map((f) => f.id)
  return { ...rest, status: ready ? 'ready' : 'awaitingFixes', pendingDelivery: queue(review.pendingDelivery, message), pendingFindingIds: [...new Set([...(review.pendingFindingIds ?? []), ...carried])], updatedAt: now }
}

const queue = (pending: string | undefined, message: string) => (pending ? `${pending}\n\n---\n\n${message}` : message)

/**
 * The queued message reached the dev session. The findings it carried count as sent, and then the
 * dev's next reply is read for disputes; a message without findings (an opinion) changes neither.
 */
export function markDelivered(review: BranchReview, now: number): BranchReview {
  const { pendingDelivery: _sent, pendingFindingIds: carried = [], ...rest } = review
  if (!carried.length) return { ...rest, updatedAt: now }
  return { ...rest, findings: review.findings.map((f) => (carried.includes(f.id) ? { ...f, sent: true } : f)), awaitingDevReply: true, updatedAt: now }
}

/** The dev agent's reply after the findings: `DISPUTE F<n>: <reason>` lines pause the loop for the user. */
export function applyDevReply(review: BranchReview, text: string, now: number): BranchReview {
  if (!review.awaitingDevReply) return review
  const disputes = parseDisputes(text).filter((d) => review.findings.some((f) => f.id === d.id && f.status === 'open'))
  const next: BranchReview = { ...review, awaitingDevReply: false, updatedAt: now }
  if (!disputes.length) return next
  next.findings = review.findings.map((f) => {
    const d = disputes.find((x) => x.id === f.id)
    return d ? { ...f, status: 'disputed', disputeReason: d.reason } : f
  })
  return review.status === 'paused' ? next : pause(next, [{ reason: 'disputed', detail: disputes.map((d) => `${d.id}: ${d.reason}`).join('; ') }], now)
}

/**
 * The user's "Continue" on a paused review: it grants a round when the limit was the reason,
 * forgives the reopen count, and lets the open findings (or the raw reply) go to the dev session.
 */
export function continueReview(review: BranchReview, settings: AiReviewSettings, now: number): BranchReview {
  if (review.status !== 'paused') return review
  const reason = review.escalation?.reason
  const base: BranchReview = {
    ...review,
    extraRounds: reason === 'maxRounds' || review.rounds.length >= roundLimit(review, settings) ? review.extraRounds + 1 : review.extraRounds,
    findings: review.findings.map((f) => (f.reopenCount >= REOPEN_LIMIT ? { ...f, reopenCount: 0 } : f))
  }
  if (reason === 'unparsed') {
    const raw = review.rounds[review.rounds.length - 1]?.raw ?? ''
    const { escalation: _cleared, ...rest } = base
    return { ...rest, status: 'awaitingFixes', pendingDelivery: queue(review.pendingDelivery, formatRawDevMessage(settings.language, raw)), updatedAt: now }
  }
  const { escalation: _cleared, ...rest } = base
  return settle(rest, settings, now)
}

/** The user marks a finding. Outside a pause, the review becomes ready once nothing blocking is open. */
export function setFindingStatus(review: BranchReview, ids: readonly string[], status: FindingStatus, now: number): BranchReview {
  const findings = review.findings.map((f) => (ids.includes(f.id) ? { ...f, status } : f))
  const next: BranchReview = { ...review, findings, updatedAt: now }
  if (review.status === 'awaitingFixes' && !blockingOpen(next).length) {
    const { pendingDelivery: _dropped, pendingFindingIds: _carried, ...rest } = next
    return { ...rest, status: 'ready' }
  }
  if (review.status === 'ready' && blockingOpen(next).length) return { ...next, status: 'awaitingFixes' }
  return next
}

/** The user's opinion: kept for the next reviewer round and queued for the dev session. */
export function addOpinion(review: BranchReview, text: string, settings: Pick<AiReviewSettings, 'language'>, now: number): BranchReview {
  const note = text.trim()
  if (!note) return review
  return { ...review, userNotes: [...review.userNotes, note], pendingDelivery: queue(review.pendingDelivery, formatOpinionMessage(settings.language, note)), updatedAt: now }
}

export function stopReview(review: BranchReview, now: number): BranchReview {
  const { pendingDelivery: _dropped, pendingFindingIds: _carried, escalation: _cleared, ...rest } = review
  return { ...rest, status: 'stopped', awaitingDevReply: false, updatedAt: now }
}

/** Findings the next round must verify: everything still open or disputed. */
export function findingsToVerify(review: Pick<BranchReview, 'findings'>): ReviewFinding[] {
  return review.findings.filter((f) => f.status === 'open' || f.status === 'disputed')
}
