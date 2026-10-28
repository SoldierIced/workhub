import type { PlanUsageWindow } from '@workhub/core'
import type { ReactElement } from 'react'
import { Tooltip } from '../atoms/Tooltip'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { formatCountdown, shortReset, usageTone } from '../../lib/agent-usage'

/** Short window names, so a window fits on one line. */
const WINDOW_LABEL: Record<string, MessageKey> = { '5h': 'agentUsage.window.5h', weekly: 'agentUsage.window.weekly', monthly: 'agentUsage.window.monthly' }
const TONE_CLASS = { danger: 'bg-danger', warning: 'bg-warning', normal: 'bg-accent' } as const

const round2 = (n: number) => Math.round(n * 100) / 100

/** The hover text of a window: percent, credits, ceiling, full reset date and countdown, reading time. */
export function useWindowHover(): (w: PlanUsageWindow, ceiling: number | undefined, now: number) => string {
  const { t, formatDate, formatNumber } = useI18n()
  const label = useWindowLabel()
  return (w, ceiling, now) =>
    [
      `${label(w.window)}: ${Math.round(w.percent)}%`,
      w.used !== undefined && w.limit !== undefined
        ? t('agentUsage.credits', { used: formatNumber(round2(w.used)), limit: formatNumber(w.limit), left: formatNumber(round2(Math.max(0, w.limit - w.used))) })
        : '',
      ceiling !== undefined ? t('agentUsage.ceiling', { ceiling }) : '',
      w.resetsAt
        ? t('agentUsage.resetsAt', { when: formatDate(w.resetsAt, { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), time: formatCountdown(w.resetsAt, now) })
        : '',
      w.asOf ? t('agentUsage.asOf', { when: formatDate(w.asOf, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }) : ''
    ]
      .filter(Boolean)
      .join('\n')
}

/** The short name of a window (`5h`, `week`, `Sonnet`). */
export function useWindowLabel(): (window: string) => string {
  const { t } = useI18n()
  return (window) => (WINDOW_LABEL[window] ? t(WINDOW_LABEL[window]!) : window.replace(/^weekly /, ''))
}

/** The bar: how much of the window is used, the ceiling as a mark. `className` gives its height and width. */
function UsageBar({ percent, ceiling, label, tone, className }: { percent: number; ceiling?: number; label: string; tone: keyof typeof TONE_CLASS; className: string }) {
  return (
    <span
      className={cn('relative overflow-hidden rounded-full bg-surface-hover', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <span className={cn('block h-full rounded-full', TONE_CLASS[tone])} style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
      {ceiling !== undefined && <span className="absolute top-0 h-full w-0.5 bg-text/70" style={{ left: `calc(${Math.min(100, ceiling)}% - 1px)` }} aria-hidden />}
    </span>
  )
}

const TONE_TEXT = { danger: 'text-danger', warning: 'text-warning', normal: '' } as const

/**
 * One plan usage window on one line: short name · bar (with the ceiling mark) · percent used ·
 * short reset (`18:59` today, `Thu 17:59` this week). The full reset date, credits and ceiling are
 * on hover. `compact` (the sidebar) drops the reset and sizes the name to its text, so two windows
 * share one line.
 */
export function UsageWindowRow({ w, ceiling, now, compact = false, className }: { w: PlanUsageWindow; ceiling?: number; now: number; compact?: boolean; className?: string }) {
  const { formatDate } = useI18n()
  const tone = usageTone(w.percent, ceiling)
  const label = useWindowLabel()(w.window)
  return (
    <span className={cn('flex items-center gap-1.5 text-xs', className)} data-testid="usage-window" data-window={w.window}>
      <span className={cn('shrink-0 truncate text-subtle', !compact && 'w-12')}>{label}</span>
      <UsageBar percent={w.percent} ceiling={ceiling} label={label} tone={tone} className={cn('min-w-8 flex-1', compact ? 'h-1.5' : 'h-2')} />
      <span className={cn('shrink-0 text-right font-medium tabular-nums', compact ? 'w-7' : 'w-8', TONE_TEXT[tone])}>{Math.round(w.percent)}%</span>
      {!compact && <span className="w-16 shrink-0 truncate text-right text-2xs text-subtle tabular-nums">{w.resetsAt !== undefined ? shortReset(w.resetsAt, now, formatDate) : ''}</span>}
    </span>
  )
}

/**
 * The tooltip of a whole usage row. Native `title` tooltips showed only over the element that
 * carried one (a bar, a percent, not the gaps between them), waited about a second, and did not show
 * at all while the window was not focused. This one opens anywhere over the row, after the app's
 * short delay, in a portal (no clipping by the sidebar's scroll area) kept inside the window.
 */
export function UsageRowTooltip({ text, side = 'bottom', children }: { text: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactElement }) {
  if (!text) return children
  return (
    <Tooltip side={side} align="start" className="max-w-80" testId="usage-tooltip" content={<span className="block text-xs leading-snug whitespace-pre-line tabular-nums">{text}</span>}>
      {children}
    </Tooltip>
  )
}

/** The account name alone when it already says the agent ("Claude Personal"), else "Claude · Work". */
export function accountTitle(agent: string, name: string): string {
  return name.toLowerCase().includes(agent.toLowerCase()) ? name : `${agent} · ${name}`
}
