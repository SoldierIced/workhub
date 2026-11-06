import { accountAgentId, effectiveAgentKey, orderAgents, resolveEffectiveAgents, slugId, type AgentAccount, type EffectiveAgent, type PlanUsageWindow, type Profile, type WorkhubConfig } from '@workhub/core'

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

/** One profile that offers an account (or an agent's own sign-in), and its place in that profile's agent order (1 = first). */
export interface Offering {
  profileId: string
  profileName: string
  position: number
}

/**
 * Where an account is offered (`accountId` null: the agent's own sign-in): every profile whose
 * agents include it, with its place in the profile's order. The engines of one account (Claude
 * Code and Claude Code over ACP) count once, so the place reads as the user sees the account.
 */
export function accountOfferings(config: WorkhubConfig, agentId: string, accountId: string | null): Offering[] {
  const out: Offering[] = []
  for (const profile of config.profiles) {
    const seen: string[] = []
    for (const e of orderAgents(profile.preferredAgents, resolveEffectiveAgents(config, profile.id))) {
      const owner = accountAgentId(e.agent)
      const identity = `${owner}:${e.account?.id ?? ''}`
      if (!seen.includes(identity)) seen.push(identity)
      if (owner === agentId && (e.account?.id ?? null) === accountId) {
        out.push({ profileId: profile.id, profileName: profile.name || profile.id, position: seen.indexOf(identity) + 1 })
        break
      }
    }
  }
  return out
}

/** The "Offer in profile" boxes of an account form, per profile id. */
export type Offers = Record<string, boolean>

/** The boxes as stored: a new account is in no profile yet. */
export function storedOffers(config: WorkhubConfig, accountId: string | null): Offers {
  return Object.fromEntries(config.profiles.map((p) => [p.id, accountId !== null && p.accountIds.includes(accountId)]))
}

/** The boxes a form opens with: the stored ones, or for a new account the profile being worked on. */
export function initialOffers(config: WorkhubConfig, accountId: string | null, profileId: string | null | undefined): Offers {
  const stored = storedOffers(config, accountId)
  if (accountId !== null) return stored
  return Object.fromEntries(Object.keys(stored).map((id) => [id, id === profileId]))
}

/**
 * The profile changes a save makes, compared with what is stored (never with the form's first
 * state: a new account starts checked, and that check must still be written).
 */
export function offerChanges(stored: Offers, draft: Offers): { profileId: string; on: boolean }[] {
  return Object.entries(draft)
    .filter(([id, on]) => (stored[id] ?? false) !== on)
    .map(([profileId, on]) => ({ profileId, on }))
}

/**
 * The profile with an agent's own sign-in replaced by an account (the default folder made an
 * account): the account is offered and takes the sign-in's places in the agent order, for every
 * engine of the agent (`agentIds`).
 */
export function adoptSignIn(profile: Profile, agentIds: readonly string[], accountId: string): Profile {
  const accountIds = profile.accountIds.includes(accountId) ? profile.accountIds : [...profile.accountIds, accountId]
  const next: Profile = { ...profile, accountIds }
  if (profile.preferredAgents) next.preferredAgents = profile.preferredAgents.map((k) => (agentIds.includes(k) ? effectiveAgentKey(k, accountId) : k))
  return next
}

/** The window an account has spent the most of, with its ceiling when one is set. */
export function mostSpentWindow(windows: readonly PlanUsageWindow[], ceilings: Readonly<Record<string, number>> | undefined): { window: string; percent: number; ceiling?: number } | undefined {
  let top: PlanUsageWindow | undefined
  for (const w of windows) if (!top || w.percent > top.percent) top = w
  if (!top) return undefined
  const ceiling = ceilings?.[top.window]
  return { window: top.window, percent: Math.round(top.percent), ...(ceiling !== undefined ? { ceiling } : {}) }
}
