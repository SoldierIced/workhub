import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { usePrefs } from '../lib/prefs'
import { resolveLocale, translate, translatePlural, type Locale, type MessageKey, type Params, type PluralKey } from './translate'

export interface I18n {
  locale: Locale
  t: (key: MessageKey, params?: Params) => string
  tn: (base: PluralKey, count: number, params?: Params) => string
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string
  formatNumber: (n: number, options?: Intl.NumberFormatOptions) => string
}

/**
 * One formatter per locale and options, built on first use: creating an `Intl` formatter costs far
 * more than formatting with one, and a long chat formats two dates per message on every render.
 */
export function formatterCache<F>(create: (options: object | undefined) => F): (options: object | undefined) => F {
  const cache = new Map<string, F>()
  return (options) => {
    const key = options ? JSON.stringify(options) : ''
    let formatter = cache.get(key)
    if (!formatter) {
      formatter = create(options)
      cache.set(key, formatter)
    }
    return formatter
  }
}

function make(locale: Locale): I18n {
  const dates = formatterCache((o) => new Intl.DateTimeFormat(locale, o as Intl.DateTimeFormatOptions | undefined))
  const numbers = formatterCache((o) => new Intl.NumberFormat(locale, o as Intl.NumberFormatOptions | undefined))
  return {
    locale,
    t: (key, params) => translate(locale, key, params),
    tn: (base, count, params) => translatePlural(locale, base, count, params),
    formatDate: (date, options) => dates(options).format(date),
    formatNumber: (n, options) => numbers(options).format(n)
  }
}

const I18nContext = createContext<I18n>(make('en'))

/** Language follows the OS unless Settings overrides it. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const { language } = usePrefs()
  const locale = resolveLocale(language, navigator.languages ?? [navigator.language])
  const value = useMemo(() => make(locale), [locale])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  return useContext(I18nContext)
}
