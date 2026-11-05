import type { ReactNode } from 'react'
import { Tooltip } from '../../components/atoms'
import { cn } from '../../lib/cn'

export interface SegmentedOption<T extends string | number> {
  value: T
  label: ReactNode
  icon?: ReactNode
  /** Shown on hover and focus. */
  tooltip?: string
}

/**
 * A compact row of mutually exclusive choices in one frame (window, view, environment). `tabs`
 * announces them as tabs (the environments switch what the whole screen shows); otherwise they are
 * pressed buttons in a labelled group.
 */
export function Segmented<T extends string | number>({ label, value, options, onChange, tabs = false, className }: { label: string; value: T; options: SegmentedOption<T>[]; onChange: (value: T) => void; tabs?: boolean; className?: string }) {
  return (
    <div role={tabs ? 'tablist' : 'group'} aria-label={label} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface p-0.5', className)}>
      {options.map((o) => {
        const active = o.value === value
        const button = (
          <button
            key={String(o.value)}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? active : undefined}
            aria-pressed={tabs ? undefined : active}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              active ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:bg-surface-hover hover:text-text'
            )}
          >
            {o.icon}
            {o.label}
          </button>
        )
        return o.tooltip ? (
          <Tooltip key={String(o.value)} content={o.tooltip}>
            {button}
          </Tooltip>
        ) : (
          button
        )
      })}
    </div>
  )
}
