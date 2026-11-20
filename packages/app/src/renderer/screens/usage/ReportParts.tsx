import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, GitPullRequest, Ticket, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { REPORT_FILTER_KEYS, type ReportFilterValues, type ReportGroupBy, type ReportSession, type SpendTotals, type WeeklyReport } from '../../../shared/analytics-api'
import { AgentIcon, Badge, Button, IconButton, Input, Select, Spinner } from '../../components/atoms'
import { Card, CardBody, CardHeader, CopyButton } from '../../components/molecules'
import { ActiveFilterChips, FiltersPopover, FiltersPopoverClose, type ActiveFilter } from '../../components/molecules/FiltersPopover'
import { PAGE_SIZE, Pager, pageRows } from '../../components/molecules/Pager'
import { TagsEditor } from '../../components/molecules/TagsEditor'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { folderName, formatTokens } from '../../lib/home'
import { pullRequestLabel } from '../../lib/monitorView'
import { abbreviateFolder } from '../../lib/sessionHeader'
import {
  canClearReport,
  clearedReport,
  filterLabel,
  foldSmallProjects,
  formatActive,
  formatUsd,
  freshTokens,
  GROUP_BYS,
  METRICS,
  PERIODS,
  projectNames,
  sumTotals,
  WEEKLY_OTHER_MIN_USD,
  weeklyMarkdown,
  type Names,
  type ReportState,
  type Sort,
  type SortKey
} from '../../lib/usageReports'

type FilterKey = (typeof REPORT_FILTER_KEYS)[number]
const VALUES_OF: Record<FilterKey, keyof ReportFilterValues> = {
  profileId: 'profiles',
  cwdPrefix: 'projects',
  project: 'projects',
  agent: 'agents',
  account: 'accounts',
  model: 'models',
  ticket: 'tickets',
  pr: 'prs',
  tag: 'tags'
}
const ALL = '\u0000all'
/** The exact project first, then the folder-and-below menu. */
const MENU_ORDER: FilterKey[] = ['profileId', 'project', 'cwdPrefix', ...REPORT_FILTER_KEYS.filter((k) => k !== 'profileId' && k !== 'project' && k !== 'cwdPrefix')]

/** The filter menus with something to pick, in menu order; Tag stays (disabled) to say where tags come from. */
function filterMenus(state: ReportState, values: ReportFilterValues | null) {
  return MENU_ORDER.flatMap((key) => {
    const list = values?.[VALUES_OF[key]] ?? []
    const current = state.filters[key]
    // A menu stays visible with one value, so the filter can be found; with none it goes,
    // except Tag, which stays (disabled) to say where tags come from.
    if (list.length === 0 && !current && key !== 'tag') return []
    const empty = list.length === 0 && !current
    const options = [...new Set(current && !list.includes(current) ? [current, ...list] : list)]
    return [{ key, current, empty, options }]
  })
}

/** Sets one filter (ALL clears it) and keeps the others. */
function filterSetter(state: ReportState, onChange: (patch: Partial<ReportState>) => void) {
  return (key: FilterKey, value: string) => {
    const filters = { ...state.filters }
    if (value === ALL) delete filters[key]
    else filters[key] = value
    onChange({ filters })
  }
}

/** A filter's value as its chip shows it: a folder by its name (the path in the tooltip). */
function chipValue(key: FilterKey, value: string, names: Names): string {
  return key === 'project' || key === 'cwdPrefix' ? folderName(value) : filterLabel(key, value, names)
}

/**
 * Period, group by and measure, then a "Filters · N" button whose panel holds one menu per filter
 * (profile, project, folder, agent, account, model, ticket, pull request, tag), and the filters in
 * use as chips under the row.
 */
