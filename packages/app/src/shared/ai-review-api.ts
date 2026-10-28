// Types of the AI review bridge (window.hub.aiReview), shared by main, preload and renderer.
import type { AgentDefinition, BranchReview, BudgetStatus, EscalationReason, FindingStatus } from '@workhub/core'

/** A review as the renderer shows it: the stored review plus the live dev session it belongs to. */
export interface AiReviewView extends BranchReview {
  /** Workhub id of the live dev session with this identity, when one is open. */
  devSessionId?: string
}

/** An automatic review that did not start because the reviewer's account is past its usage budget. */
export interface AiReviewHold {
  devIdentity: string
  devSessionId?: string
  reviewerAgentKey: string
  budget: BudgetStatus
  at: number
}

export interface AiReviewSnapshot {
  reviews: AiReviewView[]
  holds: AiReviewHold[]
}

/** Something the user should hear about: the loop paused for them, or the branch is ready. */
export type AiReviewNotice =
  | { kind: 'paused'; reviewId: string; devSessionId?: string; branch: string; reason: EscalationReason; detail: string }
  | { kind: 'ready'; reviewId: string; devSessionId?: string; branch: string }
  | { kind: 'held'; devSessionId?: string; budget: BudgetStatus }

/** Why "Review before PR" did not start a round. */
export type AiReviewStartBlocker = 'disabled' | 'notRepo' | 'detached' | 'noBase' | 'noCommits' | 'running' | 'noReviewer' | 'budget' | 'unknownSession' | 'reviewerSession'

export type AiReviewStartResult = { ok: true; reviewId: string } | { ok: false; reason: AiReviewStartBlocker; detail?: string }

/** A reviewer agent the dialog offers (chat agents of the session's profile, one per account). */
export interface AgentReviewReviewer {
  key: string
  label: string
  agentId: string
  adapter: AgentDefinition['adapter']
  installed: boolean
}

/** What "Review with another agent" offers for a session. */
export interface AgentReviewOptions {
  reviewers: AgentReviewReviewer[]
  /** An installed agent of another kind than the session's own, when there is one. */
  defaultReviewerKey?: string
  /** The profile's brief prompt (Settings → Profiles → AI review), else the default. */
  briefPrompt: string
  /** The profile's round limit, the dialog's default. */
  maxRounds: number
}

export interface AgentReviewRequest {
  reviewerKey: string
  /** The brief prompt as the user left it in the dialog: sent to the session's own agent. */
  prompt: string
  maxRounds: number
  /** "Run anyway" past a usage budget. */
  override?: boolean
}

/** Why the loop did not start. */
export type AgentReviewBlocker = 'unknownSession' | 'reviewerSession' | 'notChat' | 'authorBusy' | 'running' | 'noReviewer' | 'reviewerMissing' | 'budget' | 'badRequest'

export type AgentReviewStartResult = { ok: true; loopId: string } | { ok: false; reason: AgentReviewBlocker; detail?: string }

/**
 * Where a review loop is: the author writes the brief, the reviewer starts, then reviewing and
 * fixing alternate; it ends approved, at its round limit, stopped (by the user, or a turn the user
 * cancelled) or failed.
 */
export type ReviewLoopPhase = 'briefing' | 'starting' | 'reviewing' | 'fixing' | 'approved' | 'maxRounds' | 'stopped' | 'failed'

/** Why a loop failed; `detail` adds the agent's or the system's own words. */
export type ReviewLoopFailure = 'authorClosed' | 'reviewerClosed' | 'reviewerStart' | 'noBrief' | 'emptyReview' | 'timeout' | 'budget' | 'error'

export interface ReviewLoopView {
  id: string
  authorSessionId: string
  reviewerSessionId?: string
  reviewerLabel: string
  /** The review round in progress (1-based); 0 while the author writes the brief. */
  round: number
  maxRounds: number
  phase: ReviewLoopPhase
  failure?: ReviewLoopFailure
  /** `cancelled`: a turn of the loop was cancelled in a chat; `user`: the Stop button. */
  stoppedBy?: 'user' | 'cancelled'
  detail?: string
  startedAt: number
  updatedAt: number
}

export interface AiReviewApi {
  get(): Promise<AiReviewSnapshot>
  /** "Review before PR": a round now on the session's branch. `override` is "Run anyway" past a usage budget. */
  start(sessionId: string, override?: boolean): Promise<AiReviewStartResult>
  /** Lets a paused review go on (it sends the open findings, or grants one more round). */
  continue(reviewId: string): Promise<void>
  setFindingStatus(reviewId: string, findingIds: string[], status: FindingStatus): Promise<void>
  /** The user's opinion: sent to the dev session now and to the reviewer on the next round. */
  opinion(reviewId: string, text: string): Promise<void>
  stop(reviewId: string): Promise<void>
  dismissHold(devIdentity: string): Promise<void>
  /** "Review with another agent": the reviewers, brief prompt and round limit for a session; null for an unknown session. */
  loopOptions(sessionId: string): Promise<AgentReviewOptions | null>
  /** Sends the brief prompt to the session's agent, then runs the loop with the reviewer it starts. */
  startLoop(sessionId: string, request: AgentReviewRequest): Promise<AgentReviewStartResult>
  loops(): Promise<ReviewLoopView[]>
  /** Ends a loop now: the turn it waits on is interrupted, both chats stay open. */
  stopLoop(loopId: string): Promise<void>
  /** Drops a finished loop from the panel. */
  dismissLoop(loopId: string): Promise<void>
  onLoopsChanged(cb: (loops: ReviewLoopView[]) => void): () => void
  onChanged(cb: (snapshot: AiReviewSnapshot) => void): () => void
  onNotice(cb: (notice: AiReviewNotice) => void): () => void
}
