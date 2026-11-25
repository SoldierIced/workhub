import { resumesBySessionId, type EffectiveAgent, type GroupMember } from '@workhub/core'
import type { StartSessionInput } from '../../shared/api'

/** The member's profile no longer offers its agent (or account): nothing to reopen it with. */
export class ReopenAgentMissing extends Error {
  constructor(readonly agent: string) {
    super(agent)
    this.name = 'ReopenAgentMissing'
  }
}

export type ReopenInput = Pick<StartSessionInput, 'profileId' | 'agentKey' | 'cwd' | 'resumeAgentSessionId' | 'identity'>

/**
 * What reopening a closed sidebar member starts, on the desktop and on a paired phone. Its agent is
 * looked up in the member's own profile, not the active one: a session moved to another account may
 * run on an account only that profile offers. Resumed by its id when its agent can; when the agent
 * is gone from Workhub it throws instead of starting a new, unrelated conversation under the member's row.
 */
export async function reopenInput(member: GroupMember, activeProfileId: string | null, agentsOf: (profileId: string | null) => Promise<EffectiveAgent[]>): Promise<ReopenInput> {
  const profileId = member.profileId ?? activeProfileId
  // A session can run on an account its profile does not offer (resumed from History): main resolves
  // that account from the whole config, so only an agent Workhub does not know at all is missing.
  const agentId = member.agentKey.split(':')[0]
  const choice = (await agentsOf(profileId)).find((a) => a.key === member.agentKey) ?? (await agentsOf(null)).find((a) => a.agent.id === agentId)
  if (!choice) throw new ReopenAgentMissing(member.agentName ?? member.agentKey)
  return {
    profileId,
    agentKey: member.agentKey,
    cwd: member.cwd,
    ...(resumesBySessionId(choice.agent) ? { resumeAgentSessionId: member.key } : { identity: member.key })
  }
}
