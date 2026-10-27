import type { Profile } from '../domain/profile'
import type { EffectiveAgent } from '../usecases/effective-agents'
import { pickAgent } from '../usecases/pick-agent'
import { DEFAULT_AI_REVIEW_SETTINGS } from './defaults'
import type { AiReviewSettings } from './types'

export { DEFAULT_AI_REVIEW_SETTINGS, MAX_REVIEW_IDLE_SECONDS, MAX_REVIEW_ROUNDS, MIN_REVIEW_IDLE_SECONDS, MIN_REVIEW_ROUNDS } from './defaults'

/** The profile's AI review settings with the defaults filled in. Without a profile, the defaults. */
export function aiReviewSettings(profile: Pick<Profile, 'aiReview'> | null | undefined): AiReviewSettings {
  return { ...DEFAULT_AI_REVIEW_SETTINGS, ...(profile?.aiReview ?? {}) }
}

/**
 * The reviewer agent: the configured one when the profile still offers it with an app mode (the
 * review is a prompt and a reply in the chat), else the first agent with an app mode in the
 * user's order.
 */
export function pickReviewer(profile: (Pick<Profile, 'preferredAgents'> & Pick<Profile, 'aiReview'>) | null | undefined, agents: readonly EffectiveAgent[]): EffectiveAgent | undefined {
  const key = aiReviewSettings(profile).reviewerAgent
  const configured = key ? agents.find((a) => a.key === key && a.agent.capabilities.appMode) : undefined
  return configured ?? pickAgent(profile, agents, 'appMode')
}
