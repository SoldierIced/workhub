// Session continuity across accounts and agents: types of the preload bridge (window.hub.continuity).
import type { BudgetStatus, FailoverMode, FailoverReason, SessionOrigin } from '@workhub/core'
import type { SessionView } from './api'

/** An account or agent a session can continue in. */
export interface ContinuityTarget {
  /** `EffectiveAgent.key` (`claude:laboral`, `codex`). */
  key: string
  label: string
  /** Failover targets: the account's budget verdict now. */
  budget?: BudgetStatus
}

/** What the session header menu and the limit notice can offer for one session. */
export interface ContinuityOptions {
  sessionId: string
  /** The profile's failover mode. */
  mode: FailoverMode
  /** Other Claude accounts under their ceilings, best first (empty for non-Claude sessions). */
  failover: ContinuityTarget[]
  /** Agents the session can be handed off to, in the profile's order. */
  handoff: ContinuityTarget[]
  /** The session is live, idle and in its chat: it can be asked to write the summary itself. */
  canSummarize: boolean
}

/**
 * An account ran out of usage and the profile asks first: the chat offers "Continue in
 * <account>", "Hand off to <agent>" or "Wait".
 */
export interface ContinuityOffer {
  sessionId: string
  reason: Exclude<FailoverReason, 'manual'>
  /** The account that ran out ("Personal"), for the wording. */
  accountLabel: string
  window?: string
  resetsAt?: number
  target?: ContinuityTarget
  handoff?: ContinuityTarget
}

/** Main moved a session by itself (automatic failover): the renderer follows it to its new id. */
export interface ContinuityMoved {
  fromId: string
  toId: string
  origin: SessionOrigin
}

export interface FailoverRequest {
  /** The account to continue in; the best one when unset. */
  targetKey?: string
  reason: FailoverReason
  window?: string
  /** A prompt to send once the session runs in the other account (the one the usage gate held). */
  prompt?: string
}

export interface HandoffRequest {
  targetKey: string
  /** Ask the source agent to write the summary (one turn of its account) instead of the deterministic brief. */
  summarize?: boolean
}

export interface HandoffResult {
  view: SessionView
  /** The brief to draft in the new session's composer (never sent by Workhub). */
  brief: string
  /** The agent could not write the summary; the deterministic brief was used instead. */
  summaryFailed?: boolean
}

export interface ContinuityApi {
  options(sessionId: string): Promise<ContinuityOptions>
  failover(sessionId: string, request: FailoverRequest): Promise<SessionView>
  handoff(sessionId: string, request: HandoffRequest): Promise<HandoffResult>
  onOffer(cb: (offer: ContinuityOffer) => void): () => void
  onMoved(cb: (moved: ContinuityMoved) => void): () => void
}