export function ReportFiltersBar({
  state,
  values,
  names,
  onChange,
  effective,
  overall = null
}: {
  state: ReportState
  values: ReportFilterValues | null
  names: Names
  onChange: (patch: Partial<ReportState>) => void
  /** The custom period actually shown, when it differs from the dates typed (a date missing, or too long a span). */
  effective?: { since: number; until: number } | null
  /** The report's totals over every group: the panel says how many sessions and turns the filters keep. */
  overall?: SpendTotals | null
}) {
  const { t, formatDate } = useI18n()
  const setFilter = filterSetter(state, onChange)
  const inUse = MENU_ORDER.filter((key) => state.filters[key] !== undefined)
  const chips: ActiveFilter[] = inUse.map((key) => {
    const value = state.filters[key]!
    return {
      key,
      label: t('reports.filterChip', { title: t(`reports.filter.${key}` as MessageKey), value: chipValue(key, value, names) }),
      title: filterLabel(key, value, names),
      onRemove: () => setFilter(key, ALL)
    }
  })
  return (
    <section aria-label={t('reports.filters')} className="flex flex-col gap-2.5" data-testid="report-filters">
      <div className="flex flex-wrap items-end gap-2">
        <Labeled label={t('reports.period')}>
          <Select aria-label={t('reports.period')} value={state.period} onChange={(v) => onChange({ period: v as ReportState['period'] })} options={PERIODS.map((p) => ({ value: p, label: t(`reports.period.${p}` as MessageKey) }))} />
        </Labeled>
        {state.period === 'custom' && (
          <>
            <Labeled label={t('reports.from')}>
              <Input type="date" aria-label={t('reports.from')} value={state.from} max={state.to || undefined} onChange={(e) => onChange({ from: e.target.value })} className="w-36" data-testid="report-from" />
            </Labeled>
            <Labeled label={t('reports.to')}>
              <Input type="date" aria-label={t('reports.to')} value={state.to} min={state.from || undefined} onChange={(e) => onChange({ to: e.target.value })} className="w-36" data-testid="report-to" />
            </Labeled>
          </>
        )}
        {effective && (
          <p className="self-center pt-4 text-xs text-muted" data-testid="report-effective">
            {t('reports.effective', { from: formatDate(effective.since, { day: 'numeric', month: 'short', year: 'numeric' }), to: formatDate(effective.until - 1, { day: 'numeric', month: 'short', year: 'numeric' }) })}
          </p>
        )}
        <Labeled label={t('reports.groupBy')}>
          <Select aria-label={t('reports.groupBy')} value={state.groupBy} onChange={(v) => onChange({ groupBy: v as ReportState['groupBy'] })} options={GROUP_BYS.map((g) => ({ value: g, label: t(`reports.group.${g}` as MessageKey) }))} />
        </Labeled>
        <Labeled label={t('reports.metric')}>
          <div role="group" aria-label={t('reports.metric')} className="inline-flex h-8 rounded-md border border-border bg-surface p-0.5 shadow-sm" data-testid="report-metric">
            {METRICS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={state.metric === m}
                onClick={() => onChange({ metric: m })}
                className={cn('rounded px-2.5 text-sm transition-colors', state.metric === m ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:text-text')}
              >
                {t(`reports.metric.${m}` as MessageKey)}
              </button>
            ))}
          </div>
        </Labeled>
        <FiltersPopover label={t('reports.filters')} count={inUse.length} size="md" width={470} data-testid="report-filters-button">
          <ReportFilterPanel state={state} values={values} names={names} onChange={onChange} overall={overall} />
        </FiltersPopover>
      </div>
      <ActiveFilterChips filters={chips} clearLabel={t('reports.clearFilters')} removeLabel={(label) => t('reports.removeFilter', { label })} onClear={() => onChange(clearedReport(state))} data-testid="report-active-filters" />
    </section>
  )
}

/**
 * The Filters panel: one menu per filter with something to pick, two to a row with their names,
 * the ones in use tinted; Clear, and how many sessions and turns the report counts with Done.
 */
