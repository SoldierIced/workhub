import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface ListRowProps {
  title: ReactNode
  subtitle?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  selected?: boolean
  onClick?: () => void
  onDoubleClick?: () => void
  className?: string
  /** Accessible name when the visible content is not enough. */
  'aria-label'?: string
}

/** A row in a list; a button when clickable. */
export function ListRow({ title, subtitle, leading, trailing, selected, onClick, onDoubleClick, className, ...aria }: ListRowProps) {
  const body = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {subtitle && <span className="block truncate text-sm text-muted">{subtitle}</span>}
      </span>
      {trailing && <span className="shrink-0 text-sm text-muted">{trailing}</span>}
    </>
  )
  const cls = cn(
    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-base transition-colors duration-150',
    onClick && 'hover:bg-surface-hover',
    selected && 'bg-accent-soft text-text hover:bg-accent-soft',
    className
  )
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} onDoubleClick={onDoubleClick} aria-current={selected ? 'true' : undefined} aria-label={aria['aria-label']}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}
