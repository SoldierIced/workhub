/**
 * AI review: before a pull request is opened, a reviewer agent reads the dev session's branch in
 * one exhaustive pass, sends its findings into the dev session's chat and checks the fixes on
 * the next round. It stops when nothing blocking is left, and asks the user to step in when the
 * loop drags on or asks for too much.
 */

export const REVIEW_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

/** Severities that keep a branch from being "ready for PR". */
export const BLOCKING_SEVERITIES: readonly ReviewSeverity[] = ['blocker', 'major']

export const FINDING_STATUSES = ['open', 'fixed', 'disputed', 'dismissed'] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

export const REVIEW_LANGUAGES = ['en', 'es'] as const
export type ReviewLanguage = (typeof REVIEW_LANGUAGES)[number]

/** Per-profile settings (`profile.aiReview`); see `aiReviewSettings` for the defaults. */
export interface AiReviewSettings {
  /** The module runs for this profile (manual and automatic reviews). */
  enabled: boolean
  /** Start a review on its own when a dev session goes idle with unreviewed commits. */
  auto: boolean
  /** `EffectiveAgent.key` of the reviewer; null: the first agent with an app mode in the user's order. */
  reviewerAgent: string | null
  /** The branch the pull request will target; the repository's default branch when it does not exist. */
  baseBranch: string
  /** Rounds before the user is asked to step in with blockers or majors still open. */
  maxRounds: number
  /** Extra checks appended to the reviewer's prompt, one per line. */
  checklist: string
  /** How long a dev session stays idle after its turn before an automatic review starts. */
  idleSeconds: number
  /** Language of the reviewer prompt and of the message sent to the dev session. */
  language: ReviewLanguage
  /** Model the reviewer starts with; empty: the agent's default. */
  reviewerModel: string
  /** Reasoning effort the reviewer starts with (e.g. `high`, `xhigh`); empty: the agent's default. Ignored by agents without the setting. */
  reviewerEffort: string
  /** "Review with another agent": what the author is asked to write the brief; empty: `DEFAULT_REVIEW_BRIEF_PROMPT`. */
  briefPrompt: string
}

export interface ReviewFinding {
  /** Stable within a review: `F1`, `F2`, … assigned by Workhub in order of discovery. */
  id: string
  severity: ReviewSeverity
  title: string
  file?: string
  line?: number
  why: string
  fix: string
  status: FindingStatus
  /** Round the finding was first reported in (1-based). */
  round: number
  /** Times it was found still open (or reported again) after the dev session had been asked to fix it. */
  reopenCount: number
  /** Whether it has been sent to the dev session at least once. */
  sent: boolean
  /** The dev agent's reason, when it disputes the finding. */
  disputeReason?: string
  /** Who marked it fixed: the dev agent (`FIXED F<n>`, still to be verified), the reviewer or the user. */
  fixedBy?: 'dev' | 'reviewer' | 'user'
  /** What the dev agent says it changed for it; kept when the finding is reopened. */
  fixNote?: string
  /** The reviewer's last note when verifying it. */
  note?: string
}

/** What the reviewer says about the size of what it asks for. */
export type ScopeAssessment = 'proportionate' | 'too_demanding' | 'scope_creep' | 'unknown'

/** The reviewer's reply, parsed from its fenced JSON block. */
export interface ParsedReview {
  summary: string
  scope: { assessment: ScopeAssessment; note: string }
  findings: Omit<ReviewFinding, 'id' | 'status' | 'round' | 'reopenCount' | 'sent'>[]
  /** Verdicts on findings of earlier rounds, by id. */
  previous: { id: string; status: 'fixed' | 'open'; note?: string }[]
  escalate: { needed: boolean; reason: string }
}

export type ReviewTrigger = 'auto' | 'manual'

export interface ReviewRound {
  n: number
  trigger: ReviewTrigger
  /** HEAD reviewed in this round. */
  sha: string
  /** The previous round's HEAD: this round reviews the delta from it. */
  fromSha?: string
  startedAt: number
  endedAt?: number
  reviewerAgentKey: string
  reviewerSessionId?: string
  /** Who reviewed, as the user knows them: agent name and account. */
  reviewerLabel?: string
  /** The model the reviewer ran with, when known. */
  reviewerModel?: string
  /** Set when the base could not be fetched before the round: `base not refreshed: <reason>`. */
  baseNote?: string
  /** Set when the reviewer ran without the asked model, with the reason. */
  modelNote?: string
  /** The dev's working tree had uncommitted changes, which the review cannot see. */
  uncommitted: boolean
  parsed: boolean
  summary?: string
  scope?: ParsedReview['scope']
  /** The reviewer's whole reply (kept for unparseable replies and for the record). */
  raw?: string
  error?: string
  newFindingIds: string[]
}

/**
 * - `reviewing`: a reviewer runs on the current round.
 * - `awaitingFixes`: findings went (or go) to the dev session; the next round starts on new commits.
 * - `paused`: the user must step in (see `escalation`); nothing runs until they act.
 * - `ready`: no blocker or major is open: the branch can go to a pull request.
 * - `failed`: the last round could not run (see the round's `error`); a new commit or the button retries.
 * - `stopped`: the user ended the review.
 */
export type ReviewStatus = 'reviewing' | 'awaitingFixes' | 'paused' | 'ready' | 'failed' | 'stopped'

export type EscalationReason = 'reviewer' | 'maxRounds' | 'reopened' | 'disputed' | 'unparsed'

export interface ReviewEscalation {
  reason: EscalationReason
  detail: string
  at: number
}

/** One review loop of one dev session on one branch. */
export interface BranchReview {
  /** `<dev session identity>::<branch>`; see `reviewKey`. */
  id: string
  devIdentity: string
  profileId: string | null
  repoRoot: string
  branch: string
  /** The base branch name asked for, and the ref actually diffed against (`origin/develop`). */
  base: string
  baseRef: string
  status: ReviewStatus
  rounds: ReviewRound[]
  /**
   * Rounds that came before the current cycle. A cycle ends at `ready`; the next round opens a new
   * one, and `maxRounds` is counted per cycle. Absent: 0.
   */
  cycleStart?: number
  findings: ReviewFinding[]
  /** HEAD of the last round that completed. */
  lastReviewedSha?: string
  /** HEAD of the last round started (completed or not): an automatic review never retries it. */
  lastAttemptedSha?: string
  escalation?: ReviewEscalation
  /** Rounds granted beyond `maxRounds` by the user's "Continue". */
  extraRounds: number
  /** The user's opinions, forwarded to the dev session and to the next reviewer round. */
  userNotes: string[]
  /** A message for the dev session that could not be delivered yet (the session was busy). */
  pendingDelivery?: string
  /** Findings the queued message carries; they count as sent once it is delivered. */
  pendingFindingIds?: string[]
  /** The dev session was sent findings; its next reply is read for disputes. */
  awaitingDevReply: boolean
  createdAt: number
  updatedAt: number
}

export interface AiReviewState {
  reviews: Record<string, BranchReview>
  /** Dev session identities whose automatic review the user turned off in the chat; absent: on. */
  autoOff?: Record<string, true>
}

export const EMPTY_AI_REVIEW_STATE: AiReviewState = { reviews: {} }