export function ReportFilterPanel({ state, values, names, onChange, overall }: { state: ReportState; values: ReportFilterValues | null; names: Names; onChange: (patch: Partial<ReportState>) => void; overall: SpendTotals | null }) {
  const { t, tn } = useI18n()
  const setFilter = filterSetter(state, onChange)
  const inUse = MENU_ORDER.filter((key) => state.filters[key] !== undefined).length
  return (
    <div className="flex flex-col" data-testid="report-filter-panel">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="text-md font-semibold text-text">{t('reports.filters')}</h2>
        {inUse > 0 && <span className="text-xs text-subtle">{tn('reports.filtersActive', inUse)}</span>}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={!canClearReport(state)} onClick={() => onChange(clearedReport(state))} data-testid="report-clear-filters">
          {t('reports.clearFilters')}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-3.5 gap-y-3">
        {filterMenus(state, values).map(({ key, current, empty, options }) => (
          <div key={key} className="flex min-w-0 flex-col gap-1" title={empty ? t('reports.noTags') : undefined}>
            <span className="text-xs text-subtle" aria-hidden>
              {t(`reports.filter.${key}` as MessageKey)}
            </span>
            <Select
              aria-label={t(`reports.filter.${key}` as MessageKey)}
              value={current ?? ALL}
              onChange={(v) => setFilter(key, v)}
              disabled={empty}
              options={[{ value: ALL, label: empty ? t('reports.noTags') : t(`reports.all.${key}` as MessageKey) }, ...options.map((v) => ({ value: v, label: filterLabel(key, v, names) }))]}
              className={current ? 'border-accent! bg-accent-soft! font-semibold' : 'text-muted!'}
            />
          </div>
        ))}
      </div>
      <div className="mt-3.5 flex items-center gap-2 border-t border-border pt-2.5">
        {overall && (
          <span className="text-xs text-subtle tabular-nums" data-testid="report-filter-count">
            {tn('reports.filtersSessions', overall.sessions)} · {tn('reports.sessions.turns', overall.turns)}
          </span>
        )}
        <FiltersPopoverClose asChild>
          <Button size="sm" variant="primary" className="ml-auto">
            {t('reports.filtersDone')}
          </Button>
        </FiltersPopoverClose>
      </div>
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-40 flex-col gap-1">
      <span className="text-xs text-muted" aria-hidden>
        {label}
      </span>
      {children}
    </div>
  )
}

const COLUMNS: { key: SortKey; label: MessageKey; numeric: boolean }[] = [
  { key: 'group', label: 'reports.col.group', numeric: false },
  { key: 'sessions', label: 'reports.col.sessions', numeric: true },
  { key: 'turns', label: 'reports.col.turns', numeric: true },
  { key: 'tokensIn', label: 'reports.col.tokensIn', numeric: true },
  { key: 'tokensOut', label: 'reports.col.tokensOut', numeric: true },
  { key: 'cache', label: 'reports.col.cache', numeric: true },
  { key: 'usd', label: 'reports.col.usd', numeric: true },
  { key: 'activeMs', label: 'reports.col.active', numeric: true }
]

/**
 * Totals per group, sortable by any column (a header button; aria-sort tells which), ten rows a page
 * with a pager below, and a totals row over every group.
 */
