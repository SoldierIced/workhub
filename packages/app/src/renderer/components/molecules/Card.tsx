import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { HelpTip } from './HelpTip'

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface shadow-sm', className)} {...rest}>
      {children}
    </section>
  )
}

export interface CardHeaderProps {
  title: ReactNode
  /** Muted text right after the title (Workhub 1's "2 active · 1 needs you"). */
  meta?: ReactNode
  actions?: ReactNode
  icon?: ReactNode
  /** Longer explanation, in an (i) tooltip next to the title. */
  help?: ReactNode
  /** Heading level for the title; defaults to h2. */
  as?: 'h2' | 'h3'
  className?: string
}

export function CardHeader({ title, meta, actions, icon, help, as: H = 'h2', className }: CardHeaderProps) {
  return (
    <header className={cn('flex min-h-11 items-center gap-2 px-4 pt-3 pb-2', className)}>
      {icon && <span className="text-muted">{icon}</span>}
      <H className="text-md font-semibold text-text">{title}</H>
      {help && <HelpTip text={help} label={typeof title === 'string' ? title : undefined} />}
      {meta && <span className="truncate text-sm text-muted">{meta}</span>}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </header>
  )
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-4 pb-4', className)}>{children}</div>
}
