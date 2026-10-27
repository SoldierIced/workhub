import type { BlindSpot, HealthReason, HealthReasonCode, HealthSignal, HealthState, PodKind, TrendState } from '@workhub/core'
import type { Tone } from '../components/atoms'
import type { I18n } from '../i18n/I18nProvider'
import type { MessageKey, PluralKey } from '../i18n/translate'

export const HEALTH_TONE: Record<HealthState, Tone> = { healthy: 'success', degraded: 'danger', blind: 'warning', unreachable: 'neutral' }
export const HEALTH_LABEL: Record<HealthState, MessageKey> = {
  healthy: 'health.state.healthy',
  degraded: 'health.state.degraded',
  blind: 'health.state.blind',
  unreachable: 'health.state.unreachable'
}
export const HEALTH_HINT: Record<HealthState, MessageKey> = {
  healthy: 'health.stateHint.healthy',
  degraded: 'health.stateHint.degraded',
  blind: 'health.stateHint.blind',
  unreachable: 'health.stateHint.unreachable'
}

export const TREND_TONE: Record<TrendState, Tone> = { new: 'danger', worsening: 'warning', ongoing: 'info', chronic: 'neutral' }
export const TREND_LABEL: Record<TrendState, MessageKey> = {
  new: 'health.trend.new',
  worsening: 'health.trend.worsening',
  ongoing: 'health.trend.ongoing',
  chronic: 'health.trend.chronic'
}

export const POD_TONE: Record<PodKind, Tone> = { crashLoop: 'danger', notReady: 'warning', restarting: 'info' }
export const POD_LABEL: Record<PodKind, MessageKey> = { crashLoop: 'health.pod.crashLoop', notReady: 'health.pod.notReady', restarting: 'health.pod.restarting' }

const REASON_KEY: Record<HealthReasonCode, PluralKey> = {
  podsNotReady: 'health.reason.podsNotReady',
  podsCrashLooping: 'health.reason.podsCrashLooping',
  podsRestarting: 'health.reason.podsRestarting',
  errorsNew: 'health.reason.errorsNew',
  errorsWorsening: 'health.reason.errorsWorsening',
  servicesSilent: 'health.reason.servicesSilent'
}

const SIGNAL_LABEL: Record<HealthSignal, MessageKey> = {
  errors: 'health.signal.errors',
  events: 'health.signal.events',
  pods: 'health.signal.pods',
  reporting: 'health.signal.reporting',
  slow: 'health.signal.slow'
}

export const reasonText = (reason: HealthReason, tn: I18n['tn']): string => tn(REASON_KEY[reason.code], reason.count)

const BLIND_KEY: Record<Exclude<BlindSpot['code'], 'unread' | 'connection'>, MessageKey> = {
  notReadYet: 'health.blind.notReadYet',
  noPodMetrics: 'health.blind.noPodMetrics',
  noKubernetesSuffix: 'health.blind.noKubernetesSuffix',
  noKubeState: 'health.blind.noKubeState',
  apmOff: 'health.blind.apmOff',
  errorsOff: 'health.blind.errorsOff'
}

export function blindSpotText(spot: BlindSpot, t: I18n['t']): string {
  if (spot.code === 'unread') return t('health.blind.unread', { signal: spot.signal ? t(SIGNAL_LABEL[spot.signal]) : '', detail: spot.detail ?? '' })
  if (spot.code === 'connection') return t('health.blind.connection', { detail: spot.detail ?? '' })
  return t(BLIND_KEY[spot.code])
}

/** 540 ms, 2.3 s, 41 s. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
}

/** 0.031 -> 3.1%, 0.2 -> 20%, 0 -> 0%. */
export function formatRate(rate: number): string {
  const pct = rate * 100
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`
}

/** "No blind spot is shown for what a section already says": the pod spots when pods are not visible have their own card message. */
export function visibleBlindSpots(spots: BlindSpot[]): BlindSpot[] {
  return spots.filter((s) => s.code !== 'noPodMetrics' && s.code !== 'noKubernetesSuffix' && s.code !== 'noKubeState')
}

/** Worst state first, for the Home strip. */
export const STATE_ORDER: readonly HealthState[] = ['degraded', 'unreachable', 'blind', 'healthy']

const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/**
 * The folder to investigate a service in: the profile folder named like the service (case and
 * separators ignored), else the only folder, else the first one. Undefined when the profile has none.
 */
export function folderForService(folders: string[], service: string): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wanted = norm(service)
  return folders.find((f) => wanted !== '' && norm(lastSegment(f)) === wanted) ?? folders[0]
}
