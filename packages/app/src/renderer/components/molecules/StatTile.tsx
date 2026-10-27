import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Spinner } from '../atoms/Spinner'

export interface StatTileProps {
  label: string
  /** The figure; `null` shows a dash (no data). */
  value: ReactNode | null
  /** Line under the value: what the figure means, or why there is none. */
  caption?: ReactNode
  loading?: boolean
  action?: ReactNode
  className?: string
}

export function StatTile({ label, value, caption, loading, action, className }: StatTileProps) {
  return (
    <section aria-label={label} className={cn('flex min-h-28 flex-col rounded-lg border border-border bg-surface p-4 shadow-sm', className)}>
      <div className="flex items-center gap-2 text-sm text-muted">
        {label}
        {loading && <Spinner className="size-3" />}
      </div>
      <div className={cn('mt-2 text-2xl font-semibold tracking-tight tabular-nums', value === null && 'text-subtle')}>{value ?? '—'}</div>
      <div className="mt-auto flex items-end justify-between gap-2 pt-2">
        {caption && <div className="text-sm text-muted">{caption}</div>}
        {action}
      </div>
    </section>
  )
}
