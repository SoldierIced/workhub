import { accountAgentId, knownAgents, type AgentDefinition, type SessionHistorySource, type WorkhubConfig } from '@workhub/core'
import type { HistoryItem, HistoryResult } from '../shared/api'
import { claudeAccounts } from './claude-accounts'

/** One place an agent keeps sessions: its default folder (`accountId` null) or an account's config folder. */
export interface HistoryAccountRef {
  accountId: string | null
  /** Empty for the default folder. */
  name: string
  configDir?: string
}

/**
 * The folders to list for an agent. Claude: its accounts plus the default folder. Agents with a
 * per-account config folder (Codex): the default folder plus each account that sets one. Agents
 * with a single data folder (Kiro, OpenCode): that folder once.
 */
export function historyAccounts(config: WorkhubConfig, agent: AgentDefinition, home: string): HistoryAccountRef[] {
  if (agent.id === 'claude') return claudeAccounts(config, home)
  const refs: HistoryAccountRef[] = [{ accountId: null, name: '' }]
  if (!agent.accountConfigEnv) return refs
  for (const a of config.accounts) {
    if (a.agentId === accountAgentId(agent) && a.configDir) refs.push({ accountId: a.id, name: a.name, configDir: a.configDir })
  }
  return refs
}

/** Whether a past session of the agent can be opened again from the history. */
export function canResume(agent: AgentDefinition): boolean {
  return agent.adapter === 'native' || agent.console !== undefined
}

/**
 * Every past session of every known agent that has a history source, newest first. An agent or
 * account that fails is reported, not fatal.
 */
export async function listAllHistory(config: WorkhubConfig, home: string, sources: Partial<Record<string, SessionHistorySource>>): Promise<HistoryResult> {
  const result: HistoryResult = { entries: [], errors: [] }
  const agents = knownAgents(config).filter((a) => a.capabilities.history && !a.accountsOf && sources[a.id])
  await Promise.all(
    agents.flatMap((agent) =>
      historyAccounts(config, agent, home).map(async (a) => {
        try {
          const entries = await sources[agent.id]!.list({ agentId: agent.id, accountId: a.accountId, configDir: a.configDir })
          const resumable = canResume(agent)
          result.entries.push(...entries.map((e): HistoryItem => ({ ...e, agentName: agent.name, resumable, accountName: a.name || undefined })))
        } catch (err) {
          // Claude names its accounts in the message; the other agents say which agent failed.
          const label = agent.id === 'claude' ? a.name : [agent.name, a.name].filter(Boolean).join(' - ')
          result.errors.push({ account: label, message: err instanceof Error ? err.message : String(err) })
        }
      })
    )
  )
  result.entries.sort((x, y) => y.lastModified - x.lastModified)
  return result
}
