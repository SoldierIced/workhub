import type { ChromeColors } from '../shared/api'

export type { ChromeColors }

/**
 * The colors the renderer reports for the window controls overlay (Windows, Linux). Only
 * `#rgb`/`#rrggbb` reach the native overlay; anything else (an empty token, a named color,
 * a malformed message) is ignored and the light/dark defaults stay.
 */
export function chromeColorsFrom(raw: unknown): ChromeColors | null {
  if (!raw || typeof raw !== 'object') return null
  const { color, symbolColor } = raw as Record<string, unknown>
  const hex = (v: unknown): v is string => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)
  return hex(color) && hex(symbolColor) ? { color, symbolColor } : null
}
