import { CircleAlert, CircleCheck, LoaderCircle, MessageCircleQuestionMark, type LucideIcon } from 'lucide-react'
import type { HTMLAttributes } from 'react'
import type { StatusLevel } from '@workhub/core'
import { cn } from '../../lib/cn'

const GLYPH: Record<StatusLevel, { icon: LucideIcon; className: string }> = {
  error: { icon: CircleAlert, className: 'text-danger' },
  needsAnswer: { icon: MessageCircleQuestionMark, className: 'animate-pulse text-warning' },
  readyToReview: { icon: CircleCheck, className: 'text-success' },
  working: { icon: LoaderCircle, className: 'animate-spin text-info' }
}

/**
 * What a session is up to, as one glyph that reads at a glance where a coloured dot does not: a
 * spinner while it works, a pulsing question mark while it waits on an answer, a check once a reply
 * is ready to read, an alert on an error. With a `label` it is announced; without one it is
 * decorative (the state is in text beside it).
 */
export function StatusGlyph({ level, label, className, ...rest }: { level: StatusLevel; label?: string } & HTMLAttributes<HTMLSpanElement>) {
  const { icon: Icon, className: tone } = GLYPH[level]
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true }
  return (
    <span {...a11y} data-level={level} className={cn('inline-flex shrink-0', className)} {...rest}>
      <Icon className={cn('size-3.5', tone)} aria-hidden />
    </span>
  )
}
