import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-strong shadow-sm font-semibold',
  secondary: 'bg-surface-raised text-text border border-border hover:bg-surface-hover hover:border-border-strong shadow-sm',
  ghost: 'text-muted hover:text-text hover:bg-surface-hover',
  danger: 'bg-danger-soft text-danger border border-transparent hover:border-danger/40'
}
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-sm gap-1.5 rounded-sm',
  md: 'h-8 px-3.5 text-base gap-2 rounded-md'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})
