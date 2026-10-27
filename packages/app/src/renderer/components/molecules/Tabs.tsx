import { Tabs as RTabs } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface TabItem {
  value: string
  label: string
  icon?: ReactNode
  content: ReactNode
}

export function Tabs({ items, value, onChange, label, className }: { items: TabItem[]; value: string; onChange: (v: string) => void; label: string; className?: string }) {
  return (
    <RTabs.Root value={value} onValueChange={onChange} className={cn('flex min-h-0 flex-col', className)}>
      <RTabs.List aria-label={label} className="flex shrink-0 gap-1 border-b border-border">
        {items.map((i) => (
          <RTabs.Trigger
            key={i.value}
            value={i.value}
            className={cn(
              'relative -mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent px-3 text-base text-muted transition-colors duration-150',
              'hover:text-text data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-text'
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
