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
  /** Lines of scrollback each terminal keeps (xterm's own default is 1,000). */
  terminalScrollback: number
  /** Conversation (chat) text size in px. */
  chatFontSize: number
  /** Base text size of the whole app in px; every text style scales with it. */
  textSize: number
  /** Width of the session monitor panel in px. */
  monitorWidth: number
  /** Width of the left sidebar in px. */
  sidebarWidth: number
  /** Width of the service detail sheet of the Health board in px. */
  healthDetailWidth: number
  /** Width of a chat's live board panel (beside the chat) in px. */
  boardPanelWidth: number
  /** Monitor sections the user folded (section ids). */
  monitorCollapsed: string[]
  /** Whether the left sidebar is folded away (Workhub 1's sidebar toggle). */
  sidebarHidden: boolean
  /** Whether the session monitor panel is folded away (Workhub 1's Inspector toggle). */
  monitorHidden: boolean
  /** What Review changes shows: the files the session's agent edited, or every change in the repo. */
  reviewFiles: 'session' | 'repo'
  /** Folders starred in the sidebar (Workhub 1's Favorites), in the order they were added. */
  favoriteFolders: string[]
  /**
   * The profile folders whose section of the folders panel is unfolded. Sections start folded, as
   * "All folders" did, so a folder holding dozens of repositories does not push the list down.
   */
  expandedFolders: string[]
  /** Whether the part detail drawer of the Flow maps screen is folded. */
  flowMapDrawerCollapsed: boolean
  /** Flow maps starred in the list (map ids), listed first under Favorites. */
  favoriteFlowMaps: string[]
  /** Flow maps: only the starred maps are listed. */
  flowMapsFavoritesOnly: boolean
  /** Health services starred on the Environments board (`healthFavoriteKey`), shown first as large cards. */
  favoriteHealthServices: string[]
  /** Health board: only the starred services. */
  healthFavoritesOnly: boolean
  /** Metric alerts pinned on Health → Alerts (`pinnedAlertKey`), shown first as large cards. */
  pinnedMetricAlerts: string[]
  /** Health → Alerts: only the pinned alerts. */
  alertsPinnedOnly: boolean
  /** How Health → Alerts lays the alerts out: cards (the default) or the compact list. */
  alertsLayout: 'cards' | 'list'
  /** Automations screen: every profile's automations, not only the open profile's. */
  automationsShowAll: boolean
  /** Whether the menu bar panel's folded "Usage" (more than 3 accounts) is unfolded. */
  trayPopoverUsageExpanded: boolean
  /** The menu bar panel's "Recent" left open (true) or closed, per context (lib/trayPopover `recentExpanded`). */
  trayPopoverRecent: { busy?: boolean; quiet?: boolean }
  /**
   * Live boards: where the person moved graph boxes, per graph (`boardLayoutKey`), newest last. Only the
   * drawing on this computer changes; nothing goes back to the tool.
   */
  boardLayouts: Array<{ key: string; boxes: Record<string, { x: number; y: number }> }>
}

/** How many graphs keep their moved boxes; the one moved longest ago is forgotten first. */
export const BOARD_LAYOUTS_MAX = 40

