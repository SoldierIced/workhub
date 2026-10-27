import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  /** A small label above the title, e.g. the phase that brings the screen. */
  eyebrow?: ReactNode
  compact?: boolean
  className?: string
}

export function EmptyState({ icon, title, description, action, eyebrow, compact, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 py-6' : 'gap-3 py-16', className)}>
      {icon && (
        <div
          className={cn(
            'flex items-center justify-center rounded-xl border border-border bg-surface-raised text-accent shadow-sm',
            compact ? 'size-9' : 'size-14'
          )}
        >
          {icon}
        </div>
      )}
      {eyebrow}
      <h2 className={cn('font-semibold text-text', compact ? 'text-base' : 'text-lg')}>{title}</h2>
      {description && <p className={cn('max-w-md text-muted', compact ? 'text-sm' : 'text-base')}>{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
