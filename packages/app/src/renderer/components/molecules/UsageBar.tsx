import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface UsageBarProps {
  /** The window name (`5h`, `weekly`…). */
  label: string
  percent: number
  /** The account's ceiling for this window, drawn as a mark on the bar. */
  ceiling?: number
  /** A line under the bar (reset countdown, "from a session file"). */
  caption?: ReactNode
  className?: string
}

/** One plan usage window: name, bar (with the ceiling mark when one is set) and percent. */
export function UsageBar({ label, percent, ceiling, caption, className }: UsageBarProps) {
  const over = ceiling !== undefined && percent >= ceiling
  const tone = over || percent >= 90 ? 'bg-danger' : (ceiling !== undefined && percent >= ceiling - 5) || percent >= 75 ? 'bg-warning' : 'brand-gradient'
  return (
    <div className={cn('grid grid-cols-[4.5rem_1fr_2.75rem] items-center gap-x-2 gap-y-0.5 text-xs', className)}>
      <span className="truncate text-muted" title={label}>
        {label}
      </span>
      <span
        className="relative h-1.5 overflow-hidden rounded-full bg-surface-hover"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span className={cn('block h-full rounded-full', tone)} style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
        {ceiling !== undefined && <span className="absolute top-0 h-full w-0.5 bg-text/70" style={{ left: `calc(${Math.min(100, ceiling)}% - 1px)` }} aria-hidden />}
      </span>
      <span className={cn('text-right font-medium tabular-nums', over && 'text-danger')}>{Math.round(percent)}%</span>
      {caption && <span className="col-span-3 text-right text-2xs text-subtle">{caption}</span>}
    </div>
  )
}
