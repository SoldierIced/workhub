import { Gauge } from 'lucide-react'
import type { PlanUsageWindow } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

/**
 * Plan usage at the bottom of the sidebar (Workhub 1's "Claude usage"), filled only from what
 * running agents report; nothing is fetched from undocumented endpoints here (PLAN section 6).
 */
export function UsageCard({ windows, running }: { windows: PlanUsageWindow[]; running: number }) {
  const { t, tn, formatDate } = useI18n()
  return (
    <section aria-label={t('usage.title')} className="rounded-lg border border-border bg-surface p-3 shadow-sm">
      <header className="flex items-center gap-1.5 text-sm font-medium text-muted">
        <Gauge className="size-3.5" aria-hidden />
        {t('usage.title')}
        <span className="ml-auto text-xs font-normal text-subtle">{tn('usage.running', running)}</span>
      </header>
      {windows.length === 0 ? (
        <p className="mt-2 text-xs text-subtle">{t('usage.empty')}</p>
      ) : (
        <ul className="mt-2.5 flex flex-col gap-2">
          {windows.map((w) => (
            <li key={w.window} className="grid grid-cols-[3.5rem_1fr_2.5rem] items-center gap-2 text-xs">
              <span className="truncate text-muted">{w.window}</span>
              <span
                className="h-1.5 overflow-hidden rounded-full bg-surface-hover"
                role="progressbar"
                aria-label={w.window}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(w.percent)}
              >
                <span
                  className={cn('block h-full rounded-full', w.percent >= 90 ? 'bg-danger' : w.percent >= 75 ? 'bg-warning' : 'brand-gradient')}
                  style={{ width: `${Math.min(100, Math.max(2, w.percent))}%` }}
                />
              </span>
              <span className="text-right font-medium tabular-nums">{Math.round(w.percent)}%</span>
              {w.resetsAt && (
                <span className="col-span-3 -mt-1 text-right text-2xs text-subtle">
                  {t('usage.resets', { when: formatDate(w.resetsAt, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
