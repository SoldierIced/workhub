import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '../../lib/cn'
import { paneDragWidth, paneKeyWidth, type PaneEdge } from '../../lib/paneResize'

export interface PaneResizeHandleProps {
  /** The pane's edge the handle sits on. */
  edge: PaneEdge
  width: number
  min: number
  max: number
  /** Accessible name ("Resize the sidebar"). */
  label: string
  /** Tooltip, e.g. how to reset. */
  title?: string
  /** Called while dragging (`done` false) and once when the drag, a key press or a reset ends (`done` true). */
  onWidth: (width: number, done: boolean) => void
  /** Double click: back to the default width. */
  onReset: () => void
}

/**
 * The drag handle on a side pane's edge: drag to resize, arrows (Home, End) from the keyboard,
 * double click to reset. The pane must be `relative`; the handle straddles its border.
 */
export function PaneResizeHandle({ edge, width, min, max, label, title, onWidth, onReset }: PaneResizeHandleProps) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const at = (e: ReactPointerEvent<HTMLDivElement>) => paneDragWidth(edge, start.current!.w, start.current!.x, e.clientX, min, max)
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    start.current = { x: e.clientX, w: width }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (start.current) onWidth(at(e), false)
  }
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    onWidth(at(e), true)
    start.current = null
    setDragging(false)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      title={title}
      tabIndex={0}
      data-pane-handle={edge}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const next = paneKeyWidth(edge, width, e.key, min, max)
        if (next === null) return
        e.preventDefault()
        onWidth(next, true)
      }}
      className={cn(
        'absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none transition-colors select-none hover:bg-accent/30 focus-visible:bg-accent/40',
        edge === 'right' ? '-right-1' : '-left-1',
        dragging && 'bg-accent/40'
      )}
    />
  )
}
