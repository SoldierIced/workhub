import { useSyncExternalStore } from 'react'
import type { ThemePreference } from '@shared/api'
import type { LanguagePreference } from '../i18n/translate'

/**
 * Appearance and language preferences of this install. They are UI-only, so they live in the
 * renderer's localStorage (kept in the app's own userData folder), not in the shared config.
 */
export interface Prefs {
  theme: ThemePreference
  language: LanguagePreference
}

const KEY = 'workhub.prefs'
const DEFAULTS: Prefs = { theme: 'system', language: 'system' }

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULTS
  try {
    const v = JSON.parse(raw) as Partial<Prefs>
    return {
      theme: v.theme === 'light' || v.theme === 'dark' || v.theme === 'system' ? v.theme : DEFAULTS.theme,
      language: v.language === 'en' || v.language === 'es' || v.language === 'system' ? v.language : DEFAULTS.language
    }
  } catch {
    return DEFAULTS
  }
}

let prefs: Prefs = typeof localStorage === 'undefined' ? DEFAULTS : parsePrefs(localStorage.getItem(KEY))
const listeners = new Set<() => void>()

export function readPrefs(): Prefs {
  return prefs
}

export function setPrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch }
  localStorage.setItem(KEY, JSON.stringify(prefs))
  for (const l of listeners) l()
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => prefs
  )
}

/** The OS color scheme, live. */
export function useSystemDark(): boolean {
  return useSyncExternalStore(
    (l) => {
      const mq = matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', l)
      return () => mq.removeEventListener('change', l)
    },
    () => matchMedia('(prefers-color-scheme: dark)').matches
  )
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
}
