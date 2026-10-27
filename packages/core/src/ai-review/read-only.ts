import type { AgentDefinition } from '../domain/agent'
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

/**
 * How a reviewer agent is kept from changing anything: `mode` when the agent has a read-only
 * permission mode (Claude native and ACP agents with permission modes), `refusals` when the only
 * guard is Workhub refusing every permission request (persona agents such as Kiro and OpenCode).
 * An agent set up to trust everything can edit in the second case.
 */
export function readOnlyGuard(agent: Pick<AgentDefinition, 'adapter' | 'modeSemantics'>): 'mode' | 'refusals' {
  return agent.adapter === 'native' || agent.modeSemantics === 'permission' ? 'mode' : 'refusals'
}

/** The invalid push URL given to every remote of a review session. */
export const NO_PUSH_URL = 'no-push://workhub-review'

/**
 * Environment that makes `git push` fail in a reviewer session without touching the repository's
 * configuration (git reads `GIT_CONFIG_COUNT/KEY_n/VALUE_n` as the highest-precedence config):
 * every remote gets an invalid `pushurl`, and an empty `pushInsteadOf` prefix rewrites any other
 * push URL (a `git push <url>` typed by hand) to the same invalid one. Fetching is unaffected.
 * `inherited` is the environment the session would otherwise inherit: entries it already defines
 * through the same mechanism are kept (the new ones are numbered after them).
 */
export function pushBlockEnv(remotes: readonly string[], inherited: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const first = Number.parseInt(inherited['GIT_CONFIG_COUNT'] ?? '0', 10)
  const start = Number.isInteger(first) && first > 0 ? first : 0
  const entries: [string, string][] = [...remotes.map((r): [string, string] => [`remote.${r}.pushurl`, NO_PUSH_URL]), [`url.${NO_PUSH_URL}/.pushInsteadOf`, '']]
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + entries.length) }
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key
    env[`GIT_CONFIG_VALUE_${start + i}`] = value
  })
  return env
}
