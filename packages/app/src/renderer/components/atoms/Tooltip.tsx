import { Tooltip as RTooltip } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'

/** Wrap the app once; tooltips then share one delay. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RTooltip.Provider delayDuration={400}>{children}</RTooltip.Provider>
}

export function Tooltip({ content, side = 'bottom', children }: { content: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactElement }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 animate-fade-in rounded-sm border border-border bg-surface-raised px-2 py-1 text-sm text-text shadow-md"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}
