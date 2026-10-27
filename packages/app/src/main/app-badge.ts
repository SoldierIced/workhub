import { trayAttention, type TraySession } from '@workhub/core'

/** How many sessions need a look (an error, a question or permission, an unread reply): the number the tray counts too. */
export function attentionBadgeCount(sessions: readonly TraySession[]): number {
  return trayAttention(sessions).sessions.length
}

// A 3x5 pixel font for the overlay: digits and "+", one row per string, 1 = ink.
const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
}

/** What the badge writes: the count up to 9, then "9+" (two glyphs are all a 16 px overlay can hold). */
export function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(Math.max(0, Math.floor(count)))
}

/** The overlay as raw BGRA pixels (what `nativeImage.createFromBitmap` takes): a red disc with the count in white. */
export function renderBadgeBitmap(count: number, size = 32): Buffer {
  const out = Buffer.alloc(size * size * 4)
  const label = badgeLabel(count)
  const scale = Math.max(1, Math.floor(size / 11))
  const glyphW = 3 * scale
  const gap = scale
  const textW = label.length * glyphW + (label.length - 1) * gap
  const x0 = Math.round((size - textW) / 2)
  const y0 = Math.round((size - 5 * scale) / 2)
  const ink = (x: number, y: number): boolean => {
    const col = x - x0
    const row = y - y0
    if (row < 0 || row >= 5 * scale || col < 0 || col >= textW) return false
    const slot = Math.floor(col / (glyphW + gap))
    const inGlyph = col - slot * (glyphW + gap)
    if (inGlyph >= glyphW) return false
    return GLYPHS[label[slot]!]?.[Math.floor(row / scale)]?.[Math.floor(inGlyph / scale)] === '1'
  }
  const r = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 4 samples per pixel soften the disc's edge.
      let covered = 0
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
        if (Math.hypot(x + dx - r, y + dy - r) <= r - 0.5) covered += 1
      }
      if (covered === 0) continue
      const i = (y * size + x) * 4
      const white = ink(x, y)
      out[i] = white ? 255 : 0x3c // B
      out[i + 1] = white ? 255 : 0x3b // G
      out[i + 2] = white ? 255 : 0xe0 // R
      out[i + 3] = Math.round((covered / 4) * 255)
    }
  }
  return out
}

export interface AppBadgeDeps {
  platform: NodeJS.Platform
  /** `app.setBadgeCount`: the Dock on macOS, the launcher on Linux (Unity). */
  setBadgeCount: (count: number) => void
  /** Windows: the overlay on the taskbar button of the main window, null to clear it. */
  setOverlay: (bitmap: { data: Buffer; size: number } | null, description: string) => void
  /** The overlay's accessible description, in the language of the UI. */
  describe: (count: number) => string
}

/** The app icon's badge: the number of sessions that need a look, when the user wants it. */
export class AppBadge {
  private count = 0
  private enabled = true
  private applied: number | null = null

  constructor(private readonly deps: AppBadgeDeps) {}

  setCount(count: number): void {
    this.count = Math.max(0, Math.floor(count) || 0)
    this.apply()
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.apply()
  }

  /** Apply again, e.g. after the main window was recreated (a Windows overlay belongs to the window). */
  refresh(): void {
    this.applied = null
    this.apply()
  }

  private apply(): void {
    const shown = this.enabled ? this.count : 0
    if (shown === this.applied) return
    this.applied = shown
    if (this.deps.platform === 'win32') {
      this.deps.setOverlay(shown > 0 ? { data: renderBadgeBitmap(shown), size: 32 } : null, shown > 0 ? this.deps.describe(shown) : '')
    } else {
      this.deps.setBadgeCount(shown)
    }
  }
}
