import { matchFolder, type BlindSpot, type ErrorGroup, type HealthReason, type HealthReasonCode, type HealthSignal, type HealthSnapshot, type HealthState, type PodKind, type PodVisibility, type TrendState, type TrendStats, type WindowRegression, type WindowVerdict } from '@workhub/core'
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
  slow: 'health.signal.slow',
  stderr: 'health.signal.stderr'
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

/**
 * Why an environment could not be read at all, or null when it was read. `neverRead` means there
 * are no earlier figures either, so the signal cards would only show empty lists that look like
 * "nothing wrong": the screen shows the failure instead of them.
 */
export function connectionFailure(snapshot: Pick<HealthSnapshot, 'state' | 'errorMessage' | 'blindSpots' | 'fetchedAt'>): { message: string; neverRead: boolean } | null {
  if (snapshot.state !== 'unreachable') return null
  const message = snapshot.errorMessage?.trim() || snapshot.blindSpots.find((b) => b.code === 'connection')?.detail?.trim() || ''
  return { message, neverRead: snapshot.fetchedAt === undefined }
}

/** Worst state first, for the Home strip. */
export const STATE_ORDER: readonly HealthState[] = ['degraded', 'unreachable', 'blind', 'healthy']

/**
 * The folder to investigate a service in: the profile folder named like the service (case and
 * separators ignored), else the first one. Undefined when the profile has none.
 */
export function folderForService(folders: string[], service: string): string | undefined {
  return matchFolder(folders, service) ?? folders[0]
}

type Words = Pick<I18n, 't' | 'tn' | 'formatNumber'>

const daysText = (w: Words, count: number, truncated = false) => (truncated ? w.t('health.why.daysPlus', { count }) : w.tn('health.why.days', count))

/** Why a signal is listed, from the numbers its row already has: "Why worsening: 2,380 in 24 h vs about 26 a day over the previous 13 days." */
export function whyText(stats: TrendStats & { state: TrendState }, hours: number, w: Words): string {
  const recent = w.t('health.why.recent', { count: w.formatNumber(stats.recent), hours })
  const previous = Math.max(stats.daysWithData - 1, 0)
  const typical = w.formatNumber(stats.typicalDay)
  const streak = daysText(w, stats.streakDays, stats.streakTruncated)
  switch (stats.state) {
    case 'worsening':
      return previous > 0 ? w.t('health.why.worsening', { recent, typical, days: daysText(w, previous) }) : w.t('health.why.worseningNoHistory', { recent })
    case 'new':
      if (previous === 0) return w.t('health.why.newNoHistory', { recent })
      return stats.typicalDay > 0 ? w.t('health.why.newAfterQuiet', { recent, days: daysText(w, previous), typical }) : w.t('health.why.newNone', { recent, days: daysText(w, previous) })
    case 'ongoing':
      return stats.typicalDay > 0 ? w.t('health.why.ongoing', { streak, recent, typical }) : w.t('health.why.ongoingPlain', { streak, recent })
    case 'chronic':
      return stats.typicalDay > 0 ? w.t('health.why.chronic', { streak, recent, typical }) : w.t('health.why.chronicPlain', { streak, recent })
  }
}

/** `System.NullReferenceException` -> `NullReferenceException`; a type with spaces is left whole. */
export function shortType(type: string): string {
  if (type.includes(' ')) return type
  return type.split('.').filter(Boolean).pop() ?? type
}

export const groupTitle = (g: Pick<ErrorGroup, 'exceptionType' | 'culprit' | 'groupingKey'>): string => g.exceptionType ?? g.culprit ?? g.groupingKey.slice(0, 8)

/** What the top group explains: "NullReferenceException at POST /orders is 81% of them." Null without groups. */
export function leadGroupText(groups: ErrorGroup[], total: number, w: Words): string | null {
  const top = groups[0]
  if (!top || total <= 0) return null
  const share = formatRate(Math.min(top.recent / total, 1))
  const type = shortType(groupTitle(top))
  return top.endpoint ? w.t('health.errors.lead', { type, endpoint: top.endpoint, share }) : w.t('health.errors.leadNoEndpoint', { type, share })
}

/** What "Copy request for infra" copies, for a person at infra, in the interface language. */
export function infraRequest(env: { name: string; k8sIndexSuffix: string }, t: I18n['t']): string {
  const parts = [t('health.pods.request', { environment: env.name })]
  if (env.k8sIndexSuffix) parts.push(t('health.pods.requestStreams', { suffix: env.k8sIndexSuffix }))
  parts.push(t('health.pods.requestWhy'))
  return parts.join(' ')
}

/** Why the pods card has nothing to say, and whether infra can be asked about it. */
export function noPodMetrics(env: { hasKubeState: boolean; k8sIndexSuffix: string }, visibility: PodVisibility): { title: MessageKey; hint: MessageKey; askInfra: boolean } {
  if (!env.hasKubeState) return { title: 'health.pods.noKubeState.title', hint: 'health.pods.noKubeState.hint', askInfra: true }
  if (visibility === 'missing') return { title: 'health.pods.missing.title', hint: 'health.pods.missing.hint', askInfra: true }
  return { title: 'health.pods.noSuffix.title', hint: 'health.pods.noSuffix.hint', askInfra: false }
}

/** One reason a window is worse than the one before, in words. */
export function regressionText(r: WindowRegression, w: Words): string {
  switch (r.code) {
    case 'errors':
      return w.t('health.slow.reason.errors', { before: w.formatNumber(r.before), after: w.formatNumber(r.after) })
    case 'failureRate':
      return w.t('health.slow.reason.failureRate', { before: formatRate(r.before), after: formatRate(r.after) })
    case 'latency':
      return w.t('health.slow.reason.latency', { before: formatMs(r.before), after: formatMs(r.after) })
    case 'newErrorTypes':
      return w.tn('health.slow.reason.newErrorTypes', r.count)
  }
}

export function verdictText(v: WindowVerdict, w: Words): string {
  if (v.kind === 'clean') return w.t('health.slow.verdict.clean')
  if (v.kind === 'noSignal') return w.t('health.slow.verdict.noSignal')
  return w.t('health.slow.verdict.regressed', { reasons: v.reasons.map((r) => regressionText(r, w)).join(', ') })
}
