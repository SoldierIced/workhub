// Reconnection pacing, shared by the desktop and the device so both come back the same way.

export const RECONNECT_BASE_MS = 1000
export const RECONNECT_MAX_MS = 30_000

/** Exponential backoff from 1 s to 30 s with up to 25% jitter; `random` in [0, 1). */
export function reconnectDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 10)))
  return Math.round(base * (1 + 0.25 * (random() * 2 - 1)))
}
