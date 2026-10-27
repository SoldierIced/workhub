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
