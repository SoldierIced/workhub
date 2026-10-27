/**
 * The event ledger: which chat events already fired something, so one event fires at most one
 * run. It is keyed by the event itself (channel and timestamps), not by the profile or account
 * that read it, and it is persisted, so a restart, a second profile or another account reading
 * the same channel never fires the same event again.
 */

export interface LedgerEntry {
  /** Epoch milliseconds of the claim. */
  at: number
  /** Who claimed it (an automation id, or `wake`). */
  by: string
}

export type EventLedger = Record<string, LedgerEntry>

/**
 * The key of a chat event: `channel:ts` for a top-level message, `channel:thread_ts:ts` for a
 * reply in a thread.
 */
export function chatEventKey(channelId: string, ts: string, threadTs?: string): string {
  return threadTs && threadTs !== ts ? `${channelId}:${threadTs}:${ts}` : `${channelId}:${ts}`
}

/** Claims an event for `by`. `claimed` is false when it was claimed before, by anyone. */
export function claimEvent(ledger: EventLedger, key: string, by: string, now: number): { ledger: EventLedger; claimed: boolean } {
  if (ledger[key]) return { ledger, claimed: false }
  return { ledger: { ...ledger, [key]: { at: now, by } }, claimed: true }
}

/** Entries are kept 30 days; the newest 5000 at most. */
export const LEDGER_MAX_AGE_MS = 30 * 86_400_000
export const LEDGER_MAX_ENTRIES = 5000

/**
 * Drops old entries. Watched channels are read from a cursor that only moves forward, so an
 * event older than a month is never offered again.
 */
export function pruneLedger(ledger: EventLedger, now: number, maxAgeMs = LEDGER_MAX_AGE_MS, maxEntries = LEDGER_MAX_ENTRIES): EventLedger {
  const kept = Object.entries(ledger)
    .filter(([, e]) => now - e.at < maxAgeMs)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, maxEntries)
  return kept.length === Object.keys(ledger).length ? ledger : Object.fromEntries(kept)
}
