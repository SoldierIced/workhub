// Types of the AI review bridge (window.hub.aiReview), shared by main, preload and renderer.
import type { BranchReview, BudgetStatus, EscalationReason, FindingStatus } from '@workhub/core'

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
  onChanged(cb: (snapshot: AiReviewSnapshot) => void): () => void
  onNotice(cb: (notice: AiReviewNotice) => void): () => void
}
