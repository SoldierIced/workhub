import { ArrowRight } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'
import { Button } from '../atoms'
import { cn } from '../../lib/cn'
import { HelpTip } from './HelpTip'

/**
 * Workhub 1's Home surface: a card with 12px padding, a 10px radius and a hairline border, its
 * title row (title, a muted detail, a trailing control) 10px over the content.
 */
export function HomeCard({
  title,
  detail,
  help,
  trailing,
  className,
  children,
  ...rest
}: { title: ReactNode; detail?: ReactNode; help?: ReactNode; trailing?: ReactNode; children: ReactNode } & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className={cn('flex flex-col gap-2.5 rounded-[10px] border border-border bg-surface p-3 shadow-sm', className)} {...rest}>
      <header className="flex min-h-6 items-baseline gap-2">
        <h2 className="shrink-0 text-md font-semibold text-text">{title}</h2>
        {help && <HelpTip text={help} label={typeof title === 'string' ? title : undefined} />}
        {detail && <span className="truncate text-sm text-muted">{detail}</span>}
        {trailing && <div className="ml-auto flex shrink-0 items-center gap-1.5 self-center">{trailing}</div>}
      </header>
      {children}
    </section>
  )
}

/** What a Home card shows when its source is not set up: the reason and, optionally, a way to fix it. */
export function HomeNote({ text, actionLabel, onAction }: { text: ReactNode; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted">{text}</span>
      {actionLabel && onAction && (
        <Button size="sm" variant="ghost" className="shrink-0 text-accent hover:text-accent" onClick={onAction}>
          {actionLabel}
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  )
}

/** A row inside a Home card: a slightly lighter inset (Workhub 1's `homeInsetRow`). */
export const HOME_INSET_ROW = 'rounded-lg bg-surface-hover/60 p-2'
