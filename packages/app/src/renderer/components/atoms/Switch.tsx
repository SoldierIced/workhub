import { Switch as RSwitch } from 'radix-ui'
import { cn } from '../../lib/cn'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  id?: string
  disabled?: boolean
  'aria-label'?: string
  className?: string
}

export function Switch({ checked, onChange, id, disabled, className, ...aria }: SwitchProps) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={aria['aria-label']}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border bg-surface-hover transition-colors duration-150',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50',
        className
      )}
    >
      <RSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out data-[state=checked]:translate-x-[17px]" />
    </RSwitch.Root>
  )
}
