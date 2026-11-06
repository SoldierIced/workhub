import { accountAgentId, liveWindows, orderAgents, usageAccountKey, type AgentDefinition, type EffectiveAgent } from '@workhub/core'
import type { AccountUsage } from '@shared/api'
import type { SelectOption } from '../components/atoms/Select'

/** The highest live window of an account's plan usage, rounded (`34` for 34 %); undefined when not read. */
export function usagePercent(reads: readonly AccountUsage[], agent: Pick<AgentDefinition, 'id' | 'accountsOf'>, accountId: string | null, now = Date.now()): number | undefined {
  const read = reads.find((r) => r.key === usageAccountKey(accountAgentId(agent), accountId))
  const windows = read ? liveWindows(read.windows, now) : []
  if (!windows.length) return undefined
  return Math.round(Math.max(...windows.map((w) => w.percent)))
}

/** The value of New session's last Agent item: it opens the profile's Agents tab instead of picking an agent. */
export const ORDER_AGENTS_OPTION = '__order-agents__'

/** Where Settings opens for a profile's agent order and offer (Profiles → the profile → Agents). */
export const profileAgentsTarget = (profileId: string): string => `profiles/${profileId}/agents`

type Translate = (key: 'newSession.agentDefault' | 'newSession.agentUsage' | 'newSession.orderAgents', vars: Record<string, string | number>) => string

/**
 * New session's Agent options: the profile's agents in its order (`orderAgents`), the first one
 * marked as the default, the others with their account's usage when it is known; then, when there
 * is a profile, an item that opens its order in Settings.
 */
export function newSessionAgentOptions(input: {
  agents: readonly EffectiveAgent[]
  preferredAgents: readonly string[] | undefined
  reads: readonly AccountUsage[]
  /** The label of each agent before the marks ("not installed" already added). */
  labelOf: (agent: EffectiveAgent) => string
  profile?: { id: string; name: string }
  t: Translate
  now?: number
}): (SelectOption & { agent?: EffectiveAgent })[] {
  const ordered = orderAgents(input.preferredAgents, input.agents)
  const options: (SelectOption & { agent?: EffectiveAgent })[] = ordered.map((a, i) => {
    const label = input.labelOf(a)
    if (i === 0) return { value: a.key, agent: a, label: input.t('newSession.agentDefault', { label }) }
    const percent = a.account ? usagePercent(input.reads, a.agent, a.account.id, input.now) : undefined
    return { value: a.key, agent: a, label: percent === undefined ? label : input.t('newSession.agentUsage', { label, percent }) }
  })
  if (input.profile) options.push({ value: ORDER_AGENTS_OPTION, label: input.t('newSession.orderAgents', { profile: input.profile.name || input.profile.id }) })
  return options
}
