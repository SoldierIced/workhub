import { join, resolve } from 'node:path'
import { accountAgentId, type WorkhubConfig } from '@workhub/core'

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
