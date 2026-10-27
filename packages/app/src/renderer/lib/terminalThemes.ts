import type { ITheme } from '@xterm/xterm'
import catalog from '../themes/terminal-themes.json'

/**
 * Terminal color schemes, the same catalog Workhub 1 offered (its Ghostty build bundles
 * iTerm2-Color-Schemes, MIT: see `themes/LICENSE`). Each entry of the JSON is
 * `[name, background, foreground, cursor, selection, "16 comma-separated ANSI colors"]`,
 * hex without `#`.
 */
export interface TerminalThemeDef {
  name: string
  background: string
  foreground: string
  cursor: string
  selection: string
  /** ANSI 0-15, `#rrggbb`. */
  palette: string[]
}

type Row = [string, string, string, string, string, string]

const hex = (v: string) => (v ? `#${v.toLowerCase()}` : '')

function fromRow([name, background, foreground, cursor, selection, palette]: Row): TerminalThemeDef {
  return { name, background: hex(background), foreground: hex(foreground), cursor: hex(cursor), selection: hex(selection), palette: palette.split(',').map(hex) }
}

/** Every bundled theme, sorted by name. */
export const TERMINAL_THEMES: readonly TerminalThemeDef[] = (catalog as Row[]).map(fromRow)

const byName = new Map(TERMINAL_THEMES.map((th) => [th.name, th]))

/** The theme with that exact name; undefined for '' (Workhub's own colors) or an unknown name. */
export function findTerminalTheme(name: string): TerminalThemeDef | undefined {
  return byName.get(name)
}

/** Case-insensitive name search; an empty query returns everything. */
export function searchTerminalThemes(query: string, themes: readonly TerminalThemeDef[] = TERMINAL_THEMES): TerminalThemeDef[] {
  const q = query.trim().toLowerCase()
  return q ? themes.filter((th) => th.name.toLowerCase().includes(q)) : [...themes]
}

function rgb(color: string): [number, number, number] {
  const v = color.replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(v)) return [0, 0, 0]
  const n = parseInt(v, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (c: [number, number, number]) => `#${c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('')}`

/** Perceived brightness 0..1, as Workhub 1 computed it. */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

export function isDarkTheme(th: Pick<TerminalThemeDef, 'background'>): boolean {
  return luminance(th.background) < 0.5
}

/** `a` moved towards `b` by `t` (0..1). */
export function mix(a: string, b: string, t: number): string {
  const ca = rgb(a)
  const cb = rgb(b)
  return toHex([0, 1, 2].map((i) => ca[i]! + (cb[i]! - ca[i]!) * t) as [number, number, number])
}

export function alpha(color: string, a: number): string {
  const [r, g, b] = rgb(color)
  return `rgb(${r} ${g} ${b} / ${a})`
}

/** WCAG contrast ratio between two colors. */
export function contrast(a: string, b: string): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const rel = (color: string) => {
    const [r, g, b] = rgb(color)
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  const [hi, lo] = [rel(a), rel(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** xterm's colors for a theme. */
export function xtermTheme(th: TerminalThemeDef): ITheme {
  const p = th.palette
  return {
    background: th.background,
    foreground: th.foreground,
    cursor: th.cursor || th.foreground,
    cursorAccent: th.background,
    selectionBackground: th.selection ? alpha(th.selection, 0.55) : alpha(th.foreground, 0.25),
    black: p[0],
    red: p[1],
    green: p[2],
    yellow: p[3],
    blue: p[4],
    magenta: p[5],
    cyan: p[6],
    white: p[7],
    brightBlack: p[8],
    brightRed: p[9],
    brightGreen: p[10],
    brightYellow: p[11],
    brightBlue: p[12],
    brightMagenta: p[13],
    brightCyan: p[14],
    brightWhite: p[15]
  }
}

/** The first of the candidates that reads on the background (contrast >= 3), else the foreground. */
function readable(candidates: (string | undefined)[], background: string, fallback: string): string {
  return candidates.find((c): c is string => Boolean(c) && contrast(c!, background) >= 3) ?? fallback
}

/**
 * The app's color tokens (`--wh-*` in styles.css) derived from a terminal theme, for "use the
 * theme across the app": surfaces are steps from the background towards the text, the accent is
 * the theme's blue or cyan, and the status colors are its ANSI green, yellow, red and blue.
 */
export function appTokens(th: TerminalThemeDef): Record<string, string> {
  const bg = th.background
  const fg = th.foreground
  const dark = isDarkTheme(th)
  const p = th.palette
  const accent = readable([p[4], p[12], p[6], p[14], p[5]], bg, fg)
  const success = readable([p[2], p[10]], bg, fg)
  const warning = readable([p[3], p[11]], bg, fg)
  const danger = readable([p[1], p[9]], bg, fg)
  const info = readable([p[4], p[12], p[6]], bg, fg)
  const soft = dark ? 0.16 : 0.12
  return {
    '--wh-bg': bg,
    '--wh-sidebar': mix(bg, dark ? '#000000' : fg, dark ? 0.18 : 0.04),
    '--wh-surface': mix(bg, fg, dark ? 0.04 : 0.02),
    '--wh-surface-raised': mix(bg, fg, dark ? 0.08 : 0.03),
    '--wh-surface-hover': mix(bg, fg, dark ? 0.11 : 0.07),
    '--wh-border': mix(bg, fg, dark ? 0.15 : 0.13),
    '--wh-border-strong': mix(bg, fg, dark ? 0.24 : 0.22),
    '--wh-text': fg,
    '--wh-text-muted': mix(fg, bg, 0.3),
    '--wh-text-subtle': mix(fg, bg, 0.48),
    '--wh-accent': accent,
    '--wh-accent-strong': mix(accent, '#000000', 0.12),
    '--wh-accent-fg': contrast(accent, '#000000') >= contrast(accent, '#ffffff') ? mix('#000000', accent, 0.15) : '#ffffff',
    '--wh-accent-soft': alpha(accent, soft),
    '--wh-accent-2': readable([p[5], p[13]], bg, accent),
    '--wh-success': success,
    '--wh-warning': warning,
    '--wh-danger': danger,
    '--wh-info': info,
    '--wh-success-soft': alpha(success, soft),
    '--wh-warning-soft': alpha(warning, soft),
    '--wh-danger-soft': alpha(danger, soft),
    '--wh-info-soft': alpha(info, soft),
    '--wh-focus': accent
  }
}

/** Every token `appTokens` sets, to clear them when theming the app is turned off. */
export const APP_TOKEN_NAMES = Object.keys(appTokens(fromRow(['', '000000', 'ffffff', '', '', Array(16).fill('808080').join(',')])))

/** Terminal font families offered in Settings; '' is Workhub's default monospace stack. */
export const TERMINAL_FONT_FAMILIES = ['', 'SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Ubuntu Mono', 'DejaVu Sans Mono'] as const

/** A CSS font stack that starts with the chosen family and falls back to the default monospace stack. */
export function terminalFontStack(family: string, fallback: string): string {
  const base = fallback || 'monospace'
  return family ? `"${family.replace(/"/g, '')}", ${base}` : base
}
