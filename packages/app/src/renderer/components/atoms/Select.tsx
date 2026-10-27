import { Check, ChevronDown } from 'lucide-react'
import { Select as RSelect } from 'radix-ui'
import { cn } from '../../lib/cn'

export interface SelectOption {
  value: string
  label: string
}

/** Radix forbids an empty item value; an empty value ("none") maps to this sentinel internally. */
const EMPTY = '__none__'

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  /** Accessible name when no visible label is associated. */
  'aria-label'?: string
  id?: string
  disabled?: boolean
  placeholder?: string
  className?: string
}

export function Select({ value, onChange, options, disabled, placeholder, className, id, ...aria }: SelectProps) {
  return (
    <RSelect.Root value={value === '' ? EMPTY : value} onValueChange={(v) => onChange(v === EMPTY ? '' : v)} disabled={disabled}>
      <RSelect.Trigger
        id={id}
        aria-label={aria['aria-label']}
        className={cn(
          'inline-flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 text-left text-base text-text shadow-sm',
          'transition-colors duration-150 hover:border-border-strong data-[placeholder]:text-subtle',
          'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-50',
          className
        )}
      >
        <span className="truncate">
          <RSelect.Value placeholder={placeholder} />
        </span>
        <RSelect.Icon>
          <ChevronDown className="size-3.5 text-muted" aria-hidden />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] animate-fade-in overflow-hidden rounded-md border border-border bg-surface-raised p-1 shadow-lg"
        >
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item
                key={o.value || EMPTY}
                value={o.value === '' ? EMPTY : o.value}
                className="relative flex h-7 cursor-default select-none items-center rounded-sm pl-7 pr-2 text-base text-text outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-text"
              >
                <RSelect.ItemIndicator className="absolute left-2 inline-flex">
                  <Check className="size-3.5 text-accent" aria-hidden />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  )
}
