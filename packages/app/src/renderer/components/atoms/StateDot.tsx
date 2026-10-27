import type { SessionState } from '@workhub/core'
import { cn } from '../../lib/cn'
import type { Tone } from './Badge'

export const STATE_TONE: Record<SessionState, Tone> = {
  starting: 'warning',
  ready: 'success',
  busy: 'info',
  stopped: 'neutral',
  error: 'danger'
}

const DOT: Record<Tone, string> = {
  neutral: 'bg-subtle',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info'
}

/** A small status dot; decorative, so callers put the state in text next to it. */
export function StateDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn('relative inline-flex size-2 shrink-0', className)}>
      {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', DOT[tone])} />}
      <span className={cn('relative inline-flex size-2 rounded-full', DOT[tone])} />
    </span>
  )
}
