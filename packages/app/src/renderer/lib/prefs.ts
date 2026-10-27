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
  /** The mode (Kiro or OpenCode agent, Codex preset) last picked per agent key, used for the next session. */
  modes: Record<string, string>
  /** Terminal color scheme by name (lib/terminalThemes); '' keeps Workhub's own colors. */
  terminalTheme: string
  /** Whether the whole app takes the terminal theme's colors (and its light or dark look). */
  themeApp: boolean
  /** Terminal font family; '' is the default monospace stack. */
  terminalFontFamily: string
  /** Terminal font size in px. */
  terminalFontSize: number
  /** Conversation (chat) text size in px. */
  chatFontSize: number
  /** Base text size of the whole app in px; every text style scales with it. */
  textSize: number
  /** Folders starred in the sidebar (Workhub 1's Favorites), in the order they were added. */
  favoriteFolders: string[]
}

/** Ranges of the size preferences, as Workhub 1 offered them. */
export const SIZE_RANGES = { terminalFontSize: [10, 24], chatFontSize: [11, 20], textSize: [11, 20] } as const
/** The app's base text size (styles.css `--text-base`). */
export const BASE_TEXT_SIZE = 13

const KEY = 'workhub.prefs'
export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  language: 'system',
  models: {},
  modes: {},
  terminalTheme: '',
  themeApp: false,
  terminalFontFamily: '',
  terminalFontSize: 13,
  chatFontSize: BASE_TEXT_SIZE,
  textSize: BASE_TEXT_SIZE,
  favoriteFolders: []
}

/** A size clamped into its range, rounded; the default for anything that is not a number. */
export function clampSize(key: keyof typeof SIZE_RANGES, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PREFS[key]
  const [min, max] = SIZE_RANGES[key]
  return Math.min(max, Math.max(min, Math.round(value)))
}

const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '')

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULT_PREFS
  try {
    const v = JSON.parse(raw) as Partial<Prefs>
    return {
      theme: v.theme === 'light' || v.theme === 'dark' || v.theme === 'system' ? v.theme : DEFAULT_PREFS.theme,
      language: v.language === 'en' || v.language === 'es' || v.language === 'system' ? v.language : DEFAULT_PREFS.language,
      models: modelMap(v.models),
      modes: modelMap(v.modes),
      terminalTheme: str(v.terminalTheme),
      themeApp: v.themeApp === true,
      terminalFontFamily: str(v.terminalFontFamily),
      terminalFontSize: clampSize('terminalFontSize', v.terminalFontSize),
      chatFontSize: clampSize('chatFontSize', v.chatFontSize),
      textSize: clampSize('textSize', v.textSize),
      favoriteFolders: Array.isArray(v.favoriteFolders) ? [...new Set(v.favoriteFolders.filter((f): f is string => typeof f === 'string' && f !== '').map((f) => f.slice(0, 1024)))].slice(0, 100) : []
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function modelMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''))
}

let prefs: Prefs = typeof localStorage === 'undefined' ? DEFAULT_PREFS : parsePrefs(localStorage.getItem(KEY))
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

/** Remembers the mode (agent, persona, preset) picked for an agent key; the next session of that agent starts in it. */
export function rememberMode(agentKey: string, modeId: string | null): void {
  const modes = { ...prefs.modes }
  if (modeId) modes[agentKey] = modeId
  else delete modes[agentKey]
  setPrefs({ modes })
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
