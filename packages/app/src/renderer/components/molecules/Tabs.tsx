import { Tabs as RTabs } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface TabItem {
  value: string
  label: string
  icon?: ReactNode
  content: ReactNode
}

export interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (v: string) => void
  label: string
  className?: string
  /**
   * `underline` (default): a row of tabs over a rule. `fill`: a segmented bar as wide as its
   * container; the tabs share the width and wrap onto more rows in a narrow window.
   */
  variant?: 'underline' | 'fill'
}

export function Tabs({ items, value, onChange, label, className, variant = 'underline' }: TabsProps) {
  const fill = variant === 'fill'
  return (
    <RTabs.Root value={value} onValueChange={onChange} className={cn('flex min-h-0 flex-col', className)}>
      <RTabs.List
        aria-label={label}
        className={cn(
          'flex shrink-0',
          fill ? 'w-full flex-wrap gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-sm' : 'gap-1 border-b border-border'
        )}
      >
        {items.map((i) => (
          <RTabs.Trigger
            key={i.value}
            value={i.value}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap text-base text-muted transition-colors duration-150 hover:text-text',
              fill
                ? 'h-8 flex-auto justify-center rounded-md px-2.5 hover:bg-surface-hover data-[state=active]:bg-accent-soft data-[state=active]:font-medium data-[state=active]:text-accent'
                : 'relative -mb-px h-9 border-b-2 border-transparent px-3 data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-text'
            )}
          >
            {i.icon}
            {i.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {items.map((i) => (
        <RTabs.Content key={i.value} value={i.value} className="min-h-0 flex-1 animate-slide-in pt-5 focus-visible:outline-none">
          {i.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  )
}
