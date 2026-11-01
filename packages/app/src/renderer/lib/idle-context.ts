import type { ContextUsage, Money } from '@workhub/core'
import type { ChatItem } from '../store'

/**
 * Agents cache the conversation's prompt for a while (Claude: 5 minutes or 1 hour, renewed by each
 * request). Past that, the next message sends the whole context again at full price instead of a
 * cheap cache read. Claude's transcript says when its cache expires; for an agent that does not,
 * the notice guesses from the shortest lifetime.
 */
export const CACHE_LIFETIME_MS = 5 * 60_000
/** Below this context size a cold resend costs little; no notice. */
export const MIN_CONTEXT_TOKENS = 20_000
/** With a known cost, a resend under this many US dollars is not worth a notice (a cheap model's large context). */
export const MIN_COLD_COST_USD = 0.05

export interface IdleContext {
  idleMs: number
  /** The agent reported when its cache expires: the notice says it expired, not that it likely did. */
  expired: boolean
  /** How long ago the cache expired, when known. */
  expiredForMs?: number
  tokens: number
  coldCost?: Money
  warmCost?: Money
}

/** When the conversation last moved: the newest timestamp among its items. */
export function lastActivityAt(items: readonly ChatItem[]): number | undefined {
  let last: number | undefined
  for (const i of items) if ('at' in i && i.at !== undefined && (last === undefined || i.at > last)) last = i.at
  return last
}

/** What reviving an idle conversation costs, when it has been idle past the cache lifetime with a large context. */
export function idleContext(lastAt: number | undefined, now: number, context: ContextUsage | undefined): IdleContext | undefined {
  const tokens = context?.used
  if (lastAt === undefined || tokens === undefined || tokens < MIN_CONTEXT_TOKENS) return undefined
  const cold = context?.coldCost
  if (cold?.currency === 'USD' && cold.amount < MIN_COLD_COST_USD) return undefined
  const expiresAt = context?.cacheExpiresAt
  // With a reported expiry, idle counts from the last request (items added on resume carry the current time).
  const idleMs = now - (expiresAt !== undefined && context?.cacheTtlMs !== undefined ? expiresAt - context.cacheTtlMs : lastAt)
  if (expiresAt !== undefined ? now < expiresAt : idleMs < CACHE_LIFETIME_MS) return undefined
  const costs = { ...(context?.coldCost ? { coldCost: context.coldCost } : {}), ...(context?.warmCost ? { warmCost: context.warmCost } : {}) }
  return expiresAt !== undefined ? { idleMs, expired: true, expiredForMs: now - expiresAt, tokens, ...costs } : { idleMs, expired: false, tokens, ...costs }
}
