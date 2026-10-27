import { cloneElement, useId, type ReactElement, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { HelpTip } from './HelpTip'

export interface FieldProps {
  label: string
  hint?: ReactNode
  /** Longer explanation, in an (i) tooltip next to the label. */
  help?: ReactNode
  /** A problem with the value, shown under the control. */
  error?: string
  /** The control; it receives the generated id so the label points at it. */
  children: ReactElement<{ id?: string }>
  className?: string
}

/** A labelled form control. */
export function Field({ label, hint, help, error, children, className }: FieldProps) {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-muted">
          {label}
        </label>
        {help && <HelpTip text={help} label={label} />}
      </span>
      {cloneElement(children, { id })}
      {hint && <p className="text-xs text-subtle">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** A label + switch row, Workhub 1 settings style. */
export function SwitchRow({ label, hint, help, children }: { label: string; hint?: ReactNode; help?: ReactNode; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <span className="flex items-center gap-1.5">
          <label htmlFor={id} className="block text-base text-text">
            {label}
          </label>
          {help && <HelpTip text={help} label={label} />}
        </span>
        {hint && <p className="text-xs text-subtle">{hint}</p>}
      </div>
      {cloneElement(children, { id })}
    </div>
  )
}
