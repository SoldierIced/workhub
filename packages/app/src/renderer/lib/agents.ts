import { accountAgentId, usageAccountKey, type AgentAccount, type AgentDefinition, type PlanUsageWindow } from '@workhub/core'
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

export type AgentGlyph = 'claude' | 'kiro' | 'codex' | 'opencode' | 'gemini' | 'shell' | 'generic'

const SHELLS = new Set(['shell', 'terminal', 'bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell'])

/**
 * Which mark an agent gets. Accepts an agent id or an `agent:account` key; ids such as
 * `claude-acp` map to their family. A terminal agent that is not a known one is a shell.
 */
export function agentGlyph(agentId: string, adapter?: string): AgentGlyph {
  const id = agentId.split(':')[0]!.toLowerCase()
  for (const family of ['claude', 'kiro', 'codex', 'opencode', 'gemini'] as const) if (id === family || id.startsWith(`${family}-`)) return family
  if (SHELLS.has(id) || adapter === 'terminal') return 'shell'
  return 'generic'
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

/** Ids of the sign-in entries in the accounts list; never an account id (those cannot hold `:`). */
export const SIGN_IN_ID_PREFIX = 'sign-in:'

/** How an agent signs in without an account: Kiro once per computer, Claude and Codex in a default folder, others on their own. */
export type SignInKind = 'onePerComputer' | 'folder' | 'generic'

/** An agent's own sign-in on this computer (sessions without an account use it), for the accounts list. */
export interface SignInEntry {
  id: string
  agent: AgentDefinition
  kind: SignInKind
  /** What the usage read says about it; unknown while its reading is off or has not run. */
  login: LoginState
  /** Undefined until the check answers. */
  installed: boolean | undefined
  /** The windows of its latest usage read (Kiro: the monthly credits). */
  windows: PlanUsageWindow[]
  /** The plan's name, when the agent reports it (Kiro). */
  plan?: string
}

/** The default folder of an agent that keeps its sign-in in one (`~/.claude`, `~/.codex`). */
export function defaultSignInFolder(agent: Pick<AgentDefinition, 'id' | 'accountConfigEnv'>): string | undefined {
  return agent.accountConfigEnv ? `~/.${agent.id}` : undefined
}

/**
 * One sign-in entry per agent that signs in at all (not a terminal, not one that uses another
 * agent's accounts), so every agent is in the accounts list, Kiro included (its only sign-in).
 */
export function signInEntries(agents: readonly AgentDefinition[], reads: readonly AccountUsage[], availability: Readonly<Record<string, boolean>> | null): SignInEntry[] {
  return agents
    .filter((a) => a.adapter !== 'terminal' && !(a.accountsOf && agents.some((b) => b.id === a.accountsOf)))
    .map((agent) => {
      const owner = accountAgentId(agent)
      const read = reads.find((r) => r.key === usageAccountKey(owner, null))
      const plan = read?.windows.find((w) => w.plan)?.plan
      return {
        id: `${SIGN_IN_ID_PREFIX}${agent.id}`,
        agent,
        kind: owner === 'kiro' ? 'onePerComputer' : agent.accountConfigEnv ? 'folder' : 'generic',
        login: loginOf(reads, owner, null),
        installed: availability ? availability[agent.id] : undefined,
        windows: read?.windows ?? [],
        ...(plan ? { plan } : {})
      }
    })
}

export type AccountListItem = { id: string; kind: 'signIn'; signIn: SignInEntry } | { id: string; kind: 'account'; account: AgentAccount }

/**
 * The accounts list of Settings → Agents: per agent, its sign-in on this computer and then its
 * accounts; accounts of agents not in the list (removed from the config) come last.
 */
export function accountListItems(signIns: readonly SignInEntry[], accounts: readonly AgentAccount[]): AccountListItem[] {
  const out: AccountListItem[] = []
  const placed = new Set<string>()
  for (const s of signIns) {
    out.push({ id: s.id, kind: 'signIn', signIn: s })
    for (const account of accounts.filter((a) => a.agentId === accountAgentId(s.agent))) {
      out.push({ id: account.id, kind: 'account', account })
      placed.add(account.id)
    }
  }
  for (const account of accounts) if (!placed.has(account.id)) out.push({ id: account.id, kind: 'account', account })
  return out
}
