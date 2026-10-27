/**
 * Health notifications, as Workhub 1 sends them: what changed in an environment since its last
 * read. The first read of an environment has nothing to compare with and alerts nothing. Besides
 * the environment's state, a service that stops reporting, a pod that stops being ready (or starts
 * crash-looping) and an error signal that starts worsening are announced, each subject at most once
 * an hour (`admitHealthAlerts`).
 */
import type { HealthSignal, HealthSnapshot, HealthState } from '../health/types'

/** What an alert compares; a readout without `snapshot` only compares the state. */
export interface HealthReadout {
  id: string
  name: string
  state: HealthState
  snapshot?: Pick<HealthSnapshot, 'silentServices' | 'pods' | 'errorServices' | 'podVisibility' | 'blindSpots'>
  /** A worsening error signal is announced only from this many errors (the verdict's own minimum). */
  minErrorsToFlag?: number
  errorWindowHours?: number
}

export type HealthAlertKind = 'degraded' | 'recovered' | 'unreachable' | 'stoppedReporting' | 'podDown' | 'errorsWorsening'

export interface HealthAlert {
  environmentId: string
  environmentName: string
  kind: HealthAlertKind
  /** The service or pod the alert is about; empty for the environment, `+more` for a folded burst. */
  subject: string
  /** The subjects folded into a `+more` alert. */
  others?: string[]
  silentMinutes?: number
  crashLoop?: boolean
  /** Errors in the window, the window, and the times a typical day (worsening errors). */
  count?: number
  hours?: number
  factor?: number
}

/** What each environment is compared with next time. */
export interface HealthBaselineEntry {
  state: HealthState
  /** Subject lists, absent when the readout carried no snapshot. */
  silent?: string[]
  /** Pods not ready or crash-looping; absent when pods were not visible or not read. */
  downPods?: string[]
  worsening?: string[]
  /** Signals that could not be read on this read. */
  unread?: HealthSignal[]
}
export type HealthBaseline = Record<string, HealthBaselineEntry>

/** A burst (a bad rollout takes a dozen pods down at once) is announced one by one for the first few, then in one line. */
export const INDIVIDUAL_ALERT_LIMIT = 3

function capped(alerts: HealthAlert[]): HealthAlert[] {
  if (alerts.length <= INDIVIDUAL_ALERT_LIMIT) return alerts
  const first = alerts[0]!
  const rest = alerts.slice(INDIVIDUAL_ALERT_LIMIT).map((a) => a.subject)
  return [...alerts.slice(0, INDIVIDUAL_ALERT_LIMIT), { environmentId: first.environmentId, environmentName: first.environmentName, kind: first.kind, subject: '+more', others: rest }]
}

function entryOf(env: HealthReadout, state: HealthState): HealthBaselineEntry {
  const s = env.snapshot
  // A partial snapshot (an older cache, a test double) compares only the state.
  if (!s?.silentServices || !s.pods || !s.errorServices || !s.blindSpots) return { state }
  const unread = s.blindSpots.flatMap((b) => (b.code === 'unread' && b.signal ? [b.signal] : []))
  const minimum = env.minErrorsToFlag ?? 0
  return {
    state,
    unread,
    silent: s.silentServices.map((x) => x.service),
    downPods: s.podVisibility === 'visible' ? s.pods.filter((p) => p.kind === 'notReady' || p.kind === 'crashLoop').map((p) => p.pod) : undefined,
    worsening: s.errorServices.filter((e) => e.stats.state === 'worsening' && e.stats.recent >= minimum).map((e) => e.service)
  }
}

/**
 * Alerts between two reads, and the baseline for the next one. Blind is not recovery: an
 * environment that was degraded and now cannot be fully read stays degraded for the comparison,
 * so finding the same pods down on the next read is not a new incident. A list is compared only
 * when its signal was read both times: a failed query leaves it empty, and the read after it would
 * otherwise look like everything in it had just appeared.
 */
