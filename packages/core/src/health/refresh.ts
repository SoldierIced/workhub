import type { HealthProvider } from './provider'
import { makeSnapshot, unreachableSnapshot } from './snapshot'
import { emptySignals, HEALTH_SIGNALS, type HealthEnvironment, type HealthSignal, type HealthSignals, type HealthSnapshot, type HealthTier } from './types'

/** How long the heavier tiers stay cached (Workhub 1): the 14-day trends 30 minutes, the slow flows an hour. */
export const TREND_CACHE_MS = 30 * 60_000
export const SLOW_CACHE_MS = 60 * 60_000

/** The tiers due at `now`: the fast one on every poll, the others when their cache expired (or never ran). */
export function dueTiers(signals: Pick<HealthSignals, 'trendFetchedAt' | 'slowFetchedAt'> | undefined, now: number): HealthTier[] {
  const tiers: HealthTier[] = ['fast']
  if (signals?.trendFetchedAt === undefined || now - signals.trendFetchedAt >= TREND_CACHE_MS) tiers.push('trend')
  if (signals?.slowFetchedAt === undefined || now - signals.slowFetchedAt >= SLOW_CACHE_MS) tiers.push('slow')
  return tiers
}

/** The signals each tier owns, so a tier that was not read keeps its previous figures and failures. */
const TIER_SIGNALS: Record<HealthTier, readonly HealthSignal[]> = {
  fast: ['pods', 'reporting'],
  trend: ['errors', 'events'],
  slow: ['slow']
}

/** Folds a partial read into the previous signals: what the tiers read replaces, the rest stays. */
export function mergeSignals(previous: HealthSignals | undefined, read: Partial<HealthSignals>, tiers: readonly HealthTier[]): HealthSignals {
  const base = previous ?? emptySignals()
  const next: HealthSignals = { ...base, ...read, failures: { ...base.failures } }
  const owned = new Set(tiers.flatMap((t) => TIER_SIGNALS[t]))
  for (const signal of HEALTH_SIGNALS) {
    if (!owned.has(signal)) continue
    const failure = read.failures?.[signal]
    if (failure) next.failures[signal] = failure
    else delete next.failures[signal]
  }
  // A signal that failed keeps the figures of the last good read: the failure is a blind spot, not a zero.
  const keep = <K extends keyof HealthSignals>(signal: HealthSignal, ...keys: K[]) => {
    if (read.failures?.[signal] && owned.has(signal)) for (const k of keys) (next as unknown as Record<string, unknown>)[k] = base[k]
  }
  keep('pods', 'notReady', 'restarts', 'backOff')
  keep('reporting', 'reporting')
  keep('errors', 'errors')
  keep('events', 'events')
  keep('slow', 'slow')
  return next
}

export interface EnvironmentReading {
  signals: HealthSignals | undefined
  snapshot: HealthSnapshot
}

/**
 * Reads the due tiers of one environment and builds its snapshot. When the connection fails the
 * old figures stay, marked stale, under an `unreachable` verdict.
 */
export async function refreshEnvironment(
  provider: HealthProvider,
  env: HealthEnvironment,
  previous: EnvironmentReading | undefined,
  now: number
): Promise<EnvironmentReading> {
  const tiers = dueTiers(previous?.signals, now)
  try {
    const read = await provider.read(env, tiers, now)
    const stamps: Partial<HealthSignals> = {
      fastFetchedAt: now,
      ...(tiers.includes('trend') ? { trendFetchedAt: now } : {}),
      ...(tiers.includes('slow') ? { slowFetchedAt: now } : {})
    }
    const signals = mergeSignals(previous?.signals, { ...read, ...stamps }, tiers)
    return { signals, snapshot: makeSnapshot(env, signals) }
  } catch (error) {
    // Any failure, expected or not, reads as a lost connection: nothing is claimed healthy.
    const message = error instanceof Error ? error.message : String(error)
    return { signals: previous?.signals, snapshot: unreachableSnapshot(env.id, previous?.snapshot, message) }
  }
}
