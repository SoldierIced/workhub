import type { PlanUsageWindow } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { formatCountdown, shortReset, usageTone } from '../../lib/agent-usage'

/** Short window names, so a window fits on one line. */
const WINDOW_LABEL: Record<string, MessageKey> = { '5h': 'agentUsage.window.5h', weekly: 'agentUsage.window.weekly', monthly: 'agentUsage.window.monthly' }
const TONE_CLASS = { danger: 'bg-danger', warning: 'bg-warning', normal: 'brand-gradient' } as const

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * One plan usage window on one line: short name · bar (with the ceiling mark) · percent · short
 * reset (`18:59` today, `Thu 17:59` this week). The full reset date, credits and ceiling are on hover.
 */
export function UsageWindowRow({ w, ceiling, now, className }: { w: PlanUsageWindow; ceiling?: number; now: number; className?: string }) {
  const { t, formatDate, formatNumber } = useI18n()
  const tone = usageTone(w.percent, ceiling)
  const label = WINDOW_LABEL[w.window] ? t(WINDOW_LABEL[w.window]!) : w.window.replace(/^weekly /, '')
  const hover = [
    `${w.window}: ${Math.round(w.percent)}%`,
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
  return (
    <span className={cn('flex items-center gap-1.5 text-xs', className)} title={hover} data-testid="usage-window">
      <span className="w-11 shrink-0 truncate text-subtle">{label}</span>
      <span
        className="relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-surface-hover"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(w.percent)}
      >
        <span className={cn('block h-full rounded-full', TONE_CLASS[tone])} style={{ width: `${Math.min(100, Math.max(2, w.percent))}%` }} />
        {ceiling !== undefined && <span className="absolute top-0 h-full w-0.5 bg-text/70" style={{ left: `calc(${Math.min(100, ceiling)}% - 1px)` }} aria-hidden />}
      </span>
      <span className={cn('w-8 shrink-0 text-right font-medium tabular-nums', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning')}>{Math.round(w.percent)}%</span>
      <span className="w-16 shrink-0 truncate text-right text-2xs text-subtle tabular-nums">{w.resetsAt !== undefined ? shortReset(w.resetsAt, now, formatDate) : ''}</span>
    </span>
  )
}

/** The account name alone when it already says the agent ("Claude Personal"), else "Claude · Work". */
export function accountTitle(agent: string, name: string): string {
  return name.toLowerCase().includes(agent.toLowerCase()) ? name : `${agent} · ${name}`
}
