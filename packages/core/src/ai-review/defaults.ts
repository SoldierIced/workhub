import type { AiReviewSettings } from './types'

export const MIN_REVIEW_ROUNDS = 1
export const MAX_REVIEW_ROUNDS = 10
export const MIN_REVIEW_IDLE_SECONDS = 10
export const MAX_REVIEW_IDLE_SECONDS = 3600

/**
 * On by default, automatic by default (owner decision, 2026-10-27): the point is that a branch is
 * reviewed before it reaches the team, without anyone having to remember to ask.
 */
export const DEFAULT_AI_REVIEW_SETTINGS: AiReviewSettings = {
  enabled: true,
  auto: true,
  reviewerAgent: null,
  baseBranch: 'develop',
  maxRounds: 3,
  checklist: '',
  idleSeconds: 60,
  language: 'en',
  reviewerModel: '',
  briefPrompt: ''
}
