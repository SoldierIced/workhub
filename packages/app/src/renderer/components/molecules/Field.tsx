import { cloneElement, useId, type ReactElement, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface FieldProps {
  label: string
  hint?: ReactNode
  /** The control; it receives the generated id so the label points at it. */
  children: ReactElement<{ id?: string }>
  className?: string
}

/** A labelled form control. */
export function Field({ label, hint, children, className }: FieldProps) {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-muted">
        {label}
      </label>
      {cloneElement(children, { id })}
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  )
}

/** A label + switch row, Workhub 1 settings style. */
export function SwitchRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-base text-text">
          {label}
        </label>
        {hint && <p className="text-xs text-subtle">{hint}</p>}
      </div>
      {cloneElement(children, { id })}
    </div>
  )
}
