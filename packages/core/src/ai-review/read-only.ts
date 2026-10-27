import type { SessionModeOption } from '../domain/session'

/** Mode ids agents use for "read and plan, do not change anything", most specific first. */
const READ_ONLY_MODES = ['read-only', 'readonly', 'read_only', 'plan', 'ask']

/**
 * The most read-only mode an agent offers among its permission modes (Claude over ACP: `plan`;
 * Codex: `read-only`), or undefined when it has none. Persona modes (Kiro) are not permission
 * modes and are left alone by the caller.
 */
export function readOnlyModeId(modes: readonly SessionModeOption[]): string | undefined {
  for (const id of READ_ONLY_MODES) {
    const found = modes.find((m) => m.id.toLowerCase() === id)
    if (found) return found.id
  }
  return undefined
}

/** The permission option that refuses a tool call (`reject_once` first); undefined to cancel the request instead. */
export function rejectOption(options: readonly { optionId: string; kind: string }[]): string | undefined {
  return (options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind.startsWith('reject')))?.optionId
}
