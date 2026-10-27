import type { TrayText } from '@workhub/core'
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
