import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

const FIELD =
  'rounded-md border border-border bg-surface text-text placeholder:text-subtle shadow-sm transition-colors duration-150 ' +
  'hover:border-border-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The field's default width, height, padding and text size, each left out when the caller's class
 * names already set it. `cn` only joins classes, so `w-full` and a caller's `w-20` would both
 * apply and the stylesheet's order, not the caller, would decide which one wins.
 */
export function fieldDefaults(className: string | undefined, defaults: { height?: string; text: string }): string {
  const has = (pattern: RegExp) => pattern.test(className ?? '')
  return cn(
    !has(/(^|\s)!?w-/) && 'w-full',
    defaults.height && !has(/(^|\s)!?h-/) && defaults.height,
    !has(/(^|\s)!?(px|pl)-/) && 'pl-2.5',
    !has(/(^|\s)!?(px|pr)-/) && 'pr-2.5',
    !has(/(^|\s)!?text-(2xs|xs|sm|base|lg|xl)\b/) && defaults.text
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(FIELD, fieldDefaults(className, { height: 'h-8', text: 'text-base' }), className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref
) {
  return <textarea ref={ref} className={cn(FIELD, fieldDefaults(className, { text: 'text-sm' }), 'resize-y py-1.5 font-mono', className)} {...rest} />
})
