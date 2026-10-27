import type { SessionState } from '../domain/session'
import { cycleRounds, roundLimit } from './rounds'
import type { AiReviewSettings, BranchReview } from './types'

/** Branches a review never runs on by itself: integration and release branches. */
export const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'development', 'trunk'] as const

/** The git facts of a dev session's folder, read by the caller. */
export interface RepoFacts {
  /** Null on a detached HEAD. */
  branch: string | null
  headSha: string
  /** The base branch name asked for, and the ref found for it (`origin/develop`); null when none exists. */
  base: string
  baseRef: string | null
  /** Commits on HEAD that the base ref does not have. */
  ahead: number
  /** The working tree has uncommitted changes. */
  dirty: boolean
}

export interface AutoTriggerInput {
  settings: AiReviewSettings
  /** The session is itself a reviewer (or runs inside a review checkout). */
  isReviewerSession: boolean
  state: SessionState
  /** Milliseconds since the session's last turn ended; null when no turn has ended since it started. */
  idleMs: number | null
  /** Null: the folder is not a git repository. */
  repo: RepoFacts | null
  review: BranchReview | undefined
  /** Some review is running already (one at a time). */
  anyRunning: boolean
}

export type SkipReason =
  | 'disabled'
  | 'manualOnly'
  | 'reviewer'
  | 'notIdle'
  | 'debounce'
  | 'notRepo'
  | 'detached'
  | 'noBase'
  | 'protectedBranch'
  | 'noCommits'
  | 'alreadyReviewed'
  | 'running'
  | 'paused'
  | 'ready'
  | 'pendingDelivery'
  | 'roundLimit'

export type TriggerDecision = { start: true } | { start: false; reason: SkipReason }

const skip = (reason: SkipReason): TriggerDecision => ({ start: false, reason })

/** Whether a branch is one a review must not run on by itself (its own base included). */
export function isProtectedBranch(branch: string, base: string, baseRef: string | null): boolean {
  const names = new Set<string>([...PROTECTED_BRANCHES, base, ...(baseRef ? [baseRef.replace(/^origin\//, '')] : [])])
  return names.has(branch)
}

/**
 * Whether an automatic review starts now for a dev session. Cheap checks come first so the
 * caller can skip the git calls: `repo` may be null while the session is not idle long enough.
 * Uncommitted-only changes never start one (they are mentioned in the report of a real round).
 */
export function decideAutoReview(input: AutoTriggerInput): TriggerDecision {
  const { settings, review, repo } = input
  if (!settings.enabled) return skip('disabled')
  if (!settings.auto) return skip('manualOnly')
  if (input.isReviewerSession) return skip('reviewer')
  if (input.state !== 'ready' || input.idleMs === null) return skip('notIdle')
  if (input.idleMs < settings.idleSeconds * 1000) return skip('debounce')
  if (review?.status === 'reviewing') return skip('running')
  if (review?.status === 'paused') return skip('paused')
  if (review?.pendingDelivery) return skip('pendingDelivery')
  if (input.anyRunning) return skip('running')
  if (!repo) return skip('notRepo')
  if (!repo.branch) return skip('detached')
  if (!repo.baseRef) return skip('noBase')
  if (isProtectedBranch(repo.branch, repo.base, repo.baseRef)) return skip('protectedBranch')
  if (repo.ahead <= 0) return skip('noCommits')
  if (review && review.status !== 'stopped') {
    // "Ready for PR" holds until the branch moves: new commits open a new cycle with a fresh round budget.
    if (review.lastAttemptedSha === repo.headSha || review.lastReviewedSha === repo.headSha) return skip(review.status === 'ready' ? 'ready' : 'alreadyReviewed')
    if (review.status !== 'ready' && cycleRounds(review) >= roundLimit(review, settings)) return skip('roundLimit')
  } else if (review?.lastReviewedSha === repo.headSha) {
    return skip('alreadyReviewed')
  }
  return { start: true }
}

/** Why a manual review cannot start; null when it can. The button is always offered. */
export function manualBlocker(repo: RepoFacts | null, review: BranchReview | undefined): 'notRepo' | 'detached' | 'noBase' | 'noCommits' | 'running' | null {
  if (review?.status === 'reviewing') return 'running'
  if (!repo) return 'notRepo'
  if (!repo.branch) return 'detached'
  if (!repo.baseRef) return 'noBase'
  if (repo.ahead <= 0) return 'noCommits'
  return null
}
