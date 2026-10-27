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
  /** The model last picked per agent key (`claude`, `claude:work`), used for the next session. */
  models: Record<string, string>
}

const KEY = 'workhub.prefs'
const DEFAULTS: Prefs = { theme: 'system', language: 'system', models: {} }

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULTS
  try {
    const v = JSON.parse(raw) as Partial<Prefs>
    return {
      theme: v.theme === 'light' || v.theme === 'dark' || v.theme === 'system' ? v.theme : DEFAULTS.theme,
      language: v.language === 'en' || v.language === 'es' || v.language === 'system' ? v.language : DEFAULTS.language,
      models: modelMap(v.models)
    }
  } catch {
    return DEFAULTS
  }
}

function modelMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''))
}

let prefs: Prefs = typeof localStorage === 'undefined' ? DEFAULTS : parsePrefs(localStorage.getItem(KEY))
const listeners = new Set<() => void>()

export function readPrefs(): Prefs {
  return prefs
}

/** Remembers the model picked for an agent key; the next session of that agent starts with it. */
export function rememberModel(agentKey: string, modelId: string | null): void {
  const models = { ...prefs.models }
  if (modelId) models[agentKey] = modelId
  else delete models[agentKey]
  setPrefs({ models })
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
