import { accountAgentId, usageAccountKey, type AgentAccount, type AgentDefinition } from '@workhub/core'
import type { AccountUsage } from '@shared/api'
import { en } from '../i18n/en'
import type { MessageKey } from '../i18n/translate'

/** The message that tells how to install an agent: one per known agent, else a generic one. */
export function installHintKey(agentId: string): MessageKey {
  const key = `agent.install.${agentId}`
  return key in en ? (key as MessageKey) : 'agent.install.generic'
}

/** The message that says which environment variables an account of an agent usually sets, if any. */
export function accountEnvHintKey(agentId: string): MessageKey | null {
  const key = `settings.envHint.${agentId}`
  return key in en ? (key as MessageKey) : null
}

/** How Workhub drives an agent: the Claude Agent SDK in-process, the agent's ACP server, or a plain terminal. */
export type AgentEngine = 'sdk' | 'acp' | 'terminal'

export function agentEngine(agent: Pick<AgentDefinition, 'adapter'>): AgentEngine {
  return agent.adapter === 'native' ? 'sdk' : agent.adapter === 'acp' ? 'acp' : 'terminal'
}

/** What a usage read says about a sign-in: read fine, failed (with why), or not read. */
export type LoginState = { state: 'ok' } | { state: 'error'; error: string } | { state: 'unknown' }

function loginOf(reads: readonly AccountUsage[], agentId: string, accountId: string | null): LoginState {
  const read = reads.find((r) => r.key === usageAccountKey(agentId, accountId))
  if (!read) return { state: 'unknown' }
  if (read.windows.length) return { state: 'ok' }
  return read.error ? { state: 'error', error: read.error } : { state: 'unknown' }
}

/** One agent in Settings → Agents: how it runs, whether it is installed, and its sign-ins. */
export interface AgentDirectoryEntry {
  agent: AgentDefinition
  engine: AgentEngine
  /** Undefined until the check answers. */
  installed: boolean | undefined
  /** The agent whose accounts this one uses (Claude Code over ACP uses Claude Code's). */
  sharesAccountsOf?: AgentDefinition
  /** The agent's own accounts, each with what the usage read says about its sign-in. */
  accounts: { account: AgentAccount; login: LoginState }[]
  /** The agent's default sign-in (sessions without an account; Kiro's only one). */
  defaultLogin: LoginState
}

/**
 * Every known agent for Settings → Agents, with agents that use another one's accounts (Claude
 * Code over ACP) right after that agent, so each Claude account's two engines read as one family.
 */
export function agentDirectory(
  agents: readonly AgentDefinition[],
  accounts: readonly AgentAccount[],
  reads: readonly AccountUsage[],
  availability: Readonly<Record<string, boolean>> | null
): AgentDirectoryEntry[] {
  const entry = (agent: AgentDefinition): AgentDirectoryEntry => {
    const owner = accountAgentId(agent)
    const shares = agent.accountsOf ? agents.find((a) => a.id === agent.accountsOf) : undefined
    return {
      agent,
      engine: agentEngine(agent),
      installed: availability ? availability[agent.id] : undefined,
      ...(shares ? { sharesAccountsOf: shares } : {}),
      accounts: shares ? [] : accounts.filter((a) => a.agentId === owner).map((account) => ({ account, login: loginOf(reads, owner, account.id) })),
      defaultLogin: loginOf(reads, owner, null)
    }
  }
  const out: AgentDirectoryEntry[] = []
  for (const agent of agents.filter((a) => !a.accountsOf || !agents.some((b) => b.id === a.accountsOf))) {
    out.push(entry(agent))
    for (const variant of agents.filter((a) => a.accountsOf === agent.id)) out.push(entry(variant))
  }
  return out
}
