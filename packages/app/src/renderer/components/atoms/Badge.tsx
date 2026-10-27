import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-hover text-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info'
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
  icon?: ReactNode
}

export function Badge({ tone = 'neutral', icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium', TONE[tone], className)}
      {...rest}
    >
      {icon}
      {children}
    </span>
  )
}
