import { CalendarRange, GitPullRequest, TriangleAlert } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Badge } from '../../components/atoms'
import { EmptyState, RefreshButton } from '../../components/molecules'
import { ChartLegend, StackedBarChart, type ChartSeries } from '../../components/molecules/StackedBarChart'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import {
  averagePer,
  bucketItems,
  bucketRange,
  byBranch,
  byRepo,
  coverage,
  deltaVsPrevious,
  GROUP_LABEL,
  GROUP_SLOT,
  localDateValue,
  presentGroups,
  totalsOf,
  type Granularity
} from '../../lib/mergedStats'
import { relativeTime } from '../../lib/pullRequests'
import type { MergedScope } from '@shared/codehost-api'
import { BranchTable, Lines, RepoTable } from './MergedTables'
import { Unavailable } from './Unavailable'
import type { Display, MergedView, PeriodChoice, Profiles, Who } from './useMergedView'

export interface MergedSummaryProps {
  view: MergedView
  /** The lists' provider and CLI, for the sign-in texts when the merged read could not start. */
  host: { provider?: string; cli?: string }
  onOpenSettings: (tab?: string) => void
}

/** A radio group of text buttons (one choice at a time), as the list's own filter. */
function Toggle<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-md border border-border bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-6 rounded-sm px-2.5 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45',
            value === o.value ? 'bg-surface-raised font-semibold text-text shadow-sm' : 'text-muted hover:text-text'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** "acme/api, acme/web and 2 more" (the first three). */
function listNames(values: readonly string[], more: (names: string, count: number) => string): string {
  const names = values.slice(0, 3).join(', ')
  return values.length > 3 ? more(names, values.length - 3) : names
}

function useScopeText(view: MergedView): string {
  const { t } = useI18n()
  const more = (names: string, count: number) => t('pr.merged.scope.more', { names, count })
  const picked = view.ui.narrowing.repos
  if (picked.length > 0) return listNames(picked, more)
  const scope: MergedScope | null = view.scope
  if (!scope) return ''
  switch (scope.kind) {
    case 'repos':
    case 'owners':
      return listNames(scope.values, more)
    case 'connection':
      return scope.values.join(', ')
    case 'folders':
      return t('pr.merged.scope.folders')
    case 'none':
      return ''
  }
}

function Header({ view, onOpenSettings }: { view: MergedView; onOpenSettings: MergedSummaryProps['onOpenSettings'] }) {
  const { t, tn } = useI18n()
  const scopeText = useScopeText(view)
  const whose = t(view.mine ? 'pr.merged.whose.mine' : 'pr.merged.whose.all')
  const line = view.ui.noScope && !view.ui.narrowing.repos.length ? t('pr.merged.scope.mineOnly') : scopeText ? t('pr.merged.line', { scope: scopeText, whose }) : ''
  const periods: { value: PeriodChoice; label: string }[] = [
    ...([7, 30, 90] as const).map((d) => ({ value: d as PeriodChoice, label: tn('pr.merged.period.days', d) })),
    { value: 'custom', label: t('pr.merged.period.custom') }
  ]
  const today = localDateValue(Date.now())
  return (
    <header className="flex flex-wrap items-start gap-x-4 gap-y-3 px-6 pt-5">
      <div className="min-w-0">
        <h2 className="text-md font-semibold">{t('pr.merged.title')}</h2>
        <p className="mt-0.5 truncate text-sm text-muted" data-testid="merged-scope-line" title={line}>
          {line || ' '}
        </p>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {view.canChooseProfiles && (
          <Toggle<Profiles>
            label={t('pr.merged.profiles.label')}
            value={view.allProfiles ? 'all' : 'this'}
            onChange={view.setProfiles}
            options={[
              { value: 'this', label: t('pr.merged.profiles.this') },
              { value: 'all', label: t('pr.merged.profiles.all') }
            ]}
          />
        )}
        <Toggle<Who>
          label={t('pr.merged.who.label')}
          value={view.mine ? 'mine' : 'all'}
          onChange={view.setWho}
          options={[
            { value: 'all', label: t('pr.merged.who.all'), disabled: view.ui.noScope, title: view.ui.noScope ? t('pr.merged.noScope') : undefined },
            { value: 'mine', label: t('pr.merged.who.mine') }
          ]}
        />
        <Toggle<PeriodChoice>
          label={t('pr.merged.period.label')}
          value={view.ui.period}
          onChange={(p) => (p === 'custom' ? view.setCustom(view.ui.from, view.ui.to) : view.setPeriod(p))}
          options={periods}
        />
      </div>
      {view.ui.noScope && (
        <p className="basis-full text-xs text-muted" data-testid="merged-noscope-hint">
          {t('pr.merged.noScope')}{' '}
          <button type="button" className="text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" onClick={() => onOpenSettings('profiles')}>
            {t('pr.merged.noScope.link')}
          </button>
        </p>
      )}
      {view.ui.period === 'custom' && (
        <div className="flex basis-full flex-wrap items-center gap-2 text-sm" data-testid="merged-custom">
          <CalendarRange className="size-4 text-subtle" aria-hidden />
          <label className="flex items-center gap-1.5 text-muted">
            {t('pr.merged.custom.from')}
            <input type="date" value={view.ui.from} max={today} onChange={(e) => view.setCustom(e.target.value, view.ui.to)} className="h-7 rounded-md border border-border bg-surface px-2 text-text" />
          </label>
          <label className="flex items-center gap-1.5 text-muted">
            {t('pr.merged.custom.to')}
            <input type="date" value={view.ui.to} max={today} onChange={(e) => view.setCustom(view.ui.from, e.target.value)} className="h-7 rounded-md border border-border bg-surface px-2 text-text" />
          </label>
          {view.rangeError && (
            <span role="alert" className="text-warning">
              {t(`pr.merged.custom.${view.rangeError}`)}
            </span>
          )}
        </div>
      )}
    </header>
  )
}