/** Ranges of the size preferences, as Workhub 1 offered them. */
export const SIZE_RANGES = { terminalFontSize: [10, 24], terminalScrollback: [1000, 100_000], chatFontSize: [11, 20], textSize: [11, 20], monitorWidth: [240, 560], sidebarWidth: [200, 420], healthDetailWidth: [380, 900], boardPanelWidth: [360, 1200] } as const
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
  terminalScrollback: 10_000,
  chatFontSize: BASE_TEXT_SIZE,
  textSize: BASE_TEXT_SIZE,
  monitorWidth: 320,
  healthDetailWidth: 520,
  boardPanelWidth: 620,
  sidebarWidth: 256,
  monitorCollapsed: [],
  sidebarHidden: false,
  monitorHidden: false,
  reviewFiles: 'session',
  favoriteFolders: [],
  expandedFolders: [],
  flowMapDrawerCollapsed: false,
  favoriteFlowMaps: [],
  flowMapsFavoritesOnly: false,
  favoriteHealthServices: [],
  healthFavoritesOnly: false,
  pinnedMetricAlerts: [],
  alertsPinnedOnly: false,
  alertsLayout: 'cards',
  automationsShowAll: false,
  trayPopoverUsageExpanded: false,
  trayPopoverRecent: {},
  boardLayouts: []
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
      terminalScrollback: clampSize('terminalScrollback', v.terminalScrollback),
      chatFontSize: clampSize('chatFontSize', v.chatFontSize),
      textSize: clampSize('textSize', v.textSize),
      monitorWidth: clampSize('monitorWidth', v.monitorWidth),
      healthDetailWidth: clampSize('healthDetailWidth', v.healthDetailWidth),
      boardPanelWidth: clampSize('boardPanelWidth', v.boardPanelWidth),
      sidebarWidth: clampSize('sidebarWidth', v.sidebarWidth),
      monitorCollapsed: Array.isArray(v.monitorCollapsed) ? v.monitorCollapsed.filter((x): x is string => typeof x === 'string').slice(0, 40) : [],
      sidebarHidden: v.sidebarHidden === true,
      monitorHidden: v.monitorHidden === true,
      reviewFiles: v.reviewFiles === 'repo' ? 'repo' : 'session',
      favoriteFolders: pathList(v.favoriteFolders, 100),
      expandedFolders: pathList(v.expandedFolders, 200),
      flowMapDrawerCollapsed: v.flowMapDrawerCollapsed === true,
      favoriteFlowMaps: pathList(v.favoriteFlowMaps, 200),
      flowMapsFavoritesOnly: v.flowMapsFavoritesOnly === true,
      favoriteHealthServices: pathList(v.favoriteHealthServices, 300),
      healthFavoritesOnly: v.healthFavoritesOnly === true,
      pinnedMetricAlerts: pathList(v.pinnedMetricAlerts, 300),
      alertsPinnedOnly: v.alertsPinnedOnly === true,
      alertsLayout: v.alertsLayout === 'list' ? 'list' : 'cards',
      automationsShowAll: v.automationsShowAll === true,
      trayPopoverUsageExpanded: v.trayPopoverUsageExpanded === true,
      trayPopoverRecent: recentMemory(v.trayPopoverRecent),
      boardLayouts: boardLayouts(v.boardLayouts)
    }
  } catch {
    return DEFAULT_PREFS
  }
}

/** A list of folder paths or ids: strings only, no empty or repeated ones, each and the list kept short. */
function pathList(raw: unknown, max: number): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((f): f is string => typeof f === 'string' && f !== '').map((f) => f.slice(0, 1024)))].slice(0, max) : []
}

const BOX_MAX = 100_000
function boardLayouts(raw: unknown): Prefs['boardLayouts'] {
  if (!Array.isArray(raw)) return []
  const out: Prefs['boardLayouts'] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { key, boxes } = item as { key?: unknown; boxes?: unknown }
    if (typeof key !== 'string' || !key || key.length > 600 || !boxes || typeof boxes !== 'object' || Array.isArray(boxes)) continue
    const kept: Record<string, { x: number; y: number }> = {}
    for (const [id, p] of Object.entries(boxes).slice(0, 60)) {
      const { x, y } = (p ?? {}) as { x?: unknown; y?: unknown }
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) kept[id.slice(0, 60)] = { x: Math.min(BOX_MAX, Math.max(0, x)), y: Math.min(BOX_MAX, Math.max(0, y)) }
    }
    if (Object.keys(kept).length > 0 && !out.some((l) => l.key === key)) out.push({ key, boxes: kept })
  }
  return out.slice(-BOARD_LAYOUTS_MAX)
}

function recentMemory(raw: unknown): Prefs['trayPopoverRecent'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  return { ...(typeof r['busy'] === 'boolean' ? { busy: r['busy'] } : {}), ...(typeof r['quiet'] === 'boolean' ? { quiet: r['quiet'] } : {}) }
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

// Another window of the app (the menu bar popover, a pull request window) saved: follow it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return
    prefs = parsePrefs(event.newValue)
    for (const l of listeners) l()
  })
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => prefs,
    // Rendered outside a window (the tests' static markup): the same snapshot.
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
