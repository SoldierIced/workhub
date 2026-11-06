import { accountAgentId, type AgentAccount, type AgentDefinition } from '../domain/agent'
import type { Profile } from '../domain/profile'
import type { WorkhubConfig } from '../config/schema'
import { effectiveAgentKey, resolveEffectiveAgents } from './effective-agents'
import { orderAgents, pickAgent } from './pick-agent'
import { knownAgents } from './validation'

/**
 * One row of Settings → Profiles → a profile → Agents: an account, or an agent with its own sign-in
 * (no account). Offered rows come first, in the profile's order; the rest follow in a stable order.
 */
export interface ProfileAgentRow {
  /** `EffectiveAgent.key`: `<agentId>` or `<agentId>:<accountId>`. */
  key: string
  kind: 'account' | 'agent'
  agentId: string
  accountId?: string
  /** The profile offers this row (New session lists it). */
  offered: boolean
  /** The first offered row: what automatic choices and New session start with. */
  isDefault: boolean
  agent: AgentDefinition
  account?: AgentAccount
  /** `Claude · Personal` for an account, the agent's name otherwise. */
  label: string
}

function row(agent: AgentDefinition, account: AgentAccount | null, offered: boolean): ProfileAgentRow {
  return {
    key: effectiveAgentKey(agent.id, account?.id ?? null),
    kind: account ? 'account' : 'agent',
    agentId: agent.id,
    ...(account ? { accountId: account.id, account } : {}),
    offered,
    isDefault: false,
    agent,
    label: account ? `${agent.name} · ${account.name}` : agent.name
  }
}

/**
 * Every candidate of a profile, in one list: first what the profile offers (as
 * `resolveEffectiveAgents` builds it, in the `preferredAgents` order, with the `pickAgent` default
 * first), then every account it does not offer and every agent that has no offered row, in the
 * configured agent order. Once a profile offers an account of an agent, that agent's own sign-in is
 * not a row (as New session does not list it). Empty for an unknown profile.
 */
export function profileAgentRows(config: WorkhubConfig, profileId: string): ProfileAgentRow[] {
  const profile = config.profiles.find((p) => p.id === profileId)
  if (!profile) return []
  const offered = orderAgents(profile.preferredAgents, resolveEffectiveAgents(config, profileId))
  const picked = pickAgent(profile, offered, 'any')
  if (picked && offered[0] !== picked) {
    offered.splice(offered.indexOf(picked), 1)
    offered.unshift(picked)
  }
  const rows = offered.map((e) => row(e.agent, e.account, true))
  if (rows[0]) rows[0].isDefault = true

  const shown = new Set(rows.map((r) => r.key))
  const withRows = new Set(rows.map((r) => r.agentId))
  for (const agent of knownAgents(config)) {
    if (accountAgentId(agent) === agent.id) {
      for (const account of config.accounts) {
        if (account.agentId !== agent.id || profile.accountIds.includes(account.id)) continue
        const r = row(agent, account, false)
        if (shown.has(r.key)) continue
        rows.push(r)
        shown.add(r.key)
      }
    }
    if (withRows.has(agent.id) || shown.has(agent.id)) continue
    rows.push(row(agent, null, false))
    shown.add(agent.id)
  }
  return rows
}

/** `preferredAgents` with `key` placed right before `before` when that one is listed (and `key` is not yet). */
function insertBefore(preferred: readonly string[] | undefined, key: string, before: string): string[] | undefined {
  if (!preferred || preferred.includes(key)) return preferred ? [...preferred] : undefined
  const at = preferred.indexOf(before)
  return at < 0 ? [...preferred] : [...preferred.slice(0, at), key, ...preferred.slice(at)]
}

/**
 * The profile with the row offered (`on`) or not. An account row changes `accountIds`; an agent row
 * changes `agentIds` (`allAgentIds`: every known agent, to spell out "all but this one" when the
 * profile offers all of them). A row taken out also leaves the agent order. An account offered where
 * its agent's own sign-in is in the order takes that place, so the default does not jump elsewhere.
 */
export function offerRow(profile: Profile, row: Pick<ProfileAgentRow, 'kind' | 'agentId' | 'accountId' | 'key'> & { account?: Pick<AgentAccount, 'agentId'> }, on: boolean, allAgentIds: readonly string[]): Profile {
  const next: Profile = { ...profile }
  if (row.kind === 'account' && row.accountId) {
    const accountId = row.accountId
    if (on) {
      if (!profile.accountIds.includes(accountId)) next.accountIds = [...profile.accountIds, accountId]
      const owner = row.account?.agentId ?? row.agentId
      const preferred = insertBefore(profile.preferredAgents, effectiveAgentKey(owner, accountId), owner)
      if (preferred) next.preferredAgents = preferred
    } else {
      next.accountIds = profile.accountIds.filter((id) => id !== accountId)
      if (profile.preferredAgents) next.preferredAgents = profile.preferredAgents.filter((k) => !k.endsWith(`:${accountId}`))
    }
    return next
  }
  const current = profile.agentIds ?? [...allAgentIds]
  if (on) {
    if (profile.agentIds && !profile.agentIds.includes(row.agentId)) next.agentIds = [...profile.agentIds, row.agentId]
  } else {
    next.agentIds = current.filter((id) => id !== row.agentId)
    if (profile.preferredAgents) next.preferredAgents = profile.preferredAgents.filter((k) => k !== row.key)
  }
  return next
}

/**
 * The profile with the offered row `key` moved by `delta` places among the offered rows (−1: up,
 * 1: down; a drop passes the distance), clamped to the list. `preferredAgents` becomes the full order
 * of the offered rows. Unchanged when the row is not offered or does not move.
 */
export function moveRow(profile: Profile, rows: readonly Pick<ProfileAgentRow, 'key' | 'offered'>[], key: string, delta: number): Profile {
  const keys = rows.filter((r) => r.offered).map((r) => r.key)
  const from = keys.indexOf(key)
  if (from < 0) return profile
  const to = Math.max(0, Math.min(keys.length - 1, from + Math.trunc(delta)))
  if (to === from) return profile
  keys.splice(from, 1)
  keys.splice(to, 0, key)
  return { ...profile, preferredAgents: keys }
}

/** The Claude accounts a session of this profile switches between when one reaches its limit, in the list's order. */
export function failoverCandidates<R extends Pick<ProfileAgentRow, 'kind' | 'agentId' | 'offered'>>(rows: readonly R[]): R[] {
  return rows.filter((r) => r.offered && r.kind === 'account' && r.agentId === 'claude')
}