function Cell({ title, value, note, notes }: { title: string; value: ReactNode; note?: ReactNode; notes?: ReactNode }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <dt className="text-xs text-muted">{title}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
      {note && <div className="mt-0.5 text-xs text-subtle">{note}</div>}
      {notes}
    </div>
  )
}

function Strip({ view }: { view: MergedView }) {
  const { t, tn, formatNumber } = useI18n()
  const totals = useMemo(() => totalsOf(view.visible), [view.visible])
  const provider = t(view.provider === 'gitlab' ? 'pr.host.gitlab' : 'pr.host.github')
  const delta = deltaVsPrevious(totals.count, view.previous.length, view.truncated)
  const period = tn('pr.merged.period.days', view.days)
  const deltaText = delta === null ? t('pr.merged.delta.cut', { period }) : t('pr.merged.delta', { delta: delta > 0 ? `+${formatNumber(delta)}` : delta < 0 ? `−${formatNumber(-delta)}` : '0', period })
  const lines = coverage(totals.count, totals.withLines)
  const files = coverage(totals.count, totals.withFiles)
  const avg = (n: number | null) => (n === null ? null : t('pr.merged.avg', { count: formatNumber(Math.round(n)) }))
  const days = (n: number) => tn('pr.merged.days', n, { count: formatNumber(n, { maximumFractionDigits: 1 }) })
  const notReported = <span className="text-sm font-normal text-subtle">{t('pr.merged.notReported', { provider })}</span>
  return (
    <dl className={cn('mx-6 mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border', files === 'none' ? '@2xl:grid-cols-3' : '@2xl:grid-cols-4')} data-testid="merged-strip">
      <Cell title={t('pr.merged.stat.merged')} value={formatNumber(totals.count)} note={deltaText} />
      <Cell
        title={t('pr.merged.stat.lines')}
        value={lines === 'none' ? notReported : <Lines additions={totals.additions} deletions={totals.deletions} reported={totals.withLines} count={totals.count} />}
        note={lines === 'none' ? null : avg(averagePer(totals.additions + totals.deletions, totals.withLines))}
        notes={lines === 'partial' ? <div className="text-xs text-subtle">{t('pr.merged.withoutLines', { count: formatNumber(totals.count - totals.withLines) })}</div> : null}
      />
      {/* GitHub's merged search does not ask for file counts (they make it slow): no item reporting them hides the cell. */}
      {files !== 'none' && (
        <Cell
          title={t('pr.merged.stat.files')}
          value={formatNumber(totals.files)}
          note={avg(averagePer(totals.files, totals.withFiles))}
          notes={files === 'partial' ? <div className="text-xs text-subtle">{t('pr.merged.withoutFiles', { count: formatNumber(totals.count - totals.withFiles) })}</div> : null}
        />
      )}
      <Cell
        title={t('pr.merged.stat.lead')}
        value={totals.leadMedianDays === null ? <span className="text-subtle">{t('pr.merged.noData')}</span> : <>{days(totals.leadMedianDays)} <span className="text-xs font-normal text-muted">{t('pr.merged.leadMedian')}</span></>}
        note={totals.leadMaxDays === null ? null : t('pr.merged.slowest', { days: days(totals.leadMaxDays) })}
      />
    </dl>
  )
}

