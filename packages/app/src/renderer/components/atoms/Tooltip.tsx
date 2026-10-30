import { Tooltip as RTooltip } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../lib/cn'

/**
 * Wrap the app once; tooltips then share one delay. The bubble is never hoverable: it closes as
 * soon as the pointer leaves its trigger. A hoverable bubble kept itself open while the pointer sat
 * on it, which looped on the session rows (the hover shows the row's actions, the name button
 * shrinks, the bubble anchored to it jumps under the pointer, the row loses its hover and grows
 * back, and so on).
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={400} disableHoverableContent>
      {children}
    </RTooltip.Provider>
  )
}

/**
 * A hover (and focus) tooltip, rendered in a portal so no `overflow-hidden` ancestor clips it, and
 * kept inside the window (it flips or shifts when it would leave it).
 */
export function Tooltip({
  content,
  side = 'bottom',
  align = 'center',
  className,
  testId,
  children
}: {
  content: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** Extra classes for the bubble (e.g. a wider `max-w-*`). */
  className?: string
  testId?: string
  children: ReactElement
}) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          data-testid={testId}
          className={cn('z-50 animate-fade-in rounded-sm border border-border bg-surface-raised px-2 py-1 text-sm text-text shadow-md', className)}
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}
