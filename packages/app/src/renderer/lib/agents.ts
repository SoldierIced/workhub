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
