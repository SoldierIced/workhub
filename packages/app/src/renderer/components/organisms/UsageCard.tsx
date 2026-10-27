import { Gauge } from 'lucide-react'
import type { PlanUsageWindow } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import type { UsageGroup } from '../../lib/home'

function Windows({ windows }: { windows: PlanUsageWindow[] }) {
  const { t, formatDate } = useI18n()
  return (
    <ul className="flex flex-col gap-2">
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
  )
}

/**
 * Plan usage at the bottom of the sidebar (Workhub 1's "Claude usage"), one block per account.
 * It comes from what running agents report, or from each account's own read when the user
 * turned it on in Settings → General.
 */
export function UsageCard({ groups, running }: { groups: UsageGroup[]; running: number }) {
  const { t, tn } = useI18n()
  return (
    <section aria-label={t('usage.title')} className="rounded-lg border border-border bg-surface p-3 shadow-sm">
      <header className="flex items-center gap-1.5 text-sm font-medium text-muted">
        <Gauge className="size-3.5" aria-hidden />
        {t('usage.title')}
        <span className="ml-auto text-xs font-normal text-subtle">{tn('usage.running', running)}</span>
      </header>
      {groups.length === 0 ? (
        <p className="mt-2 text-xs text-subtle">{t('usage.empty')}</p>
      ) : (
        <div className="mt-2.5 flex flex-col gap-3">
          {groups.map((g) => (
            <div key={g.key} data-testid="usage-account">
              {(groups.length > 1 || g.name) && <div className="mb-1.5 truncate text-2xs font-medium tracking-wide text-subtle uppercase">{g.name || t('usage.defaultAccount')}</div>}
              {g.error ? <p className="text-xs text-danger" title={g.error}>{t('usage.readFailed')}</p> : <Windows windows={g.windows} />}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
