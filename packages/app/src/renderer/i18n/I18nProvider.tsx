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

function make(locale: Locale): I18n {
  return {
    locale,
    t: (key, params) => translate(locale, key, params),
    tn: (base, count, params) => translatePlural(locale, base, count, params),
    formatDate: (date, options) => new Intl.DateTimeFormat(locale, options).format(date),
    formatNumber: (n, options) => new Intl.NumberFormat(locale, options).format(n)
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