function Chart({ view }: { view: MergedView }) {
  const { t, formatDate, formatNumber } = useI18n()
  const [highlight, setHighlight] = useState<string | null>(null)
  const period = view.period!
  const g: Granularity = view.gran
  const groups = useMemo(() => presentGroups(view.visible), [view.visible])
  const series: ChartSeries[] = groups.map((k) => ({ key: k, slot: GROUP_SLOT[k], label: t(GROUP_LABEL[k]) }))
  const buckets = useMemo(() => bucketItems(view.visible, groups, period, g), [view.visible, groups, period, g])
  const short = (ms: number) => formatDate(ms, { month: 'short', day: 'numeric' })
  const title = (start: number) => {
    if (g === 'day') return formatDate(start, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    const r = bucketRange(start, g, period)
    return t('pr.merged.weekOf', { from: short(r.from), to: short(r.to) })
  }
  const count = (n: number) => formatNumber(n, { maximumFractionDigits: 1 })
  const unit = g === 'day' ? t('pr.merged.gran.day') : t('pr.merged.gran.week')
  return (
    <section className="mx-6 mt-6" aria-label={t(`pr.merged.chart.${g}`)}>
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="mr-auto text-base font-semibold">{t(`pr.merged.chart.${g}`)}</h3>
        <Toggle<Granularity> label={t('pr.merged.gran.label')} value={g} onChange={view.setGran} options={[{ value: 'day', label: t('pr.merged.gran.day') }, { value: 'week', label: t('pr.merged.gran.week') }]} />
        <Toggle<Display> label={t('pr.merged.view.label')} value={view.ui.display} onChange={view.setDisplay} options={[{ value: 'chart', label: t('pr.merged.view.chart') }, { value: 'table', label: t('pr.merged.view.table') }]} />
      </div>
      {view.ui.display === 'chart' ? (
        <div className="rounded-lg border border-border bg-surface p-3.5">
          <StackedBarChart
            buckets={buckets}
            series={series}
            tick={short}
            title={title}
            format={count}
            summary={t(`pr.merged.chart.summary.${g}`)}
            tableCaption={t(`pr.merged.chart.${g}`)}
            bucketHeader={unit}
            totalLabel={t('pr.merged.totalLabel')}
            highlight={highlight}
          />
          <div className="mt-2">
            <ChartLegend series={series} onHighlight={setHighlight} />
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table aria-label={t(`pr.merged.chart.${g}`)} className="w-full border-collapse text-sm" data-testid="merged-chart-table">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-subtle">{unit}</th>
                {series.map((s) => (
                  <th key={s.key} scope="col" className="px-3 py-2 text-right text-xs font-medium text-subtle">{s.label}</th>
                ))}
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-subtle">{t('pr.merged.total')}</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-subtle">{t('pr.merged.lines')}</th>
              </tr>
            </thead>
            <tbody>
              {buckets
                .filter((b) => b.total > 0)
                .reverse()
                .map((b) => (
                  <tr key={b.start} className="border-b border-border last:border-b-0">
                    <th scope="row" className="px-3 py-2 text-left font-normal whitespace-nowrap">{title(b.start)}</th>
                    {b.values.map((v, i) => (
                      <td key={series[i]!.key} className="px-3 py-2 text-right tabular-nums">{v > 0 ? formatNumber(v) : '–'}</td>
                    ))}
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{formatNumber(b.total)}</td>
                    <td className="px-3 py-2 text-right">
                      {b.additions === 0 && b.deletions === 0 ? <span className="text-subtle">{t('pr.merged.noData')}</span> : <Lines additions={b.additions} deletions={b.deletions} reported={1} count={1} />}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Skeleton() {
  const { t } = useI18n()
  return (
    <div data-testid="merged-skeleton">
      <p className="mx-6 mt-4 text-sm text-muted" role="status">{t('pr.merged.loading.first')}</p>
      <div aria-hidden className="animate-pulse">
        <div className="mx-6 mt-4 h-20 rounded-lg border border-border bg-surface" />
        <div className="mx-6 mt-6 h-6 w-64 rounded bg-surface-hover" />
        <div className="mx-6 mt-2.5 h-56 rounded-lg border border-border bg-surface" />
      </div>
    </div>
  )
}

function Banner({ tone, children, action }: { tone: 'warning' | 'info'; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className={cn('mx-6 mt-4 flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm', tone === 'warning' ? 'bg-warning-soft text-warning' : 'bg-info-soft text-info')}>
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  )
}

/** The Merged view's right side when no merged PR is open: the period's numbers, the chart and the two tables. */
export function MergedSummary({ view, host, onOpenSettings }: MergedSummaryProps) {
  const { t, tn, locale, formatNumber, formatDate } = useI18n()
  const at = (ms: number) => formatDate(ms, { hour: '2-digit', minute: '2-digit' })
  const body = (): ReactNode => {
    if (!view.period) return null
    if (!view.hasData) {
      const f = view.failure
      if (!f) return <Skeleton />
      if (f.state === 'noScope') return <Skeleton />
      if (f.state === 'unsupported') return <EmptyState icon={<GitPullRequest className="size-6" aria-hidden />} title={t('pr.merged.unsupported.title')} description={t('pr.merged.unsupported.description')} />
      return <Unavailable state={f.state} message={f.error} retryAt={f.retryAt} provider={host.provider} cli={host.cli} onOpenSettings={onOpenSettings} onRetry={view.refresh} />
    }
    const rows = byBranch(view.visible)
    return (
      <>
        {view.sync.state === 'failed' ? (
          <Banner tone="warning" action={<RefreshButton variant="button" size="sm" label={t('pr.retry')} onRefresh={view.refresh} />}>
            {view.sync.reason === 'rateLimited' && view.sync.retryAt !== undefined ? t('pr.merged.sync.rateLimited', { time: at(view.sync.retryAt) }) : t('pr.merged.sync.failed', { error: view.sync.error })}
          </Banner>
        ) : (
          view.failure && (
            <Banner tone="warning" action={<RefreshButton variant="button" size="sm" label={t('pr.retry')} onRefresh={view.refresh} />}>
              {view.failure.state === 'rateLimited' && view.failure.retryAt !== undefined ? t('pr.merged.sync.rateLimited', { time: at(view.failure.retryAt) }) : t('pr.merged.error.kept', { message: view.failure.error })}
            </Banner>
          )
        )}
        {view.partial && view.sync.state !== 'failed' && <Banner tone="info">{t('pr.merged.partial')}</Banner>}
        {view.truncated && <Banner tone="info">{t('pr.merged.truncated', { count: formatNumber(view.readCount) })}</Banner>}
        <Strip view={view} />
        {view.visible.length === 0 ? (
          <EmptyState compact icon={<GitPullRequest className="size-4" aria-hidden />} title={view.current.length > 0 ? t('pr.empty.filtered.title') : t('pr.merged.empty.title')} description={view.current.length > 0 ? t('pr.merged.empty.filtered.description') : t('pr.merged.empty.description')} />
        ) : (
          <>
            <Chart view={view} />
            <div className="mx-6 mt-6 grid grid-cols-1 gap-6">
              <section>
                <h3 className="mb-2.5 text-base font-semibold">{t('pr.merged.byBranch')}</h3>
                <BranchTable rows={rows} total={view.visible.length} />
              </section>
              <section>
                <h3 className="mb-2.5 text-base font-semibold">{t('pr.merged.byRepo')}</h3>
                <RepoTable rows={byRepo(view.visible)} />
              </section>
            </div>
          </>
        )}
        <footer className="mx-6 mt-4 mb-6 flex items-center gap-2 text-xs text-subtle">
          {view.allProfiles && view.profileCount !== null && <span>{tn('pr.merged.fromProfiles', view.profileCount)}</span>}
          {view.provider && view.fetchedAt !== null && <span>{t('pr.merged.readFrom', { provider: t(view.provider === 'gitlab' ? 'pr.host.gitlab' : 'pr.host.github'), time: relativeTime(view.fetchedAt, Date.now(), locale) })}</span>}
          {view.demo && <Badge tone="warning">{t('pr.demo')}</Badge>}
          <RefreshButton label={t('pr.refresh')} loading={view.loading} onRefresh={view.refresh} />
        </footer>
      </>
    )
  }
  return (
    <div className="@container h-full overflow-y-auto" data-testid="merged-summary">
      <Header view={view} onOpenSettings={onOpenSettings} />
      {view.ui.period === 'custom' && !view.period ? <p className="mx-6 mt-6 text-sm text-muted">{view.rangeError ? t(`pr.merged.custom.${view.rangeError}`) : ''}</p> : body()}
    </div>
  )
}
