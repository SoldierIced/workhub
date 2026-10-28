import { pickAgent, profileDefaultFolder, type EffectiveAgent, type Profile } from '@workhub/core'

/** What "New session" starts without asking: the profile's preferred agent in its default folder. */
export interface QuickSessionPlan {
  agentKey: string
  agentLabel: string
  /** Absolute, home expanded. */
  cwd: string
}

/**
 * The agent and folder of a one-click new session: `agentKey` when given (the menu's per-agent
 * items), else the profile's first preferred agent; the profile's default folder, else its first
 * folder, else the home folder. Null when there is no agent or no folder to start in.
 */
export function quickSessionPlan(
  profile: Pick<Profile, 'preferredAgents' | 'folders' | 'defaultFolder'> | undefined,
  agents: readonly EffectiveAgent[],
  home: string | undefined,
  agentKey?: string
): QuickSessionPlan | null {
  const agent = agentKey ? agents.find((a) => a.key === agentKey) : pickAgent(profile, agents, 'any')
  const cwd = profileDefaultFolder(profile, home) ?? home
  if (!agent || !cwd) return null
  return { agentKey: agent.key, agentLabel: agent.label, cwd }
}
