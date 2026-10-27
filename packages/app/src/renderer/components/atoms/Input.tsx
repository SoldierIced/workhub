import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

const FIELD =
  'w-full rounded-md border border-border bg-surface px-2.5 text-base text-text placeholder:text-subtle shadow-sm transition-colors duration-150 ' +
  'hover:border-border-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(FIELD, 'h-8', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref
) {
  return <textarea ref={ref} className={cn(FIELD, 'resize-y py-1.5 font-mono text-sm', className)} {...rest} />
})
