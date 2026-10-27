import type { Profile } from '../domain/profile'
import type { EffectiveAgent } from './effective-agents'

/**
 * What an automatic choice needs from the agent:
 * - `any`: no constraint (the default agent of a new session).
 * - `appMode`: the agent has the rich app mode (drafted prompts need the chat).
 * - `claude`: a Claude agent (`claude`, whichever account), e.g. "Ask Claude to review".
 */
export type AgentRequirement = 'any' | 'appMode' | 'claude'

const satisfies = (e: EffectiveAgent, requirement: AgentRequirement): boolean =>
  requirement === 'claude' ? e.agent.id === 'claude' : requirement === 'appMode' ? e.agent.capabilities.appMode : true

/**
 * The agent Workhub picks on its own: the first one in the profile's `preferredAgents` order (by
 * `EffectiveAgent.key`) that meets the requirement; else, for agents not in the list, Claude first and
 * then the first one in the configured order. Keys the profile no longer offers are ignored.
 */
export function pickAgent(profile: Pick<Profile, 'preferredAgents'> | null | undefined, candidates: readonly EffectiveAgent[], requirement: AgentRequirement): EffectiveAgent | undefined {
  const eligible = candidates.filter((e) => satisfies(e, requirement))
  for (const key of profile?.preferredAgents ?? []) {
    const preferred = eligible.find((e) => e.key === key)
    if (preferred) return preferred
  }
  return eligible.find((e) => e.agent.id === 'claude') ?? eligible[0]
}

/** The profile's agents in the user's order: the preferred ones first (as listed), then the rest as offered. Used by the settings list. */
export function orderAgents(preferredAgents: readonly string[] | undefined, candidates: readonly EffectiveAgent[]): EffectiveAgent[] {
  const ordered: EffectiveAgent[] = []
  for (const key of preferredAgents ?? []) {
    const e = candidates.find((c) => c.key === key)
    if (e && !ordered.includes(e)) ordered.push(e)
  }
  return [...ordered, ...candidates.filter((c) => !ordered.includes(c))]
}
