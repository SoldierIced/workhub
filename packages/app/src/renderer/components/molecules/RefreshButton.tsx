import { RefreshCw, type LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Button, IconButton } from '../atoms'
import { cn } from '../../lib/cn'
import { useRefreshGuard } from '../../lib/refreshGuard'

export interface RefreshButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  /** Accessible name and tooltip (the text of a `button` variant). */
  label: string
  /** Called on click. When it returns a promise the button is busy until it settles. */
  onRefresh?: () => unknown
  /** Busy state owned by a data hook; the button is busy while either this or `onRefresh` is pending. */
  loading?: boolean
  variant?: 'icon' | 'button'
  size?: 'sm' | 'md'
  icon?: LucideIcon
  /** Size of the icon, as a Tailwind `size-` class. */
  iconClassName?: string
  /** Extra tooltip content of the icon variant. */
  hint?: ReactNode
}

/**
 * The one reload control: its icon spins while loading, and the button is disabled and `aria-busy`
 * so it cannot be pressed again before the data arrives. Reduced motion pulses instead of spinning.
 */
export function RefreshButton({ label, onRefresh, loading = false, variant = 'icon', size = 'sm', icon: Icon = RefreshCw, iconClassName = 'size-3.5', hint, className, disabled, ...rest }: RefreshButtonProps) {
  const { busy, trigger } = useRefreshGuard(onRefresh)
  const isBusy = loading || busy
  const icon = <Icon className={cn(iconClassName, isBusy && 'animate-spin motion-reduce:animate-pulse')} aria-hidden />
  const common = { disabled: isBusy || disabled, 'aria-busy': isBusy, onClick: () => !isBusy && trigger(), className, ...rest }
  return variant === 'button' ? (
    <Button size={size} icon={icon} {...common}>
      {label}
    </Button>
  ) : (
    <IconButton size={size} label={label} hint={hint} icon={icon} {...common} />
  )
}
