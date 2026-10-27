/**
 * Usage budgets per agent account (ported from usageChecker's `budget.py`): a ceiling per quota
 * window, and a warning margin below it. Everything here is pure (the clock is passed in), so
 * "past the ceiling", "inside the margin" and "usage unknown" are testable without an account.
 *
 * Fail open, always: no ceiling, no reading, an unknown window or a window that has reset since
 * it was read all resolve to `allow`. A gate that fails closed on a network blip keeps the user
 * away from their own agent until a window resets hours later; overspending is recoverable.
 */
import type { PlanUsageWindow } from '../domain/monitor'

/** Agents whose plan usage Workhub reads per account. */
export const USAGE_AGENTS = ['claude', 'codex'] as const
export type UsageAgentId = (typeof USAGE_AGENTS)[number]

export const DEFAULT_WARN_MARGIN = 5
export const DEFAULT_ALERT_THRESHOLDS: readonly number[] = [80, 95]

/** The budget settings in the app options (Settings → Usage). */
export interface UsageBudgetOptions {
  /** OS notifications when a window crosses an alert threshold or its ceiling, once per window reset. */
  alerts: boolean
  /** Alert thresholds in percent, for every window of every account. */
  thresholds: number[]
  /** How many points below a ceiling the warning starts. */
  warnMargin: number
  /** Ceiling in percent per account key (`usageAccountKey`) and window (`5h`, `weekly`…). */
  ceilings: Record<string, Record<string, number>>
}

export const DEFAULT_USAGE_BUDGET: UsageBudgetOptions = { alerts: true, thresholds: [...DEFAULT_ALERT_THRESHOLDS], warnMargin: DEFAULT_WARN_MARGIN, ceilings: {} }

/**
 * The key a budget is stored under: the agent id the account belongs to, then `:accountId`;
 * the agent's default folder (no account) is the bare agent id. Same shape as an automation's
 * `agentKey`, so `claude:work` names the same account in both places.
 */
export function usageAccountKey(agentId: string, accountId: string | null | undefined): string {
  return accountId ? `${agentId}:${accountId}` : agentId
}

export type BudgetAction = 'allow' | 'warn' | 'block'

export interface BudgetStatus {
  action: BudgetAction
  /** The window that decides: the one past its ceiling, or the one closest to it. */
  window?: string
  percent?: number
  ceiling?: number
  /** When the deciding window resets (epoch ms), when known. */
  resetsAt?: number
}

const ALLOW: BudgetStatus = { action: 'allow' }

/** A ceiling usable for gating: a finite number in (0, 100]. Anything else means "no ceiling". */
export function validCeiling(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100 ? value : null
}

/**
 * Windows still current at `now`: a window whose reset time has passed was read before the reset,
 * so its percentage no longer applies (it is back near zero) and must not keep a gate closed.
 */
export function liveWindows(windows: readonly PlanUsageWindow[], now: number): PlanUsageWindow[] {
  return windows.filter((w) => Number.isFinite(w.percent) && (w.resetsAt === undefined || w.resetsAt > now))
}

/**
 * The budget verdict of one account. A window past its ceiling blocks (the one that stays
 * blocked longest decides); otherwise a window inside the margin warns (the one with the least
 * headroom decides). Windows without a ceiling never gate: a 5 h window meant to be spent must
 * not stop work when only the weekly one is capped.
 */
export function evaluateBudget(
  windows: readonly PlanUsageWindow[],
  ceilings: Readonly<Record<string, number>> | undefined,
  warnMargin: number,
  now: number
): BudgetStatus {
  if (!ceilings) return ALLOW
  const margin = Number.isFinite(warnMargin) ? Math.max(0, warnMargin) : DEFAULT_WARN_MARGIN
  let block: BudgetStatus | null = null
  let blockUntil = Number.NEGATIVE_INFINITY
  let warn: BudgetStatus | null = null
  let warnHeadroom = Number.POSITIVE_INFINITY
  for (const w of liveWindows(windows, now)) {
    const ceiling = validCeiling(ceilings[w.window])
    if (ceiling === null) continue
    const status: BudgetStatus = { action: 'allow', window: w.window, percent: w.percent, ceiling, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}) }
    if (w.percent >= ceiling) {
      // The block that lasts longest is the one to report; an unknown reset counts as the longest.
      const until = w.resetsAt ?? Number.POSITIVE_INFINITY
      if (!block || until > blockUntil) {
        block = { ...status, action: 'block' }
        blockUntil = until
      }
    } else if (w.percent >= Math.max(0, ceiling - margin) && ceiling - w.percent < warnHeadroom) {
      warn = { ...status, action: 'warn' }
      warnHeadroom = ceiling - w.percent
    }
  }
  return block ?? warn ?? ALLOW
}

/** Who sends the prompt: the user from the composer, or an automation / Slack wake. */
export type PromptOrigin = 'user' | 'automation'

export type PromptGateVerdict =
  /** Send it. A `warn` status still sends; the UI shows the warning. */
  | { kind: 'send'; status: BudgetStatus }
  /** The user must confirm with "send anyway" (one shot). */
  | { kind: 'confirm'; status: BudgetStatus }
  /** Automatic work waits until the window resets or the ceiling is raised or cleared. */
  | { kind: 'pause'; status: BudgetStatus }

/**
 * Workhub's gate for one prompt (usageChecker's hook, moved inside Workhub): over the ceiling a
 * prompt typed by the user needs an explicit "send anyway", and automatic work pauses. `override`
 * is the one-shot escape (usage-override): "send anyway" in the composer, "Run now" for an
 * automation. It lets that one prompt through and changes nothing stored.
 */
export function gatePrompt(status: BudgetStatus, origin: PromptOrigin, override = false): PromptGateVerdict {
  if (status.action !== 'block' || override) return { kind: 'send', status }
  return origin === 'user' ? { kind: 'confirm', status } : { kind: 'pause', status }
}

/** The budget verdict of one account from the options and its latest windows. */
export function accountBudgetStatus(budget: UsageBudgetOptions, key: string, windows: readonly PlanUsageWindow[], now: number): BudgetStatus {
  return evaluateBudget(windows, budget.ceilings[key], budget.warnMargin, now)
}

/**
 * Raises, lowers or clears (null) one ceiling, returning new options. An account left without
 * ceilings is removed from the map, so a cleared budget leaves no trace in the config.
 */
export function setCeiling(budget: UsageBudgetOptions, key: string, window: string, value: number | null): UsageBudgetOptions {
  const own = { ...budget.ceilings[key] }
  const ceiling = value === null ? null : validCeiling(Math.round(value))
  if (ceiling === null) delete own[window]
  else own[window] = ceiling
  const ceilings = { ...budget.ceilings }
  if (Object.keys(own).length) ceilings[key] = own
  else delete ceilings[key]
  return { ...budget, ceilings }
}

/** Alert thresholds from user text ("80, 95"): integers in 1..100, sorted, without repeats. */
export function parseThresholds(text: string): number[] {
  const values = text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((s) => Math.round(Number(s)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 100)
  return [...new Set(values)].sort((a, b) => a - b)
}
