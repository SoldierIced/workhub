/**
 * Health alerts per kind (Settings → Alerts): whether each kind the Health watcher can raise is
 * announced, where, and from which threshold. Every field is optional and the defaults are the
 * behavior before the setting existed (everything announced, the environment's own thresholds),
 * so a profile without it needs no migration. A kind that is not announced still shows on the
 * Health screen: these settings only gate the notification.
 */
import type { HealthAlertKind } from '../notifications/health-alerts'
import type { HealthSnapshot } from './types'

/** Every kind the Health watcher raises, in the order the settings list them. */
export const HEALTH_ALERT_KINDS = ['stoppedReporting', 'podDown', 'errorsWorsening', 'degraded', 'unreachable', 'recovered'] as const satisfies readonly HealthAlertKind[]

/** Where an alert is announced: the OS notification, and the menu bar's recent notifications. */
export const HEALTH_ALERT_CHANNELS = ['notification', 'tray'] as const
export type HealthAlertChannel = (typeof HEALTH_ALERT_CHANNELS)[number]

export interface HealthAlertKindSettings {
  notify: boolean
  /** The kind's own threshold (see `HEALTH_ALERT_THRESHOLDS`); unset: the environment's thresholds alone decide. */
  threshold?: number
  /** Unset: every channel. */
  channels?: HealthAlertChannel[]
}

/** Stored under `profile.health.alerts`; a kind left out keeps its defaults. */
export type HealthAlertSettings = Partial<Record<HealthAlertKind, HealthAlertKindSettings>>

/**
 * The threshold a kind can honor, with its range; null when the detector has none to tune.
 * - `stoppedReporting`: minutes a service has been silent before it is announced. Below the
 *   environment's "stopped reporting after" it changes nothing (the service is not listed yet).
 * - `errorsWorsening`: how many times its typical day a worsening service must reach (a service
 *   with no errors on a typical day always qualifies).
 * Pods are listed as down when not ready or backing off, which no number decides, so `podDown`
 * has none; neither do the environment state changes.
 */
export const HEALTH_ALERT_THRESHOLDS: Record<HealthAlertKind, { unit: 'minutes' | 'factor'; range: readonly [number, number] } | null> = {
  stoppedReporting: { unit: 'minutes', range: [2, 1440] },
  errorsWorsening: { unit: 'factor', range: [1, 1000] },
  podDown: null,
  degraded: null,
  unreachable: null,
  recovered: null
}

export interface ResolvedHealthAlertKind {
  notify: boolean
  threshold?: number
  channels: HealthAlertChannel[]
}

/** The settings a profile runs with: what it stores over the defaults, thresholds clamped, unknown channels dropped. */
export function healthAlertSettingsOf(stored: HealthAlertSettings | undefined): Record<HealthAlertKind, ResolvedHealthAlertKind> {
  const out = {} as Record<HealthAlertKind, ResolvedHealthAlertKind>
  for (const kind of HEALTH_ALERT_KINDS) {
    const own = stored?.[kind]
    const spec = HEALTH_ALERT_THRESHOLDS[kind]
    const raw = own?.threshold
    const threshold = spec && typeof raw === 'number' && Number.isFinite(raw) ? Math.min(spec.range[1], Math.max(spec.range[0], raw)) : undefined
    const channels = Array.isArray(own?.channels) ? HEALTH_ALERT_CHANNELS.filter((c) => own.channels!.includes(c)) : [...HEALTH_ALERT_CHANNELS]
    out[kind] = { notify: own?.notify !== false, ...(threshold !== undefined ? { threshold } : {}), channels }
  }
  return out
}

type AlertSnapshot = Pick<HealthSnapshot, 'silentServices' | 'errorServices'>

/**
 * The snapshot the alert comparison sees: services silent for less than the `stoppedReporting`
 * threshold and worsening services under the `errorsWorsening` factor are left out, so they are
 * announced on the first read that crosses the threshold. The Health screen keeps the full snapshot.
 */
export function withAlertThresholds<S extends AlertSnapshot>(snapshot: S, settings: Record<HealthAlertKind, ResolvedHealthAlertKind>): S {
  const minutes = settings.stoppedReporting.threshold
  const factor = settings.errorsWorsening.threshold
  if (minutes === undefined && factor === undefined) return snapshot
  return {
    ...snapshot,
    silentServices: minutes === undefined || !snapshot.silentServices ? snapshot.silentServices : snapshot.silentServices.filter((s) => s.silentMinutes >= minutes),
    errorServices:
      factor === undefined || !snapshot.errorServices
        ? snapshot.errorServices
        : snapshot.errorServices.filter((e) => e.stats.state !== 'worsening' || e.stats.typicalDay <= 0 || e.stats.recent / e.stats.typicalDay >= factor)
  }
}
