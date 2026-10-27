import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import type { MonitorSection as SectionId } from '../../lib/monitorView'
import { setPrefs, usePrefs } from '../../lib/prefs'

/**
 * One board of the monitor (Workhub 1's InspectorSection): a small caption over a rounded card.
 * The caption folds it; folded sections are remembered across sessions and restarts.
 * `missing`: Workhub 2 has no source for this data yet; the section says so instead of showing numbers.
 */
export function MonitorSection({
  id,
  title,
  count,
  action,
  missing,
  bare,
  children
}: {
  id: SectionId
  title: string
  count?: number
  action?: ReactNode
  missing?: string
  /** The children bring their own frame (lists of cards). */
  bare?: boolean
  children?: ReactNode
}) {
  const { t } = useI18n()
  const collapsed = usePrefs().monitorCollapsed
  const open = !collapsed.includes(id)
  const toggle = () => setPrefs({ monitorCollapsed: open ? [...collapsed, id] : collapsed.filter((c) => c !== id) })
  return (
    <section data-monitor-section={id} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-xs font-semibold text-muted select-none hover:text-text"
        >
          <ChevronRight className={cn('size-3 shrink-0 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
          <span className="truncate">{title}</span>
          {count !== undefined && <span className="ml-auto pl-1 text-2xs font-normal text-subtle tabular-nums">{count}</span>}
          {missing && <span className="ml-auto pl-1 text-2xs font-normal whitespace-nowrap text-subtle">{t('monitor.notInV2')}</span>}
        </button>
        {action}
      </div>
      {open && (missing ? <p className="px-1 text-xs text-subtle">{missing}</p> : bare ? children : <div className="rounded-lg border border-border bg-surface p-3">{children}</div>)}
    </section>
  )
}

/** A big number with a caption and a note (Workhub 1's MetricBox). */
export function MetricBox({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'warning' }) {
  return (
    <div className="min-w-0 flex-1 rounded-md bg-sidebar px-2 py-1.5">
      <div className="truncate text-2xs text-muted">{label}</div>
      <div className={cn('truncate text-lg leading-tight font-semibold tabular-nums', tone === 'warning' && 'text-warning')}>{value}</div>
      {note && <div className="truncate text-2xs text-subtle">{note}</div>}
    </div>
  )
}

/** A label and a value on one line. */
export function MetricRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="min-w-0 truncate text-muted">{label}</span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  )
}

/** A thin stacked bar; each segment's share is its value over the sum. */
export function SegmentBar({ segments }: { segments: { value: number; className: string }[] }) {
  const total = segments.reduce((a, s) => a + Math.max(s.value, 0), 0) || 1
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
      {segments.map((s, i) => (
        <div key={i} className={s.className} style={{ width: `${(Math.max(s.value, 0) / total) * 100}%` }} />
      ))}
    </div>
  )
}

export function Legend({ className, text }: { className: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-2xs text-muted">
      <span className={cn('size-1.5 rounded-full', className)} aria-hidden />
      {text}
    </span>
  )
}
