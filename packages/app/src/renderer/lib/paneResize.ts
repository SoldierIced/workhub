/**
 * Width math for the side panes' drag handles. `edge` is the side of the pane the handle sits
 * on: the sidebar's handle is on its right edge (dragging right widens it), the monitor's on its
 * left edge (dragging left widens it).
 */
export type PaneEdge = 'left' | 'right'

/** Keyboard step of a handle, in px. */
export const PANE_KEY_STEP = 16

export function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, width)))
}

/** The pane's width while its handle is dragged from `startX` to `x`, within [min, max]. */
export function paneDragWidth(edge: PaneEdge, startWidth: number, startX: number, x: number, min: number, max: number): number {
  const delta = edge === 'right' ? x - startX : startX - x
  return clampWidth(startWidth + delta, min, max)
}

/**
 * The width after an arrow key on a focused handle: the arrow pointing away from the pane widens
 * it. Null for any other key.
 */
export function paneKeyWidth(edge: PaneEdge, width: number, key: string, min: number, max: number): number | null {
  if (key === 'Home') return min
  if (key === 'End') return max
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const widens = edge === 'right' ? key === 'ArrowRight' : key === 'ArrowLeft'
  return clampWidth(width + (widens ? PANE_KEY_STEP : -PANE_KEY_STEP), min, max)
}