export function ReportTable({
  rows,
  overall,
  groupBy,
  sort,
  onSort,
  label,
  colors,
  page = 0,
  onPage
}: {
  /** Every group, sorted: the table shows page `page` of them. */
  rows: SpendTotals[]
  /** The period's totals over every group (sessions counted once). */
  overall: SpendTotals | null
  groupBy: ReportGroupBy
  sort: Sort
  onSort: (sort: Sort) => void
  label: (group: string | null) => { text: string; title?: string }
  /** The chart color of a group, when it has one of its own. */
  colors: (group: string | null) => string | null
  /** The page shown, 0-based. */
  page?: number
  onPage?: (page: number) => void
}) {
  const { t, locale, formatNumber } = useI18n()
  const sum = overall ?? { ...sumTotals(rows), sessions: 0, group: null }
  const linked = groupBy === 'ticket' || groupBy === 'pr' || groupBy === 'tag'
  const cell = (r: Omit<SpendTotals, 'group'>, key: SortKey): string => {
    switch (key) {
      case 'sessions':
        return formatNumber(r.sessions)
      case 'turns':
        return formatNumber(r.turns)
      case 'tokensIn':
        return formatTokens(r.tokensIn, locale)
      case 'tokensOut':
        return formatTokens(r.tokensOut, locale)
      case 'cache':
        return formatTokens(r.cacheRead + r.cacheWrite, locale)
      case 'usd':
        return formatUsd(r.usd, locale)
      case 'activeMs':
        return formatActive(r.activeMs)
      default:
        return ''
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="report-table">
          <thead>
            <tr className="border-b border-border text-xs text-muted">
              {COLUMNS.map((c) => {
                const active = sort.key === c.key
                return (
                  <th key={c.key} scope="col" aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'} className={cn('py-1.5 font-medium', c.numeric ? 'pl-3 text-right' : 'pr-3 text-left')}>
                    <button
                      type="button"
                      onClick={() => onSort({ key: c.key, desc: active ? !sort.desc : c.numeric })}
                      title={t('reports.table.sortBy', { column: t(c.label) })}
                      className={cn('inline-flex items-center gap-1 rounded px-0.5 hover:text-text', active && 'text-text')}
                    >
                      {t(c.label)}
                      {active && (sort.desc ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden />)}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows(rows, page).map((r) => {
              const l = label(r.group)
              const color = colors(r.group)
              return (
                <tr key={r.group ?? '\u0000none'} className="border-b border-border/60 last:border-0 hover:bg-surface-hover/50" data-testid="report-row">
                  <th scope="row" className="max-w-72 py-1.5 pr-3 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-1.5" title={l.title ?? l.text}>
                      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color ?? 'transparent' }} aria-hidden />
                      <span className={cn('truncate', r.group === null && 'text-muted italic')}>{l.text}</span>
                    </span>
                  </th>
                  {COLUMNS.slice(1).map((c) => (
                    <td key={c.key} className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">
                      {cell(r, c.key)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border-strong font-medium">
              <th scope="row" className="py-1.5 pr-3 text-left">
                {t('reports.table.total')}
              </th>
              {COLUMNS.slice(1).map((c) => (
                <td key={c.key} className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">
                  {c.key === 'sessions' && !overall ? '–' : cell(sum, c.key)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager offset={page * PAGE_SIZE} count={pageRows(rows, page).length} total={rows.length} onPrev={() => onPage?.(page - 1)} onNext={() => onPage?.(page + 1)} label={t('reports.table.pages')} testId="report-table-pager" />
      {linked && <p className="text-xs text-subtle">{t('reports.table.linkedNote', { group: t(`reports.group.${groupBy}` as MessageKey).toLowerCase() })}</p>}
    </div>
  )
}

/**
 * A page of the sessions of the current filters (ten, most recent first): title (opens it in
 * History), agent and account, folder, when, numbers, links and tags; a pager below.
 */
export function ReportSessions({
  sessions,
  names,
  loading = false,
  page = 0,
  total = null,
  hasNext,
  pageLoading = false,
  onPage,
  onOpen,
  onTagsChanged
}: {
  /** The page shown. */
  sessions: ReportSession[]
  names: Names
  /** The report is reloading: the pager waits, its cursors belong to the list being replaced. */
  loading?: boolean
  /** The page's index, 0-based. */
  page?: number
  /** Every session of the filters (the tiles' count), when known. */
  total?: number | null
  /** The cursor API has a page after this one. */
  hasNext: boolean
  /** A page is on its way. */
  pageLoading?: boolean
  onPage: (delta: 1 | -1) => void
  onOpen: (s: ReportSession) => void
  onTagsChanged?: (id: string, tags: string[]) => void
}) {
  const { t, tn, locale, formatDate } = useI18n()
  // An emptied later page keeps its pager, so Previous stays reachable.
  if (sessions.length === 0 && page === 0) return <p className="py-4 text-sm text-muted">{t('reports.sessions.empty')}</p>
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border" data-testid="report-sessions">
        {sessions.map((s) => {
          const when = s.endedAt ?? s.startedAt
          const folder = s.workPath ?? s.cwd
          const account = s.accountId ? (names.accounts?.get(s.accountId) ?? s.accountId) : null
          return (
            <li key={s.id} className="flex flex-col gap-1 py-2" data-testid="report-session">
              <div className="flex min-w-0 items-baseline gap-2">
                <button type="button" onClick={() => onOpen(s)} title={t('reports.sessions.openHint')} className="min-w-0 truncate text-left text-base font-medium hover:text-accent hover:underline">
                  {s.title || t('reports.sessions.untitled')}
                </button>
                <span className="ml-auto shrink-0 text-xs text-muted tabular-nums">
                  {formatTokens(freshTokens(s), locale)} · {formatUsd(s.usd, locale)} · {formatActive(s.activeMs)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                {when !== null && <span>{formatDate(when, { dateStyle: 'medium', timeStyle: 'short' })}</span>}
                <Badge icon={<AgentIcon agentId={s.agent} className="size-4 rounded-sm text-[9px]" />} className="h-5">
                  {names.agents?.get(s.agent) ?? s.agent}
                </Badge>
                {account && (
                  <Badge icon={<UserRound className="size-3" aria-hidden />} className="h-4">
                    {account}
                  </Badge>
                )}
                {folder && (
                  <span className="truncate font-mono" title={folder}>
                    {abbreviateFolder(folder)}
                  </span>
                )}
                <span>{tn('reports.sessions.turns', s.turns)}</span>
                {s.tickets.map((k) => (
                  <Badge key={k} icon={<Ticket className="size-3" aria-hidden />} className="h-4">
                    {k}
                  </Badge>
                ))}
                {s.prs.map((url) => (
                  <Badge key={url} icon={<GitPullRequest className="size-3" aria-hidden />} className="h-4" title={url}>
                    {pullRequestLabel(url)}
                  </Badge>
                ))}
              </div>
              <TagsEditor sessionId={s.id} tags={s.tags} compact onChange={(tags) => onTagsChanged?.(s.id, tags)} />
            </li>
          )
        })}
      </ul>
      <Pager
        offset={page * PAGE_SIZE}
        count={sessions.length}
        total={total}
        hasNext={hasNext}
        busy={pageLoading || loading}
        onPrev={() => onPage(-1)}
        onNext={() => onPage(1)}
        label={t('reports.sessions.pages')}
        testId="report-sessions-pager"
      />
    </div>
  )
}

/**
 * The weekly summary card: the week's totals, time and cost per project, the pull requests and
 * tickets worked on, a week picker and "Copy summary" (Markdown, self-contained).
 */
export function WeeklySummaryView({
  week,
  loading,
  error,
  onRetry,
  weekStart,
  isCurrent,
  onWeek,
  scope
}: {
  week: WeeklyReport | null
  loading: boolean
  /** The week could not be read: said as such, never as an empty week. */
  error?: string
  onRetry?: () => void
  weekStart: number
  isCurrent: boolean
  onWeek: (delta: number | 0) => void
  /** Whose work it is: a profile's name, or "All profiles". */
  scope: string
}) {
  const { t, tn, locale, formatDate, formatNumber } = useI18n()
  const end = new Date(weekStart)
  end.setDate(end.getDate() + 6)
  const range = `${formatDate(weekStart, { day: 'numeric', month: 'short' })} – ${formatDate(end, { day: 'numeric', month: 'short', year: 'numeric' })}`
  const markdown = () => (week ? weeklyMarkdown(week, { t, tn, locale }) : '')
  const folded = foldSmallProjects(week?.projects ?? [])
  const maxProject = Math.max(1, ...folded.shown.map((p) => p.activeMs), folded.other?.activeMs ?? 0)
  const projectName = projectNames(folded.shown.map((p) => p.ref))
  return (
    <Card aria-label={t('reports.weekly.title')} data-testid="weekly-summary">
      <CardHeader
        title={t('reports.weekly.title')}
        meta={range}
        actions={
          <span className="flex items-center gap-1">
            <IconButton size="sm" label={t('reports.weekly.prev')} icon={<ChevronLeft className="size-4" />} onClick={() => onWeek(-1)} />
            {!isCurrent && (
              <Button size="sm" variant="ghost" onClick={() => onWeek(0)}>
                {t('reports.weekly.thisWeek')}
              </Button>
            )}
            <IconButton size="sm" label={t('reports.weekly.next')} icon={<ChevronRight className="size-4" />} disabled={isCurrent} onClick={() => onWeek(1)} />
          </span>
        }
      />
      <CardBody className="flex flex-col gap-3">
        {error && !loading ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-sm text-danger" data-testid="weekly-error">
            <span>{t('reports.weekly.error', { error })}</span>
            {onRetry && (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                {t('reports.retry')}
              </Button>
            )}
          </div>
        ) : loading && !week ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-3.5" /> {t('reports.loading')}
          </p>
        ) : !week || week.sessions === 0 ? (
          <p className="text-sm text-muted">{t('reports.weekly.empty')}</p>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-2">
              <Figure label={t('reports.tile.active')} value={formatActive(week.activeMs)} />
              <Figure label={t('reports.tile.usd')} value={formatUsd(week.usd, locale)} />
              <Figure label={t('reports.tile.sessions')} value={formatNumber(week.sessions)} />
            </dl>
            <section className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold text-muted">{t('reports.weekly.projects')}</h3>
              <ul className="flex flex-col gap-1">
                {folded.shown.map((p) => (
                  <li key={p.ref} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2 text-sm" title={p.ref}>
                    <span className="truncate">{projectName.get(p.ref) ?? folderName(p.ref)}</span>
                    <span className="h-1.5 overflow-hidden rounded-r bg-surface-hover" aria-hidden>
                      <span className="block h-full rounded-r bg-accent" style={{ width: `${Math.max(2, (p.activeMs / maxProject) * 100)}%` }} />
                    </span>
                    <span className="text-xs whitespace-nowrap text-muted tabular-nums">
                      {formatActive(p.activeMs)} · {formatUsd(p.usd, locale)}
                    </span>
                  </li>
                ))}
                {folded.other && (
                  <li className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2 text-sm text-muted" data-testid="weekly-other">
                    <span className="truncate">{t('reports.weekly.smallProjects', { count: folded.other.count, usd: formatUsd(WEEKLY_OTHER_MIN_USD, locale) })}</span>
                    <span className="h-1.5 overflow-hidden rounded-r bg-surface-hover" aria-hidden>
                      <span className="block h-full rounded-r bg-muted/50" style={{ width: `${Math.max(2, (folded.other.activeMs / maxProject) * 100)}%` }} />
                    </span>
                    <span className="text-xs whitespace-nowrap tabular-nums">
                      {formatActive(folded.other.activeMs)} · {formatUsd(folded.other.usd, locale)}
                    </span>
                  </li>
                )}
              </ul>
            </section>
            {week.prs.length > 0 && (
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-semibold text-muted">{t('reports.weekly.prs')}</h3>
                <ul className="flex flex-wrap gap-1">
                  {week.prs.map((p) => (
                    <li key={p.ref}>
                      <Badge icon={<GitPullRequest className="size-3" aria-hidden />} title={`${p.ref}\n${formatActive(p.activeMs)} · ${formatUsd(p.usd, locale)}`}>
                        {pullRequestLabel(p.ref)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {week.tickets.length > 0 && (
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-semibold text-muted">{t('reports.weekly.tickets')}</h3>
                <ul className="flex flex-wrap gap-1">
                  {week.tickets.map((p) => (
                    <li key={p.ref}>
                      <Badge icon={<Ticket className="size-3" aria-hidden />} title={`${formatActive(p.activeMs)} · ${formatUsd(p.usd, locale)}`}>
                        {p.ref}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="min-w-0 text-xs text-subtle" title={t('reports.weekly.copyHint')} data-testid="weekly-scope">
            {t('reports.weekly.scope', { scope })}
          </span>
          {week && week.sessions > 0 && !error && <CopyButton text={markdown} label={t('reports.weekly.copy')} className="shrink-0" />}
        </div>
      </CardBody>
    </Card>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-hover/60 px-2 py-1.5">
      <dt className="text-2xs leading-tight text-muted">{label}</dt>
      <dd className="truncate text-md font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
