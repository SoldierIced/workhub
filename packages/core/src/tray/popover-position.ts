/**
 * Where the tray popover opens: under a menu bar icon (macOS, a top taskbar), above a bottom
 * taskbar's notification area (Windows' default), or beside a vertical taskbar, always inside the
 * display's work area. Pure geometry so it can be tested without a screen.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type PopoverEdge = 'top' | 'bottom' | 'left' | 'right'

export interface PopoverPlacementInput {
  /** The tray icon's bounds in screen coordinates; an empty rect when the platform does not tell. */
  tray: Rect
  /** The display's work area (screen minus menu bar / taskbar / dock). */
  workArea: Rect
  /** The display's full bounds, to tell which edge the taskbar sits on. */
  display: Rect
  width: number
  height: number
  /** Where to anchor when the tray bounds are empty (the cursor). */
  fallback?: { x: number; y: number }
  /** Space kept between the popover and the icon, and from the work area's edges. */
  gap?: number
}

export interface PopoverPlacement {
  x: number
  y: number
  width: number
  height: number
  /** The side of the screen the popover hangs from. */
  edge: PopoverEdge
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max))

/**
 * The edge the icon's bar sits on: the side of the work area the icon is outside of (the macOS
 * menu bar is above it even with the Dock at the bottom). An icon inside the work area (an
 * auto-hidden taskbar) goes by the nearest display edge.
 */
export function taskbarEdge(tray: Rect, workArea: Rect, display: Rect): PopoverEdge {
  const cx = tray.x + tray.width / 2
  const cy = tray.y + tray.height / 2
  if (cy < workArea.y) return 'top'
  if (cy > workArea.y + workArea.height) return 'bottom'
  if (cx < workArea.x) return 'left'
  if (cx > workArea.x + workArea.width) return 'right'
  const distances: [PopoverEdge, number][] = [
    ['top', cy - display.y],
    ['bottom', display.y + display.height - cy],
    ['left', cx - display.x],
    ['right', display.x + display.width - cx]
  ]
  return distances.reduce((best, d) => (d[1] < best[1] ? d : best))[0]
}

/** The popover's size clamped to the work area, keeping `gap` free on each side. */
export function popoverSize(width: number, height: number, workArea: Rect, gap = 6): { width: number; height: number } {
  return {
    width: Math.round(Math.min(width, workArea.width - gap * 2)),
    height: Math.round(Math.min(height, workArea.height - gap * 2))
  }
}

export function popoverPlacement(input: PopoverPlacementInput): PopoverPlacement {
  const gap = input.gap ?? 6
  const { workArea, display } = input
  const known = input.tray.width > 0 || input.tray.height > 0
  const anchor: Rect = known ? input.tray : { x: input.fallback?.x ?? workArea.x + workArea.width, y: input.fallback?.y ?? workArea.y, width: 0, height: 0 }
  const { width, height } = popoverSize(input.width, input.height, workArea, gap)
  const edge = taskbarEdge(anchor, workArea, display)
  const minX = workArea.x + gap
  const maxX = workArea.x + workArea.width - width - gap
  const minY = workArea.y + gap
  const maxY = workArea.y + workArea.height - height - gap
  const centerX = anchor.x + anchor.width / 2 - width / 2
  const centerY = anchor.y + anchor.height / 2 - height / 2
  let x: number
  let y: number
  switch (edge) {
    case 'top':
      x = clamp(centerX, minX, maxX)
      y = clamp(Math.max(anchor.y + anchor.height, workArea.y) + gap, minY, maxY)
      break
    case 'bottom':
      x = clamp(centerX, minX, maxX)
      y = clamp(Math.min(anchor.y, workArea.y + workArea.height) - height - gap, minY, maxY)
      break
    case 'left':
      x = clamp(Math.max(anchor.x + anchor.width, workArea.x) + gap, minX, maxX)
      y = clamp(centerY, minY, maxY)
      break
    case 'right':
      x = clamp(Math.min(anchor.x, workArea.x + workArea.width) - width - gap, minX, maxX)
      y = clamp(centerY, minY, maxY)
      break
  }
  return { x: Math.round(x), y: Math.round(y), width, height, edge }
}
