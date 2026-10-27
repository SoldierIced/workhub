import { en } from './en'
import { es } from './es'

/**
 * A small typed i18n layer. `en` is the source of truth: its keys type every lookup, and `es`
 * must have exactly the same keys (the compiler and a unit test both check it). Placeholders
 * are `{name}`; plural messages are two keys, `<base>.one` and `<base>.other`, picked with
 * Intl.PluralRules.
 */
export type Locale = 'en' | 'es'
export const LOCALES: readonly Locale[] = ['en', 'es']
export type LanguagePreference = 'system' | Locale

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>
export type PluralKey = MessageKey extends infer K ? (K extends `${infer B}.other` ? B : never) : never
export type Params = Record<string, string | number>

export const DICTIONARIES: Record<Locale, Messages> = { en, es }

/** The locale to use: the explicit preference, else the first OS language we support, else English. */
export function resolveLocale(preference: LanguagePreference, osLanguages: readonly string[]): Locale {
  if (preference !== 'system') return preference
  for (const tag of osLanguages) {
    const base = tag.toLowerCase().split(/[-_]/)[0]
    if (base === 'en' || base === 'es') return base
  }
  return 'en'
}

/** Replaces `{name}` placeholders; unknown placeholders stay as they are so a missing param is visible. */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  return interpolate(DICTIONARIES[locale][key] ?? DICTIONARIES.en[key] ?? key, params)
}

export function translatePlural(locale: Locale, base: PluralKey, count: number, params?: Params): string {
  const form = new Intl.PluralRules(locale).select(count) === 'one' ? 'one' : 'other'
  return translate(locale, `${base}.${form}` as MessageKey, { count, ...params })
}

/** Placeholder names used by a template, sorted; en and es must use the same ones per key. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort()
}
