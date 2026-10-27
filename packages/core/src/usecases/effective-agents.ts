import type { AgentAccount, AgentDefinition } from '../domain/agent'
import type { WorkhubConfig } from '../config/schema'
import { knownAgents } from './validation'

/** One choice in the "new session" picker: an agent, optionally with one of its accounts. */
export interface EffectiveAgent {
  /** `<agentId>` or `<agentId>:<accountId>`; unique within a profile. */
  key: string
  agent: AgentDefinition
  /** Null: the agent's own default setup (no account override). */
  account: AgentAccount | null
  label: string
}

export function effectiveAgentKey(agentId: string, accountId: string | null): string {
  return accountId ? `${agentId}:${accountId}` : agentId
}

/**
 * The agents a profile offers. For each agent the profile allows (all known agents when
 * `agentIds` is unset): one entry per bound account of that agent, or a single default entry
 * when none is bound. Agents with a bound account are offered even if `agentIds` omits them.
 * Without a profile, every known agent with its default setup.
 */
export function resolveEffectiveAgents(config: WorkhubConfig, profileId: string | null | undefined): EffectiveAgent[] {
  const agents = knownAgents(config)
  const profile = profileId ? config.profiles.find((p) => p.id === profileId) : undefined
  if (!profile) return agents.map((agent) => entry(agent, null))

  const bound = config.accounts.filter((a) => profile.accountIds.includes(a.id))
  const allowed = new Set(profile.agentIds ?? agents.map((a) => a.id))
  for (const acc of bound) allowed.add(acc.agentId)

  const result: EffectiveAgent[] = []
  for (const agent of agents) {
    if (!allowed.has(agent.id)) continue
    const accounts = bound.filter((a) => a.agentId === agent.id)
    if (accounts.length === 0) result.push(entry(agent, null))
    else for (const acc of accounts) result.push(entry(agent, acc))
  }
  return result
}

function entry(agent: AgentDefinition, account: AgentAccount | null): EffectiveAgent {
  return {
    key: effectiveAgentKey(agent.id, account?.id ?? null),
    agent,
    account,
    label: account ? `${agent.name} - ${account.name}` : agent.name
  }
}
