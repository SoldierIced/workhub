import { CheckCircle2, ChevronRight, Circle, ExternalLink, RotateCw, Sparkles } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { HealthDetailRequest, HealthItemId } from '@workhub/core'
import type { HealthDetail } from '@shared/health-api'
import { Button, Spinner } from '../../components/atoms'
import { RefreshButton } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import type { HealthRow } from '../../lib/healthInvestigate'
import { relativeTime } from '../../lib/pullRequests'

/** What every row of an environment can do: be picked while selecting, open its drill-down, and be investigated. */
export interface HealthRowActions {
  profileId: string | null
  environmentId: string
  selecting: boolean
  isSelected: (id: HealthItemId) => boolean
  toggle: (id: HealthItemId) => void
  investigate: (key: string, row: HealthRow) => void
  /** The row whose draft is being prepared. */
  busyKey: string | null
  /** The tooltip of a row's Investigate button: where the session opens. */
  folderHelp: (row: HealthRow) => string
}

const RowsContext = createContext<HealthRowActions | null>(null)
export const HealthRowsProvider = RowsContext.Provider

export function useRowActions(): HealthRowActions {
  const actions = useContext(RowsContext)
  if (!actions) throw new Error('A Health row needs HealthRowsProvider')
  return actions
}

/**
 * A list row. While selecting it gets a check mark, its own buttons stop reacting and a click on it
 * toggles it; it keeps its place in both modes, so an expanded row stays expanded.
 */
export function PickRow({ id, label, children, className }: { id: HealthItemId; label: string; children: ReactNode; className?: string }) {
  const a = useRowActions()
  if (!a.selecting) return <li className={cn('py-1.5', className)}>{children}</li>
  const on = a.isSelected(id)
  return (
    <li className={cn('py-1', className)}>
      <div
        role="checkbox"
        aria-checked={on}
        aria-label={label}
        tabIndex={0}
        onClick={() => a.toggle(id)}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            a.toggle(id)
          }
        }}
        className={cn('flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent', on ? 'bg-accent-soft ring-1 ring-accent/60' : 'hover:bg-surface-hover')}
      >
        {on ? <CheckCircle2 className="mt-1 size-4 shrink-0 text-accent" aria-hidden /> : <Circle className="mt-1 size-4 shrink-0 text-subtle" aria-hidden />}
        <div inert className="min-w-0 flex-1">
          {children}
        </div>
      </div>
    </li>
  )
}

export function KibanaLink({ url, label }: { url: string | null | undefined; label: string }) {
  if (!url) return null
  return (
    <button type="button" aria-label={label} title={label} onClick={() => window.hub.openExternal(url)} className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-subtle hover:bg-surface-hover hover:text-text">
      <ExternalLink className="size-3.5" aria-hidden />
    </button>
  )
}

/** "Investigate with Claude" at the end of a row; icon only where the row is narrow. */
export function InvestigateButton({ rowKey, row, compact }: { rowKey: string; row: HealthRow; compact?: boolean }) {
  const { t } = useI18n()
  const a = useRowActions()
  const busy = a.busyKey === rowKey
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={t('health.investigate')}
      title={a.folderHelp(row)}
      disabled={a.busyKey !== null}
      icon={busy ? <Spinner /> : <Sparkles className="size-3.5" aria-hidden />}
      onClick={() => a.investigate(rowKey, row)}
    >
      {compact ? null : t('health.investigate')}
    </Button>
  )
}

/** The chevron and the row's title: a click shows or hides its drill-down. */
export function Disclosure({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const { t } = useI18n()
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} title={open ? t('health.details.hide') : t('health.details.show')} className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
      <ChevronRight className={cn('mt-0.5 size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}

export interface DetailState<T> {
  value?: T
  error?: string
  loading: boolean
  reload: () => void
}

/**
 * The details of one row, read when `enabled` turns on (an expanded row). The main process keeps
 * them 10 minutes, so reading again on the next expand is cheap; `reload` forces a new read.
 */
export function useHealthDetail<T extends HealthDetail>(request: HealthDetailRequest, enabled: boolean): DetailState<T> {
  const a = useRowActions()
  const [state, setState] = useState<{ value?: T; error?: string; loading: boolean }>({ loading: false })
  const key = JSON.stringify(request)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const load = useCallback(
    async (force: boolean) => {
      setState((s) => ({ ...s, loading: true }))
      try {
        const r = await window.hub.health.details(a.profileId, a.environmentId, JSON.parse(key) as HealthDetailRequest, force)
        if (live.current) setState((s) => (r.ok ? { value: r.value as T, loading: false } : { value: s.value, error: r.error, loading: false }))
      } catch (error) {
        if (live.current) setState((s) => ({ value: s.value, error: error instanceof Error ? error.message : String(error), loading: false }))
      }
    },
    [a.profileId, a.environmentId, key]
  )
  useEffect(() => {
    if (enabled) void load(false)
  }, [enabled, load])
  return { ...state, reload: () => void load(true) }
}

/** "Read 3 minutes ago ⟳" under the details of an expanded row, or why they could not be read. */
export function DetailFooter({ state, fetchedAt }: { state: DetailState<unknown>; fetchedAt?: number }) {
  const { t, locale } = useI18n()
  return (
    <div className="flex flex-col gap-1">
      {state.error && (
        <p role="alert" className="text-xs text-warning">
          {t('health.details.failed', { error: state.error })}
        </p>
      )}
      <div className="flex items-center gap-1.5 text-xs text-subtle">
        {state.loading && fetchedAt === undefined && (
          <>
            <Spinner /> {t('health.details.loading')}
          </>
        )}
        {fetchedAt !== undefined && <span>{t('health.details.read', { time: relativeTime(fetchedAt, Date.now(), locale) })}</span>}
        {state.loading && fetchedAt !== undefined && <Spinner />}
        <RefreshButton icon={RotateCw} className="size-5 rounded-sm" iconClassName="size-3" label={t('health.details.again')} title={t('health.details.againHint')} loading={state.loading} onRefresh={state.reload} />
      </div>
    </div>
  )
}
