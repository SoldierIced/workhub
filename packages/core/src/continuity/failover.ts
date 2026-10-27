/**
 * Account failover: a Claude session whose account ran out of usage continues under another
 * Claude account of the profile, with the same session id (its transcript is copied to the other
 * account's folder, then resumed there). Pure: the caller passes the budgets and the clock, so
 * "which account next" and "ask, switch or do nothing" are testable without an account.
 */
import { accountAgentId, type AgentAccount } from '../domain/agent'
import type { Profile } from '../domain/profile'
import type { BudgetStatus } from '../usage/budget'
import type { EffectiveAgent } from '../usecases/effective-agents'
import { orderAgents } from '../usecases/pick-agent'

/**
 * What happens when a Claude account runs out (per profile, Settings → Profiles):
 * - `ask`: the chat offers "Continue in <account>", "Hand off to <agent>" or "Wait".
 * - `automatic`: the session moves to the next account under its ceilings by itself.
 * - `off`: nothing is offered; the usage gate and the agent's own message stay as they are.
 */
export const FAILOVER_MODES = ['ask', 'automatic', 'off'] as const
export type FailoverMode = (typeof FAILOVER_MODES)[number]
export const DEFAULT_FAILOVER_MODE: FailoverMode = 'ask'

export function failoverMode(profile: Pick<Profile, 'accountFailover'> | null | undefined): FailoverMode {
  const mode = profile?.accountFailover
  return mode && (FAILOVER_MODES as readonly string[]).includes(mode) ? mode : DEFAULT_FAILOVER_MODE
}

/**
 * Why a session is moving:
 * - `limit`: the agent reported a usage or rate limit (the turn failed).
 * - `ceiling`: Workhub's own usage gate blocked a prompt (the account is past the user's ceiling).
 * - `manual`: the user picked "Continue in another account".
 */
export type FailoverReason = 'limit' | 'ceiling' | 'manual'

/** The usage limit an agent reported, as far as it said. */
export interface UsageLimitInfo {
  /** `5h`, `weekly`…, when the agent named the window. */
  window?: string
  /** Epoch ms, when the agent said when it resets. */
  resetsAt?: number
}

/**
 * Text of a usage or rate limit message from Claude Code or the Agent SDK ("Claude AI usage limit
 * reached|1760000000", "You've hit your limit · resets 3pm", "5-hour limit reached ∙ resets 4am",
 * "API Error: 429 … rate_limit_error"). Context-window and budget limits do not count: another
 * account would hit them just the same.
 */
const LIMIT_TEXT = [
  /\busage limit (?:reached|was reached|has been reached)\b/i,
  /\bclaude ai usage limit\b/i,
  /\byou(?:'|’)ve (?:hit|reached) your (?:[\w-]+ )?(?:usage |session |weekly |plan )?limit\b/i,
  /\b(?:5-hour|five-hour|session|weekly|opus|sonnet) limit reached\b/i,
  /\brate_limit_error\b/i,
  /\b429\b.{0,80}\brate limit/i
]
const NOT_A_USAGE_LIMIT = /\b(?:context|budget|size|recursion|max[_ ]turns?|output token|spend) limit\b/i

export function isUsageLimitText(text: string | undefined | null): boolean {
  if (!text) return false
  const head = text.slice(0, 2000)
  if (NOT_A_USAGE_LIMIT.test(head) && !/\busage limit\b/i.test(head)) return false
  return LIMIT_TEXT.some((re) => re.test(head))
}

/** The reset time in "Claude AI usage limit reached|<epoch seconds>" (older CLIs), when present. */
export function limitResetFromText(text: string): number | undefined {
  const m = /usage limit reached\|(\d{9,13})/i.exec(text)
  if (!m) return undefined
  const n = Number(m[1])
  return n > 1e11 ? n : n * 1000
}

/** A Claude account the session could continue in. */
export interface FailoverCandidate {
  key: string
  label: string
  accountId: string | null
  /** The verdict of its usage budget now (`allow` when unknown: fail open). */
  budget: BudgetStatus
}

export interface FailoverSource {
  /** The session's agent (`claude`). */
  agentId: string
  accountId: string | null
  /** The source account's resolved config folder; another account with the same folder is the same login. */
  configDir: string
}

/**
 * The Claude accounts of the profile a session can move to, in the profile's order of preference
 * (`preferredAgents`, as `pickAgent` uses it): same agent, another account with its own config
 * folder, not blocked by its budget and not known to be out of usage right now (`limitedUntil`,
 * accounts that reported a limit, by key, until their reset). An unknown usage never excludes an
 * account (fail open, as the gate does).
 */
export function failoverTargets(input: {
  profile: Pick<Profile, 'preferredAgents'> | null | undefined
  candidates: readonly EffectiveAgent[]
  source: FailoverSource
  /** The config folder an account's sessions get (resolved). */
  configDirOf: (account: AgentAccount | null) => string
  budgetOf: (agentId: string, accountId: string | null) => BudgetStatus
  limitedUntil?: Readonly<Record<string, number>>
  now: number
}): FailoverCandidate[] {
  const { source } = input
  const usable = input.candidates.filter((e) => {
    if (e.agent.id !== source.agentId || accountAgentId(e.agent) !== 'claude') return false
    const accountId = e.account?.id ?? null
    if (accountId === source.accountId) return false
    if (input.configDirOf(e.account) === source.configDir) return false
    const until = input.limitedUntil?.[e.key]
    if (until !== undefined && until > input.now) return false
    return input.budgetOf(accountAgentId(e.agent), accountId).action !== 'block'
  })
  return orderAgents(input.profile?.preferredAgents, usable).map((e) => ({
    key: e.key,
    label: e.label,
    accountId: e.account?.id ?? null,
    budget: input.budgetOf(accountAgentId(e.agent), e.account?.id ?? null)
  }))
}

export type FailoverPlan =
  /** Move the session to `target` now. */
  | { kind: 'switch'; target: FailoverCandidate }
  /** Offer the choices in the chat; `target` is the account "Continue in" would use, when there is one. */
  | { kind: 'ask'; target?: FailoverCandidate }
  /** Nothing to do (mode off, or no account to offer and nothing else asked for). */
  | { kind: 'none'; reason: 'off' | 'noTarget' }

/**
 * What to do when an account runs out. `automatic` switches only when there is a target;
 * without one it falls back to asking, so the hand-off and "Wait" are still offered. A manual
 * request always switches when it can, whatever the mode.
 */
export function planFailover(mode: FailoverMode, reason: FailoverReason, targets: readonly FailoverCandidate[]): FailoverPlan {
  const target = targets[0]
  if (reason === 'manual') return target ? { kind: 'switch', target } : { kind: 'none', reason: 'noTarget' }
  if (mode === 'off') return { kind: 'none', reason: 'off' }
  if (mode === 'automatic' && target) return { kind: 'switch', target }
  return target ? { kind: 'ask', target } : { kind: 'ask' }
}

/** Where a session came from, shown in its chat ("Continued in …", "Handed off from …"). */
export interface SessionOrigin {
  kind: 'failover' | 'handoff'
  /** The session it continues: its label ("Claude - Personal") and identity. */
  fromLabel: string
  fromIdentity: string
  /** Failover: why it moved, and the window that ran out when known. */
  reason?: FailoverReason
  window?: string
}