export function healthAlerts(baseline: HealthBaseline | undefined, readouts: readonly HealthReadout[]): { alerts: HealthAlert[]; baseline: HealthBaseline } {
  const next: HealthBaseline = {}
  const alerts: HealthAlert[] = []
  for (const env of readouts) {
    const previous = baseline?.[env.id]
    const current: HealthState = env.state === 'blind' && previous?.state === 'degraded' ? 'degraded' : env.state
    const entry = entryOf(env, current)
    next[env.id] = entry
    if (previous === undefined) continue
    const base = { environmentId: env.id, environmentName: env.name }
    if (previous.state !== current) {
      if (current === 'degraded') alerts.push({ ...base, kind: 'degraded', subject: '' })
      else if (current === 'unreachable') alerts.push({ ...base, kind: 'unreachable', subject: '' })
      else if (current === 'healthy' && (previous.state === 'degraded' || previous.state === 'unreachable')) alerts.push({ ...base, kind: 'recovered', subject: '' })
    }
    const s = env.snapshot
    if (!s || !entry.silent || current === 'unreachable') continue
    const unread = new Set([...(entry.unread ?? []), ...(previous.unread ?? [])])

    if (!unread.has('reporting') && previous.silent && entry.silent) {
      const before = new Set(previous.silent)
      const stopped = s.silentServices.filter((x) => !before.has(x.service)).sort((a, b) => a.service.localeCompare(b.service))
      alerts.push(...capped(stopped.map((x) => ({ ...base, kind: 'stoppedReporting' as const, subject: x.service, silentMinutes: x.silentMinutes }))))
    }
    if (!unread.has('pods') && previous.downPods && entry.downPods) {
      const before = new Set(previous.downPods)
      const down = s.pods.filter((p) => (p.kind === 'notReady' || p.kind === 'crashLoop') && !before.has(p.pod))
      alerts.push(...capped(down.map((p) => ({ ...base, kind: 'podDown' as const, subject: p.pod, crashLoop: p.kind === 'crashLoop' }))))
    }
    if (!unread.has('errors') && previous.worsening && entry.worsening) {
      const before = new Set(previous.worsening)
      const worse = new Set(entry.worsening)
      const started = s.errorServices.filter((e) => worse.has(e.service) && !before.has(e.service))
      alerts.push(
        ...capped(
          started.map((e) => ({
            ...base,
            kind: 'errorsWorsening' as const,
            subject: e.service,
            count: e.stats.recent,
            hours: env.errorWindowHours,
            factor: e.stats.typicalDay > 0 ? Math.round(e.stats.recent / e.stats.typicalDay) : undefined
          }))
        )
      )
    }
  }
  return { alerts, baseline: next }
}

/** One subject is announced at most this often. */
export const HEALTH_ALERT_COOLDOWN_MS = 60 * 60_000

export const healthAlertKey = (a: Pick<HealthAlert, 'kind' | 'environmentId' | 'subject'>): string => `${a.kind}|${a.environmentId}|${a.subject}`

/**
 * The alerts that may fire at `now` (each subject at most once per `HEALTH_ALERT_COOLDOWN_MS`) and
 * the updated record of when each fired, to keep across launches. A new incident has its own
 * recovery: a `degraded` alert clears the cooldown of that environment's `recovered`.
 */
export function admitHealthAlerts(alerts: readonly HealthAlert[], firedAt: Readonly<Record<string, number>>, now: number): { admitted: HealthAlert[]; firedAt: Record<string, number> } {
  const record: Record<string, number> = {}
  for (const [key, at] of Object.entries(firedAt)) if (now - at < HEALTH_ALERT_COOLDOWN_MS) record[key] = at
  const admitted: HealthAlert[] = []
  for (const alert of alerts) {
    const key = healthAlertKey(alert)
    const last = record[key]
    if (last !== undefined && now - last < HEALTH_ALERT_COOLDOWN_MS) continue
    record[key] = now
    if (alert.kind === 'degraded') delete record[healthAlertKey({ kind: 'recovered', environmentId: alert.environmentId, subject: '' })]
    admitted.push(alert)
  }
  return { admitted, firedAt: record }
}

/** The state the menu bar shows for a set of environments: the worst one, null when there are none. */
export function worstHealth(states: readonly HealthState[]): HealthState | null {
  const order: HealthState[] = ['unreachable', 'degraded', 'blind', 'healthy']
  for (const s of order) if (states.includes(s)) return s
  return null
}
