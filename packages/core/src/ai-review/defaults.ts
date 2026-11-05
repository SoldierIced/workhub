import type { AiReviewSettings } from './types'

export const MIN_REVIEW_ROUNDS = 1
export const MAX_REVIEW_ROUNDS = 10
export const MIN_REVIEW_IDLE_SECONDS = 10
export const MAX_REVIEW_IDLE_SECONDS = 3600

/**
 * On by default, manual by default (owner decision, 2026-11-01): a review round runs two agent
 * sessions and spends tokens, so it starts only when the user sends the branch to review. The
 * automatic trigger stays available as an opt-in switch in Settings. This applies on purpose to
 * existing profiles that never saved the switch: no migration keeps them automatic. Profiles that
 * saved `auto: true` keep it.
 */
export const DEFAULT_AI_REVIEW_SETTINGS: AiReviewSettings = {
  enabled: true,
  auto: false,
  reviewerAgent: null,
  baseBranch: 'develop',
  maxRounds: 3,
  checklist: '',
  idleSeconds: 60,
  language: 'en',
  reviewerModel: '',
  reviewerEffort: '',
  reviewerSession: 'same',
  briefPrompt: '',
  approveFindings: false
}
