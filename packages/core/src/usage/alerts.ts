/**
 * Usage alerts (ported from usageChecker's `alerts.py`): an edge-triggered state machine per
 * (account, window). Pure: no clock, no I/O, the input state is never mutated.
 *
 * Per (account, window), per reading:
 *  1. no reset time or no percentage → skip: nothing is created, changed or fired.
 *  2. unseen → tracked with nothing notified yet.
 *  3. the reset time moved (the window rolled over) → re-armed, nothing notified.
 *  4. the highest tier at or below the percentage, if above the highest already notified,
 *     fires ONE event and is stored. A jump from 10% to 97% fires once (95), never a burst.
 *
 * The notified tier only grows within a window: falling usage never re-arms, only a reset does.
 * The tiers are the alert thresholds plus the window's ceiling, so crossing a ceiling notifies
 * even when no threshold sits there.
 *
 * Unlike usageChecker, a reset counts only when the reset time moves by more than
 * `RESET_TOLERANCE_MS`: Codex reset times read from session files are derived from "resets in N
 * seconds" and drift a little between readings, which must not re-arm the alert every time.
 */
import type { PlanUsageWindow } from '../domain/monitor'
import { validCeiling } from './budget'

export const RESET_TOLERANCE_MS = 10 * 60_000

export interface UsageAlertEntry {
  /** Reset time of the window being tracked (epoch ms). */
  resetsAt: number
  /** Highest tier already notified in this window; 0 for none. */
  notified: number
}

/** Keyed by `${accountKey}::${window}`. */
export type UsageAlertState = Record<string, UsageAlertEntry>

export interface UsageAlertEvent {
  accountKey: string
  window: string
  /** The tier crossed. */
  threshold: number
  percent: number
  /** The tier is the window's ceiling (the budget is reached). */
  ceiling: boolean
  resetsAt: number
}

export interface UsageAlertReading {
  accountKey: string
  windows: readonly PlanUsageWindow[]
}

const SEPARATOR = '::'

export function usageAlertKey(accountKey: string, window: string): string {
  return `${accountKey}${SEPARATOR}${window}`
}

/** The tiers of one window: the thresholds plus its ceiling, as sorted unique integers in 1..100. */
export function alertTiers(thresholds: readonly number[], ceiling: number | undefined): number[] {
  const tiers = new Set<number>()
  for (const t of thresholds) if (Number.isFinite(t) && t >= 1 && t <= 100) tiers.add(Math.round(t))
  const c = validCeiling(ceiling)
  if (c !== null) tiers.add(c)
  return [...tiers].sort((a, b) => a - b)
}

/**
 * Applies one round of readings, returning a new state and the events to notify. Events are
 * returned even when alerts are off; dropping them is the caller's job, which keeps the state
 * warm so turning alerts on later does not fire a burst of stale notifications.
 */
export function evaluateUsageAlerts(
  state: UsageAlertState,
  readings: readonly UsageAlertReading[],
  thresholds: readonly number[],
  ceilings: Readonly<Record<string, Readonly<Record<string, number>>>> = {}
): { state: UsageAlertState; events: UsageAlertEvent[] } {
  const next: UsageAlertState = Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { ...v }]))
  const events: UsageAlertEvent[] = []
  for (const { accountKey, windows } of readings) {
    for (const w of windows) {
      if (w.resetsAt === undefined || !Number.isFinite(w.resetsAt) || !Number.isFinite(w.percent)) continue
      const key = usageAlertKey(accountKey, w.window)
      let entry = next[key]
      if (!entry || Math.abs(entry.resetsAt - w.resetsAt) > RESET_TOLERANCE_MS) {
        entry = { resetsAt: w.resetsAt, notified: 0 }
        next[key] = entry
      }
      const ceiling = ceilings[accountKey]?.[w.window]
      const tiers = alertTiers(thresholds, ceiling)
      const highest = tiers.filter((t) => w.percent >= t).pop() ?? 0
      if (highest > entry.notified) {
        entry.notified = highest
        events.push({ accountKey, window: w.window, threshold: highest, percent: w.percent, ceiling: validCeiling(ceiling) === highest, resetsAt: w.resetsAt })
      }
    }
  }
  return { state: next, events }
}

/** Drops the entries of accounts that no longer exist, so the state file does not grow forever. */
export function pruneUsageAlerts(state: UsageAlertState, accountKeys: Iterable<string>): UsageAlertState {
  const known = new Set(accountKeys)
  return Object.fromEntries(Object.entries(state).filter(([k]) => known.has(k.split(SEPARATOR)[0] ?? '')))
}

/** A state read from disk: anything malformed is dropped (losing it costs at most one repeated notification). */
export function parseUsageAlertState(raw: unknown): UsageAlertState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: UsageAlertState = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<UsageAlertEntry> | null
    if (e && typeof e.resetsAt === 'number' && typeof e.notified === 'number') out[k] = { resetsAt: e.resetsAt, notified: e.notified }
  }
  return out
}
