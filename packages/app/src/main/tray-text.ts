import type { FlowAlert, HealthAlert, MetricAlert, TrayText } from '@workhub/core'
// The renderer's dictionaries are plain data; the main process words the tray menu and its own
// notifications (tickets, Health) with them, in the language the renderer reports.
import { DICTIONARIES, translate, translatePlural, type Locale, type MessageKey, type PluralKey } from '../renderer/i18n/translate'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && value in DICTIONARIES
}

const has = (key: string): key is MessageKey => key in DICTIONARIES.en

export function trayText(locale: Locale): TrayText {
  const t = (key: string, params?: Record<string, string | number>) => (has(key) ? translate(locale, key, params) : key)
  return {
    t,
    tn: (base, count, params) => (has(`${base}.other`) ? translatePlural(locale, base as PluralKey, count, params) : `${base} ${count}`),
    time: (ms) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(ms),
    windowLabel: (w) => (has(`tray.window.${w}`) ? t(`tray.window.${w}`) : w.replace(/^weekly /, ''))
  }
}

/** The title and body of a Health notification, in the tray's language. */
export function healthAlertWords(alert: HealthAlert, t: TrayText['t']): { title: string; body: string } {
  const environment = alert.environmentName
  if (alert.subject === '+more') {
    const names = (alert.others ?? []).slice(0, 6).join(', ') + ((alert.others?.length ?? 0) > 6 ? ', …' : '')
    return { title: t(`notify.health.more.${alert.kind}`, { environment }), body: names }
  }
  switch (alert.kind) {
    case 'stoppedReporting':
      return { title: t('notify.health.stoppedReporting', { service: alert.subject, environment }), body: t('notify.health.stoppedReportingBody', { minutes: alert.silentMinutes ?? 0 }) }
    case 'podDown':
      return { title: t(alert.crashLoop ? 'notify.health.podCrashLoop' : 'notify.health.podDown', { pod: alert.subject, environment }), body: t('notify.health.podDownBody') }
    case 'errorsWorsening': {
      const params = { count: alert.count ?? 0, hours: alert.hours ?? 24, factor: alert.factor ?? 0 }
      return { title: t('notify.health.errorsWorsening', { service: alert.subject, environment }), body: t(alert.factor ? 'notify.health.errorsWorseningBody' : 'notify.health.errorsWorseningBodyPlain', params) }
    }
    default:
      return { title: t(`notify.health.${alert.kind}`, { environment }), body: t(`notify.health.${alert.kind}Body`) }
  }
}

const formatMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`)
const formatRate = (rate: number): string => `${(rate * 100).toFixed(1)}%`

/** The title and body of a flow-map alert (a part above its p95 or failure limit), in the tray's language. */
export function flowAlertWords(alert: FlowAlert, t: TrayText['t']): { title: string; body: string } {
  const format = alert.kind === 'flowSlow' ? formatMs : formatRate
  const base = alert.kind === 'flowSlow' ? 'notify.flow.slow' : 'notify.flow.errors'
  return {
    title: t(base, { part: alert.label, map: alert.mapName, environment: alert.environmentName }),
    body: t(`${base}Body`, { value: format(alert.value), limit: format(alert.threshold) })
  }
}

const signed = (n: number): string => `${n > 0 ? '+' : ''}${n}`

/** The title and body of a metric alert notification; several at once fold into one. Worst first. */
export function metricAlertWords(alerts: readonly MetricAlert[], t: TrayText['t']): { title: string; body: string } {
  const one = (a: MetricAlert) => (a.segment ? `${a.subject} · ${a.segment}` : a.subject)
  if (alerts.length !== 1) {
    const names = alerts.slice(0, 4).map((a) => `${a.label ?? a.metric}: ${one(a)}`).join(', ') + (alerts.length > 4 ? ', …' : '')
    return { title: t('notify.metricAlert.many', { count: alerts.length }), body: names }
  }
  const a = alerts[0]!
  const title = t(`notify.metricAlert.${a.kind}`, { metric: a.label ?? a.metric, subject: one(a) })
  const body =
    a.changePoints !== undefined
      ? t('notify.metricAlert.bodyPoints', { value: a.lastValue, baseline: a.baseline, change: signed(a.changePoints) })
      : a.changePct !== undefined
        ? t('notify.metricAlert.bodyPct', { value: a.lastValue, baseline: a.baseline, change: `${signed(Math.round(a.changePct))}%` })
        : t('notify.metricAlert.bodyPlain', { value: a.lastValue })
  return { title, body }
}
