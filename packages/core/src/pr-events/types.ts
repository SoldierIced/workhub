import type { CiStatus, Mergeability, ReviewDecision } from '../codehost/domain'

/**
 * What can happen on a pull request between two syncs (Workhub 1's events, read from the list
 * data alone). `newCommits` is off by default: pushing to your own PR is rarely news.
 */
export const PR_EVENT_KINDS = [
  'reviewRequested',
  'approved',
  'changesRequested',
  'newComments',
  'ciFailed',
  'ciPassed',
  'conflicts',
  'newCommits',
  'merged',
  'closed'
] as const
export type PrEventKind = (typeof PR_EVENT_KINDS)[number]

export type PrEventToggles = Record<PrEventKind, boolean>

export const DEFAULT_PR_EVENT_TOGGLES: PrEventToggles = {
  reviewRequested: true,
  approved: true,
  changesRequested: true,
  newComments: true,
  ciFailed: true,
  ciPassed: false,
  conflicts: true,
  newCommits: false,
  merged: true,
  closed: true
}

/** One thing that happened on a pull request. `id` is stable: the same occurrence always gets the same one. */
export interface PrEvent {
  id: string
  kind: PrEventKind
  url: string
  title: string
  /** `repo#12`, as the lists show it. */
  name: string
  /** The author of a review request. */
  actor?: string
  /** Comments added, for `newComments`. */
  count?: number
  headSha?: string
  /** Epoch milliseconds the sync saw it. */
  at: number
}

/** A pull request of mine as the last sync saw it. Fields the host did not give stay undefined and are only seeded. */
export interface PrSnapshot {
  url: string
  title: string
  name: string
  decision: ReviewDecision
  ci: CiStatus
  mergeable: Mergeability
  headSha?: string
  /** Conversation comments plus review threads; undefined where the host does not report it. */
  commentCount?: number
  /** Syncs in a row in which the PR was not in the open list and its state could not be read. */
  misses?: number
}

/** What is remembered of one profile between syncs. */
export interface PrProfileState {
  mine: Record<string, PrSnapshot>
  /** URLs waiting for my review at the last sync; undefined until that list was read once (then it is only seeded). */
  requested?: string[]
  /** Ids already handled, oldest first, capped. */
  seen: string[]
}

/** The persisted memory of every profile, keyed by profile id. */
export interface PrEventState {
  version: 1
  profiles: Record<string, PrProfileState>
}

export const EMPTY_PR_EVENT_STATE: PrEventState = { version: 1, profiles: {} }

/** Loads and saves the sync memory. */
export interface PrEventStore {
  load(): Promise<PrEventState>
  save(state: PrEventState): Promise<void>
}
