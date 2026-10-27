import { join, resolve } from 'node:path'
import { accountAgentId, knownAgents, launchEnvironment, type AgentAccount, type WorkhubConfig } from '@workhub/core'

export interface ClaudeAccountRef {
  /** Null: Claude Code's own default folder, used by sessions without an account. */
  accountId: string | null
  /** Empty for the default folder; the renderer names it. */
  name: string
  configDir?: string
}

/**
 * Every Claude config folder Workhub knows: each Claude account, plus the default folder
 * (`CLAUDE_CONFIG_DIR` or `~/.claude`) unless an account already is it. One entry per folder.
 */
export function claudeAccounts(config: WorkhubConfig, home: string, envConfigDir = process.env['CLAUDE_CONFIG_DIR']): ClaudeAccountRef[] {
  const defaultDir = resolve(envConfigDir || join(home, '.claude'))
  const seen = new Set<string>()
  const out: ClaudeAccountRef[] = []
  for (const a of config.accounts.filter((x) => x.agentId === accountAgentId({ id: 'claude' }))) {
    const dir = a.configDir ? resolve(a.configDir) : defaultDir
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push({ accountId: a.id, name: a.name, configDir: a.configDir })
  }
  if (!seen.has(defaultDir)) out.unshift({ accountId: null, name: '' })
  return out
}

/**
 * The Claude config folder a session of this account gets, resolved: the account's own folder
 * (its `configDir`, or `CLAUDE_CONFIG_DIR` in its env), else the Claude agent's env, else
 * Workhub's own `CLAUDE_CONFIG_DIR`, else `~/.claude`. Two accounts with the same folder are the
 * same Claude login.
 */
export function claudeConfigDirOf(config: WorkhubConfig, account: AgentAccount | null, home: string, env: NodeJS.ProcessEnv = process.env): string {
  const agent = knownAgents(config).find((a) => a.id === 'claude')
  const own = agent ? launchEnvironment(agent, account)['CLAUDE_CONFIG_DIR'] : account?.configDir
  return resolve(own || env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'))
}
