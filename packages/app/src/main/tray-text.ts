import type { HealthAlert, TrayText } from '@workhub/core'
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
    windowLabel: (w) => (has(`tray.window.${w}`) ? t(`tray.window.${w}`) : w)
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
