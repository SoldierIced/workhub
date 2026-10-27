import { LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/cn'

/** Decorative unless `label` is given. */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <LoaderCircle
      className={cn('size-4 shrink-0 animate-spin text-muted', className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}
