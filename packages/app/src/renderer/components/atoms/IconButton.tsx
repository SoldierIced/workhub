import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Tooltip } from './Tooltip'

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also shown as the tooltip. */
  label: string
  /** Extra tooltip content, e.g. the shortcut. */
  hint?: ReactNode
  icon: ReactNode
  size?: 'sm' | 'md'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, hint, icon, size = 'md', className, type = 'button', ...rest },
  ref
) {
  return (
    <Tooltip
      content={
        <span className="flex items-center gap-2">
          {label}
          {hint}
        </span>
      }
    >
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text',
          'disabled:pointer-events-none disabled:opacity-45',
          // A caller's own size- class wins: `cn` only joins, so both would apply and the stylesheet's order would pick.
          !/(^|\s)size-/.test(className ?? '') && (size === 'sm' ? 'size-7' : 'size-8'),
          className
        )}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  )
})
