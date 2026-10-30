import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Tabs as RTabs } from 'radix-ui'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type WheelEvent } from 'react'
import { cn } from '../../lib/cn'

export interface TabItem {
  value: string
  label: string
  icon?: ReactNode
  content: ReactNode
}

export interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (v: string) => void
  label: string
  className?: string
  /**
   * `underline` (default): a row of tabs over a rule. `fill`: a segmented bar as wide as its
   * container; the tabs share the width and wrap onto more rows in a narrow window.
   */
  variant?: 'underline' | 'fill'
  /**
   * Content kept above the tab bar. With `header` set, it and the bar stay pinned to the top of the
   * scrolling parent while the panels scroll under them (capped, so a long header never hides the panel).
   */
  header?: ReactNode
  /** Extra classes for the row of tabs and for each panel (a window that scrolls each panel on its own). */
  listClassName?: string
  contentClassName?: string
}

export function Tabs({ items, value, onChange, label, className, variant = 'underline', header, listClassName, contentClassName }: TabsProps) {
  const fill = variant === 'fill'
  const scroller = useTabScroller(value, !fill)
  const triggers = items.map((i) => (
    <RTabs.Trigger
      key={i.value}
      value={i.value}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-base text-muted transition-colors duration-150 hover:text-text',
        fill
          ? 'h-8 min-w-0 flex-auto justify-center rounded-md px-2 hover:bg-surface-hover data-[state=active]:bg-accent-soft data-[state=active]:font-medium data-[state=active]:text-accent'
          : 'relative h-9 border-b-2 border-transparent px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-text'
      )}
    >
      {i.icon}
      {i.label}
    </RTabs.Trigger>
  ))
  const list = fill ? (
    <RTabs.List aria-label={label} className={cn('no-scrollbar flex w-full shrink-0 flex-nowrap gap-0.5 overflow-x-auto rounded-lg border border-border bg-surface p-1 shadow-sm', listClassName)}>
      {triggers}
    </RTabs.List>
  ) : (
    // One row over a rule. When the tabs do not fit, the row scrolls sideways (wheel, trackpad,
    // keyboard; the chosen tab is kept in view) and a fade at the cut edge says there is more.
    <div className="relative shrink-0 border-b border-border">
      <RTabs.List
        ref={scroller.ref}
        aria-label={label}
        onScroll={scroller.update}
        onWheel={scroller.onWheel}
        className={cn('no-scrollbar flex gap-1 overflow-x-auto overflow-y-hidden', listClassName)}
        style={scroller.mask ? { maskImage: scroller.mask, WebkitMaskImage: scroller.mask } : undefined}
        data-overflow={scroller.edges.left || scroller.edges.right ? '' : undefined}
      >
        {triggers}
      </RTabs.List>
      {/* Pointer shortcuts over the fades (the keyboard moves with the arrows). */}
      {scroller.edges.left && <ScrollNudge side="left" onClick={() => scroller.nudge(-1)} />}
      {scroller.edges.right && <ScrollNudge side="right" onClick={() => scroller.nudge(1)} />}
    </div>
  )
  return (
    <RTabs.Root value={value} onValueChange={onChange} className={cn('flex min-h-0 flex-col', className)}>
      {header ? (
        <div className="sticky top-0 z-20 -mx-1 flex shrink-0 flex-col gap-4 bg-bg px-1 pt-7 pb-3" data-testid="pinned-header">
          {/* Inset by the focus ring's reach, so the scroller does not clip a focused control at its edge. */}
          <div className="-mx-1 -mt-1 flex max-h-[40vh] flex-col gap-4 overflow-y-auto px-1 pt-1">{header}</div>
          {list}
        </div>
      ) : (
        list
      )}
      {items.map((i) => (
        <RTabs.Content key={i.value} value={i.value} className={cn('min-h-0 flex-1 animate-slide-in pt-5 focus-visible:outline-none', contentClassName)}>
          {i.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  )
}

const FADE = '2.5rem'

/** Sideways scrolling for a row of tabs: which edges hide tabs, a mask that fades them, wheel to scroll. */
function useTabScroller(value: string, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [enabled, update])
  // The chosen tab stays in view, also when it is chosen from elsewhere (a badge that opens the Slack tab).
  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return
    const active = el.querySelector<HTMLElement>('[data-state="active"]')
    if (!active) return
    const start = active.offsetLeft - el.offsetLeft
    const end = start + active.offsetWidth
    // Clear of the fade and its button at either edge.
    const margin = 48
    if (start < el.scrollLeft + margin) el.scrollLeft = Math.max(0, start - margin)
    else if (end > el.scrollLeft + el.clientWidth - margin) el.scrollLeft = end - el.clientWidth + margin
    update()
  }, [enabled, value, update])
  // A mouse wheel only scrolls up and down: turn it sideways while the row overflows.
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
    el.scrollLeft += e.deltaY
  }
  const nudge = (direction: 1 | -1) => ref.current?.scrollBy({ left: direction * ref.current.clientWidth * 0.6, behavior: 'smooth' })
  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? 'transparent' : 'black'}, black ${edges.left ? FADE : '0'}, black calc(100% - ${edges.right ? FADE : '0px'}), ${edges.right ? 'transparent' : 'black'})`
      : undefined
  return { ref, edges, update, onWheel, nudge, mask }
}

function ScrollNudge({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      onClick={onClick}
      className={cn(
        'absolute top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface-raised text-muted shadow-sm transition-colors duration-150 hover:text-text',
        side === 'left' ? 'left-1' : 'right-1'
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  )
}
