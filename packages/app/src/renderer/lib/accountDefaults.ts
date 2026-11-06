import { effectiveAgentKey, orderAgents, resolveEffectiveAgents, slugId, type AgentAccount, type EffectiveAgent, type Profile, type WorkhubConfig } from '@workhub/core'

/**
 * The agent (and account) a profile starts with when nothing is picked: the first entry of its
 * agent order (`preferredAgents`), as the New session dialog and `pickAgent` read it.
 */
export function profileDefaultAgent(config: WorkhubConfig, profileId: string | null | undefined): EffectiveAgent | undefined {
  const profile = profileId ? config.profiles.find((p) => p.id === profileId) : undefined
  if (!profile) return undefined
  return orderAgents(profile.preferredAgents, resolveEffectiveAgents(config, profile.id))[0]
}

/** Whether an entry of the accounts list is the profile's default: an account, or (`accountId` null) an agent's own sign-in. */
export function isProfileDefault(defaultAgent: EffectiveAgent | undefined, agentId: string, accountId: string | null): boolean {
  if (!defaultAgent) return false
  if (accountId) return defaultAgent.account?.id === accountId
  return defaultAgent.account === null && defaultAgent.agent.id === agentId
}

/** `preferredAgents` with `key` first (once). */
function withFirst(preferred: readonly string[] | undefined, key: string): string[] {
  return [key, ...(preferred ?? []).filter((k) => k !== key)]
}

/**
 * The profile with the account as its default: the account is offered in the profile (added to
 * `accountIds`) and goes first in the agent order. Nothing else of the profile changes.
 */
export function makeAccountDefault(profile: Profile, account: Pick<AgentAccount, 'id' | 'agentId'>): Profile {
  const accountIds = profile.accountIds.includes(account.id) ? profile.accountIds : [...profile.accountIds, account.id]
  return { ...profile, accountIds, preferredAgents: withFirst(profile.preferredAgents, effectiveAgentKey(account.agentId, account.id)) }
}

/** The profile with an agent's own sign-in (no account) first in its agent order. */
export function makeSignInDefault(profile: Profile, agentId: string): Profile {
  return { ...profile, preferredAgents: withFirst(profile.preferredAgents, effectiveAgentKey(agentId, null)) }
}

/** Whether an agent's own sign-in can be the profile's default: the profile offers it (no account of that agent is bound). */
export function signInOffered(config: WorkhubConfig, profileId: string, agentId: string): boolean {
  return resolveEffectiveAgents(config, profileId).some((e) => e.account === null && e.agent.id === agentId)
}

/**
 * The profile with the account offered (`on`) or not. Taking it out also drops it from the agent
 * order, so no stale entry stays behind.
 */
export function withAccountInProfile(profile: Profile, accountId: string, on: boolean): Profile {
  if (on) return profile.accountIds.includes(accountId) ? profile : { ...profile, accountIds: [...profile.accountIds, accountId] }
  const next: Profile = { ...profile, accountIds: profile.accountIds.filter((id) => id !== accountId) }
  if (profile.preferredAgents) next.preferredAgents = profile.preferredAgents.filter((k) => !k.endsWith(`:${accountId}`))
  return next
}

/** An id for a new account from its name (`Claude work` -> `claude-work`), made unique against the taken ones. */
export function accountIdFromName(name: string, taken: readonly string[]): string {
  const base = slugId(name, '')
  if (!base) return ''
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const id = `${base.slice(0, 60)}-${n}`
    if (!taken.includes(id)) return id
  }
}
