import { useEffect } from 'react'
import type { ThemePreference } from '@shared/api'
import { BASE_TEXT_SIZE, resolveTheme, usePrefs, useSystemDark, type Prefs } from './prefs'
import { APP_TOKEN_NAMES, appTokens, findTerminalTheme, isDarkTheme } from './terminalThemes'

/** Light or dark for the app: the terminal theme's own look when it themes the app, else the preference. */
export function resolveAppearance(prefs: Pick<Prefs, 'theme' | 'themeApp' | 'terminalTheme'>, systemDark: boolean): 'light' | 'dark' {
  const themed = prefs.themeApp ? findTerminalTheme(prefs.terminalTheme) : undefined
  if (themed) return isDarkTheme(themed) ? 'dark' : 'light'
  return resolveTheme(prefs.theme, systemDark)
}

/** What the native window chrome should follow. */
export function nativeTheme(prefs: Pick<Prefs, 'theme' | 'themeApp' | 'terminalTheme'>, systemDark: boolean): ThemePreference {
  return prefs.themeApp && findTerminalTheme(prefs.terminalTheme) ? resolveAppearance(prefs, systemDark) : prefs.theme
}

/**
 * Applies the appearance preferences to <html>: light or dark, the terminal theme's colors when
 * it themes the app, the app text scale and the conversation text size. Safe to call before the
 * first paint.
 */
export function applyAppearance(prefs: Prefs, systemDark: boolean): 'light' | 'dark' {
  const root = document.documentElement
  const resolved = resolveAppearance(prefs, systemDark)
  root.dataset['theme'] = resolved
  const themed = prefs.themeApp ? findTerminalTheme(prefs.terminalTheme) : undefined
  if (themed) for (const [name, value] of Object.entries(appTokens(themed))) root.style.setProperty(name, value)
  else for (const name of APP_TOKEN_NAMES) root.style.removeProperty(name)
  root.style.setProperty('--wh-text-scale', String(prefs.textSize / BASE_TEXT_SIZE))
  root.style.setProperty('--wh-chat-font-size', `calc(${prefs.chatFontSize}px * var(--wh-text-scale))`)
  return resolved
}

/** Keeps <html> in sync with the appearance preferences and tells the main process (native chrome). */
/**
 * Keeps <html> in step with the appearance preferences in a secondary window (popover, pull
 * request, ticket, review, file viewer): a theme picked in Settings reaches it without a reload.
 * The main window's `useAppearance` also tells main the native theme; this only paints.
 */
export function useAppliedAppearance(): void {
  const prefs = usePrefs()
  const systemDark = useSystemDark()
  useEffect(() => {
    applyAppearance(prefs, systemDark)
  }, [prefs, systemDark])
}

export function useAppearance(): 'light' | 'dark' {
  const prefs = usePrefs()
  const systemDark = useSystemDark()
  const resolved = resolveAppearance(prefs, systemDark)
  const native = nativeTheme(prefs, systemDark)
  useEffect(() => {
    window.hub.setTheme(native)
  }, [native])
  useEffect(() => {
    applyAppearance(prefs, systemDark)
  }, [prefs, systemDark])
  return resolved
}
