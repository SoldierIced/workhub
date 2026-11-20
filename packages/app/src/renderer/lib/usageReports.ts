/**
 * The "Usage and reports" screen's model: the filters (kept in localStorage), the period they pick,
 * the chart and table rows built from what main answers, and the weekly summary as Markdown.
 * Pure functions: the screen and the tests share them.
 */
import { REPORT_FILTER_KEYS, type ReportBucket, type ReportFilters, type ReportGroupBy, type ReportSession, type ReportSessionPage, type SpendPoint, type SpendTotals, type UsageCsvExport, type WeeklyReport } from '../../shared/analytics-api'
import type { MessageKey, Params, PluralKey } from '../i18n/translate'
import { folderName, formatTokens } from './home'
import { pullRequestLabel } from './monitorView'
import { abbreviateFolder } from './sessionHeader'

export const PERIODS = ['today', '7d', '30d', 'week', 'month', 'custom'] as const
export type Period = (typeof PERIODS)[number]
export const METRICS = ['tokens', 'usd', 'active'] as const
export type Metric = (typeof METRICS)[number]
export type GroupBy = Exclude<ReportGroupBy, 'none'>
export const GROUP_BYS: readonly GroupBy[] = ['project', 'agent', 'model', 'account', 'ticket', 'pr', 'tag']

export interface ReportState {
  period: Period
  /** Custom period, local dates `yyyy-mm-dd`, both days included. */
  from: string
  to: string
  groupBy: GroupBy
  metric: Metric
  filters: ReportFilters
}

export const DEFAULT_REPORT_STATE: ReportState = { period: '30d', from: '', to: '', groupBy: 'project', metric: 'tokens', filters: {} }
export const REPORT_STATE_KEY = 'workhub.usageReports'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback)

/** The saved state, each field checked; anything unknown falls back to the default. */
export function parseReportState(raw: string | null): ReportState {
  if (!raw) return DEFAULT_REPORT_STATE
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const filters: ReportFilters = {}
    const f = v['filters']
    if (f && typeof f === 'object' && !Array.isArray(f)) {
      for (const key of REPORT_FILTER_KEYS) {
        const value = (f as Record<string, unknown>)[key]
        if (typeof value === 'string' && value !== '') filters[key] = value.slice(0, 2048)
      }
    }
    return {
      period: oneOf(PERIODS, v['period'], DEFAULT_REPORT_STATE.period),
      from: typeof v['from'] === 'string' && DATE_RE.test(v['from']) ? v['from'] : '',
      to: typeof v['to'] === 'string' && DATE_RE.test(v['to']) ? v['to'] : '',
      groupBy: oneOf(GROUP_BYS, v['groupBy'], DEFAULT_REPORT_STATE.groupBy),
      metric: oneOf(METRICS, v['metric'], DEFAULT_REPORT_STATE.metric),
      filters
    }
  } catch {
    return DEFAULT_REPORT_STATE
  }
}

/**
 * What Clear changes: every filter goes, and a custom period goes back to the default one (its end
 * can be days ago, hiding everything since). A preset period always reaches today, so it stays.
 */
export function clearedReport(state: Pick<ReportState, 'period' | 'filters'>): Partial<ReportState> {
  return state.period === 'custom' ? { filters: {}, period: DEFAULT_REPORT_STATE.period, from: '', to: '' } : { filters: {} }
}

/** Whether Clear has something to do: a filter in use or a custom period. */
export function canClearReport(state: Pick<ReportState, 'period' | 'filters'>): boolean {
  return state.period === 'custom' || Object.keys(state.filters).length > 0
}

export function loadReportState(): ReportState {
  return typeof localStorage === 'undefined' ? DEFAULT_REPORT_STATE : parseReportState(localStorage.getItem(REPORT_STATE_KEY))
}

export function saveReportState(state: ReportState): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(REPORT_STATE_KEY, JSON.stringify(state))
}

const DAY = 86_400_000

export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function addDays(ms: number, days: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

/** Local midnight of the Monday of `ms`'s week (the weekly summary's start). */
export function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms))
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

/** `yyyy-mm-dd` of a local day. */
export function dateInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local midnight of a `yyyy-mm-dd` day, or null for anything else. */
export function parseDateInput(value: string): number | null {
  if (!DATE_RE.test(value)) return null
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 ? date.getTime() : null
}

/** The longest custom period: 540 days (main refuses longer). */
export const MAX_DAYS = 540

/** The period's start (inclusive) and end (exclusive), local days; a custom period missing a date reads as the last 30 days. */
export function periodRange(state: Pick<ReportState, 'period' | 'from' | 'to'>, now: number): { since: number; until: number } {
  const today = startOfDay(now)
  const tomorrow = addDays(today, 1)
  switch (state.period) {
    case 'today':
      return { since: today, until: tomorrow }
    case '7d':
      return { since: addDays(today, -6), until: tomorrow }
    case 'week': {
      const monday = startOfWeek(now)
      return { since: monday, until: addDays(monday, 7) }
    }
    case 'month': {
      const d = new Date(today)
      d.setDate(1)
      const first = d.getTime()
      d.setMonth(d.getMonth() + 1)
      return { since: first, until: d.getTime() }
    }
    case 'custom': {
      const from = parseDateInput(state.from)
      const to = parseDateInput(state.to)
      if (from !== null && to !== null) {
        const [a, b] = from <= to ? [from, to] : [to, from]
        return { since: Math.max(a, addDays(b, -(MAX_DAYS - 1))), until: addDays(b, 1) }
      }
      return { since: addDays(today, -29), until: tomorrow }
    }
    default:
      return { since: addDays(today, -29), until: tomorrow }
  }
}

/**
 * The custom period as it will be read, when that is not what the inputs say: a missing date (the
 * last 30 days are shown) or a span past `MAX_DAYS` (cut to its last `MAX_DAYS` days). Null when the
 * inputs are used as typed, or for a preset.
 */
export function customAdjusted(state: Pick<ReportState, 'period' | 'from' | 'to'>, now: number): { since: number; until: number } | null {
  if (state.period !== 'custom') return null
  const from = parseDateInput(state.from)
  const to = parseDateInput(state.to)
  const range = periodRange(state, now)
  if (from === null || to === null) return range
  return range.since > Math.min(from, to) ? range : null
}

/** Bars per day, or per week once the period is longer than 60 days. */
export function bucketFor(range: { since: number; until: number }): ReportBucket {
  return range.until - range.since > 60 * DAY + 2 * 3_600_000 ? 'week' : 'day'
}

/** Every bucket start of the period, so days without work still take their place on the axis. */
export function bucketStarts(range: { since: number; until: number }, bucket: ReportBucket): number[] {
  const out: number[] = []
  let at = bucket === 'week' ? startOfWeek(range.since) : startOfDay(range.since)
  for (let i = 0; at < range.until && i < 800; i++) {
    out.push(at)
    at = addDays(at, bucket === 'week' ? 7 : 1)
  }
  return out
}

type Sums = Pick<SpendTotals, 'tokensIn' | 'tokensOut' | 'cacheWrite' | 'usd' | 'activeMs'>

/** Fresh tokens (input, cache writes and output), as Home counts them: what weighs on a plan. */
export function freshTokens(r: Pick<SpendTotals, 'tokensIn' | 'tokensOut' | 'cacheWrite'>): number {
  return r.tokensIn + r.tokensOut + r.cacheWrite
}

export function metricValue(r: Sums, metric: Metric): number {
  if (metric === 'usd') return r.usd
  if (metric === 'active') return r.activeMs
  return freshTokens(r)
}

/** The key a group goes by in the charts (`null`, no value, is a group of its own). */
export const NONE_KEY = '\u0000none'
export const OTHER_KEY = '\u0000other'
export const groupKey = (group: string | null): string => (group === null ? NONE_KEY : group)

/** Series a chart colors: the categorical slots, then "Other" in a neutral gray. */
export const SERIES_SLOTS = 7

export interface Series {
  key: string
  /** 1-based palette slot, or 0 for "Other". */
  slot: number
  total: number
}

/**
 * The groups the charts draw. Colors go by fresh tokens over the period whatever the measure shown,
 * so switching between tokens, dollars and time keeps each group's color: the largest
 * `SERIES_SLOTS` get one each, in that order, and the rest fold into "Other". `total` is the
 * measure shown. Groups with nothing at all are left out.
 */
export function chartSeries(totals: readonly SpendTotals[], metric: Metric): Series[] {
  const ranked = totals
    .map((r) => ({ key: groupKey(r.group), total: metricValue(r, metric), rank: freshTokens(r) }))
    .filter((r) => r.total > 0 || r.rank > 0)
    .sort((a, b) => b.rank - a.rank || b.total - a.total || a.key.localeCompare(b.key))
  const fits = ranked.length <= SERIES_SLOTS + 1
  const shown = fits ? ranked : ranked.slice(0, SERIES_SLOTS)
  const out: Series[] = shown.map((r, i) => ({ key: r.key, slot: i + 1, total: r.total }))
  if (!fits) out.push({ key: OTHER_KEY, slot: 0, total: ranked.slice(SERIES_SLOTS).reduce((a, r) => a + r.total, 0) })
  return out
}

/** The group with the most of the measure shown ("Other" aside), for the chart's summary: `chartSeries` ranks by tokens. */
export function largestSeries(series: readonly Series[]): Series | undefined {
  let top: Series | undefined
  for (const s of series) if (s.key !== OTHER_KEY && (!top || s.total > top.total)) top = s
  return top
}

export interface StackBucket {
  start: number
  /** One value per series, in `chartSeries` order. */
  values: number[]
  total: number
}

/** The metric per bucket and series; groups outside the series add to "Other". */
export function stackBuckets(points: readonly SpendPoint[], series: readonly Series[], starts: readonly number[], metric: Metric): StackBucket[] {
  const index = new Map(series.map((s, i) => [s.key, i]))
  const other = index.get(OTHER_KEY)
  const byStart = new Map(starts.map((start) => [start, new Array<number>(series.length).fill(0)]))
  for (const p of points) {
    const values = byStart.get(p.bucketStart)
    if (!values) continue
    const i = index.get(groupKey(p.group)) ?? other
    if (i === undefined) continue
    values[i] = values[i]! + metricValue(p, metric)
  }
  return starts.map((start) => {
    const values = byStart.get(start)!
    return { start, values, total: values.reduce((a, v) => a + v, 0) }
  })
}

/** A round axis maximum (1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten) at or above `max`, so the tallest bar fills most of the plot. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1
  const pow = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * pow >= max) return step * pow
  return 10 * pow
}

export type SortKey = 'group' | 'sessions' | 'turns' | 'tokensIn' | 'tokensOut' | 'cache' | 'usd' | 'activeMs'
export interface Sort {
  key: SortKey
  desc: boolean
}

/** The table's rows sorted by a column; ties keep the group order. Labels sort by `label`. */
/** The totals table's sort and page (0-based). */
export interface TableView {
  sort: Sort
  page: number
}

export const INITIAL_TABLE: TableView = { sort: { key: 'usd', desc: true }, page: 0 }

/** A new sort: the table goes back to its first page. */
export function sortTable(_prev: TableView, sort: Sort): TableView {
  return { sort, page: 0 }
}

/** Another page of the table, same sort. */
export function tablePageTo(prev: TableView, page: number): TableView {
  return prev.page === page ? prev : { ...prev, page: Math.max(0, page) }
}

export function sortTotals<T extends SpendTotals>(rows: readonly T[], sort: Sort, label: (group: string | null) => string): T[] {
  const value = (r: T): number | string => {
    if (sort.key === 'group') return label(r.group).toLowerCase()
    if (sort.key === 'cache') return r.cacheRead + r.cacheWrite
    return r[sort.key]
  }
  return [...rows].sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb) : (va as number) - (vb as number)
    return sort.desc ? -cmp : cmp
  })
}

export function sumTotals(rows: readonly SpendTotals[]): Omit<SpendTotals, 'group' | 'sessions'> {
  return rows.reduce(
    (a, r) => ({
      tokensIn: a.tokensIn + r.tokensIn,
      tokensOut: a.tokensOut + r.tokensOut,
      cacheRead: a.cacheRead + r.cacheRead,
      cacheWrite: a.cacheWrite + r.cacheWrite,
      usd: a.usd + r.usd,
      unpricedTokens: a.unpricedTokens + r.unpricedTokens,
      activeMs: a.activeMs + r.activeMs,
      turns: a.turns + r.turns
    }),
    { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpricedTokens: 0, activeMs: 0, turns: 0 }
  )
}

/** Agent time: "42 min", "3 h 05 min"; under a minute, "< 1 min" (or "0 min" for none). */
export function formatActive(ms: number): string {
  if (ms <= 0) return '0 min'
  const m = Math.round(ms / 60_000)
  if (m < 1) return '< 1 min'
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

export function formatUsd(usd: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: usd > 0 && usd < 1 ? 3 : 2 }).format(usd)
}

/** A value of the metric, formatted: compact tokens ("41K", "41 mil"), dollars or agent time. */
export function formatMetric(value: number, metric: Metric, locale: string): string {
  if (metric === 'usd') return formatUsd(value, locale)
  if (metric === 'active') return formatActive(value)
  return formatTokens(value, locale)
}

/** What the reports know about names: accounts and agents by id, profiles by id. */
export interface Names {
  accounts?: ReadonlyMap<string, string>
  agents?: ReadonlyMap<string, string>
  profiles?: ReadonlyMap<string, string>
}

type T = (key: MessageKey, params?: Params) => string

/** A group's label: folders shortened (`~/…/repo`), PRs as `repo#12`, ids as their names, no value as "No ticket" and the like. */
export function groupLabel(groupBy: ReportGroupBy, group: string | null, t: T, names: Names = {}): string {
  if (group === OTHER_KEY) return t('reports.otherGroup')
  if (group === null || group === NONE_KEY) return t(`reports.none.${groupBy === 'none' ? 'project' : groupBy}`)
  switch (groupBy) {
    case 'project':
      return abbreviateFolder(group)
    case 'pr':
      return pullRequestLabel(group)
    case 'account':
      return names.accounts?.get(group) ?? group
    case 'agent':
      return names.agents?.get(group) ?? group
    default:
      return group
  }
}

/** How a filter value reads in its menu (folders shortened, PRs as `repo#12`, ids as names). */
export function filterLabel(key: (typeof REPORT_FILTER_KEYS)[number], value: string, names: Names = {}): string {
  if (key === 'cwdPrefix' || key === 'project') return abbreviateFolder(value)
  if (key === 'pr') return pullRequestLabel(value)
  if (key === 'account') return names.accounts?.get(value) ?? value
  if (key === 'agent') return names.agents?.get(value) ?? value
  if (key === 'profileId') return names.profiles?.get(value) ?? value
  return value
}

export interface SummaryFormat {
  t: T
  tn: (base: PluralKey, count: number, params?: Params) => string
  locale: string
}

/**
 * The weekly summary as Markdown, to paste to someone who has never seen Workhub: the week, its
 * totals, agent time and cost per project (by folder name, never a full path), then the pull
 * requests and tickets worked on.
 */
/** Projects under this many dollars in the week fold into one "Other" row, so the summary is not a long tail of cents. */
export const WEEKLY_OTHER_MIN_USD = 1

export type WeeklyOther = { count: number; activeMs: number; usd: number }

/**
 * The projects to list in the weekly summary and the fold of the small ones: projects under
 * `WEEKLY_OTHER_MIN_USD` become one "Other" row when there are at least two of them and at least
 * one project above the line (otherwise there is nothing worth hiding them behind).
 */
export function foldSmallProjects<T extends { activeMs: number; usd: number }>(projects: readonly T[], minUsd = WEEKLY_OTHER_MIN_USD): { shown: T[]; other: WeeklyOther | null } {
  const small = projects.filter((p) => p.usd < minUsd)
  if (small.length < 2 || small.length === projects.length) return { shown: [...projects], other: null }
  const other = small.reduce<WeeklyOther>((acc, p) => ({ count: acc.count + 1, activeMs: acc.activeMs + p.activeMs, usd: acc.usd + p.usd }), { count: 0, activeMs: 0, usd: 0 })
  return { shown: projects.filter((p) => p.usd >= minUsd), other }
}

export function weeklyMarkdown(week: WeeklyReport, f: SummaryFormat): string {
  const { t, tn, locale } = f
  const day = (ms: number) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(ms)
  const range = `${day(week.weekStart)} – ${day(week.weekEnd - 1)}`
  const usd = (n: number) => formatUsd(n, locale)
  const lines = [`## ${t('reports.weekly.mdTitle', { range })}`, '']
  if (week.sessions === 0) {
    lines.push(t('reports.weekly.mdEmpty'))
    return lines.join('\n')
  }
  lines.push(
    `- ${tn('reports.weekly.mdSessions', week.sessions)}`,
    `- ${t('reports.weekly.mdTime', { time: formatActive(week.activeMs) })}`,
    `- ${t('reports.weekly.mdCost', { usd: usd(week.usd) })}`,
    `- ${t('reports.weekly.mdTokens', { input: formatTokens(week.tokensIn, locale), output: formatTokens(week.tokensOut, locale) })}`
  )
  if (week.projects.length) {
    lines.push('', `### ${t('reports.weekly.projects')}`, '', `| ${t('reports.weekly.mdProject')} | ${t('reports.col.active')} | ${t('reports.col.usd')} |`, '|---|---:|---:|')
    const { shown, other } = foldSmallProjects(week.projects)
    const names = projectNames(shown.map((p) => p.ref))
    for (const p of shown) lines.push(`| ${escapeCell(names.get(p.ref)!)} | ${formatActive(p.activeMs)} | ${usd(p.usd)} |`)
    if (other) lines.push(`| ${escapeCell(t('reports.weekly.smallProjects', { count: other.count, usd: usd(WEEKLY_OTHER_MIN_USD) }))} | ${formatActive(other.activeMs)} | ${usd(other.usd)} |`)
  }
  if (week.prs.length) {
    lines.push('', `### ${t('reports.weekly.prs')}`, '')
    for (const p of week.prs) lines.push(`- [${pullRequestLabel(p.ref)}](${p.ref}) · ${formatActive(p.activeMs)} · ${usd(p.usd)}`)
  }
  if (week.tickets.length) {
    lines.push('', `### ${t('reports.weekly.tickets')}`, '')
    for (const p of week.tickets) lines.push(`- ${p.ref} · ${formatActive(p.activeMs)} · ${usd(p.usd)}`)
  }
  lines.push('', `_${t('reports.weekly.mdFootnote')}_`)
  return lines.join('\n')
}

/** Short names for folders: the folder's name, with its parent's when two share a name (never the full path). */
export function projectNames(paths: readonly string[]): Map<string, string> {
  const count = new Map<string, number>()
  for (const p of paths) count.set(folderName(p), (count.get(folderName(p)) ?? 0) + 1)
  return new Map(
    paths.map((p) => {
      const name = folderName(p)
      if ((count.get(name) ?? 0) < 2) return [p, name]
      const parts = p.split(/[\\/]/).filter(Boolean)
      return [p, parts.slice(-2).join('/')]
    })
  )
}

/**
 * Makes text safe inside a Markdown table cell. The backslash is escaped along with the pipe: a
 * name ending in `\` would otherwise escape the cell's closing pipe, and `a\|b` would turn into
 * `a\\|b`, an escaped backslash followed by a pipe that splits the cell.
 */
export function escapeCell(text: string): string {
  return text.replace(/[\\|]/g, '\\$&')
}

/**
 * Asks the app to read the transcripts written since its last scan (Refresh on Usage), waiting for
 * it. Never fails: an older main process without the call, or a failed scan, still lets the screen
 * query what is stored.
 */
export async function scanNewTranscripts(analytics: object): Promise<void> {
  const api = analytics as Partial<{ refresh(): Promise<void> }>
  if (typeof api.refresh !== 'function') return
  try {
    await api.refresh()
  } catch (e) {
    console.warn('[usage] transcript scan failed', e)
  }
}

/** The page of sessions on screen: its rows, its index (0-based), the cursor past it and whether a page is on its way. */
export interface SessionsPageView {
  rows: ReportSession[]
  page: number
  nextCursor: string | null
  loading: boolean
}

/** Reads one page of sessions: `cursor` null for the first. */
export type FetchSessionsPage = (cursor: string | null) => Promise<ReportSessionPage>

/**
 * Page-by-page navigation over the cursor API of `analytics.sessions`: a stack of the cursors that
 * read each page gives Previous, the page's `nextCursor` gives Next. Every request takes a number;
 * a reply that is no longer the latest (a newer page, a reset or a cancel since) is dropped.
 */
export class SessionPager {
  private seq = 0
  /** `cursors[i]` reads page i (page 0: null). */
  private cursors: (string | null)[] = [null]
  view: SessionsPageView = { rows: [], page: 0, nextCursor: null, loading: false }

  constructor(private readonly onChange: (view: SessionsPageView) => void = () => undefined) {}

  /** The cursor that reads the page on screen (to read it again with the same filters). */
  get cursor(): string | null {
    return this.cursors[this.view.page] ?? null
  }

  /**
   * A page read with the report: page 0 drops the cursor stack (new filters, period or sort); the
   * page on screen keeps it (the same report read again). Any page still on its way is dropped.
   */
  reset(first: ReportSessionPage, page = 0): void {
    this.seq++
    const at = Math.max(0, Math.min(page, this.cursors.length - 1))
    this.cursors.length = at + 1
    if (at === 0) this.cursors[0] = null
    this.set({ rows: first.rows, page: at, nextCursor: first.nextCursor, loading: false })
  }

  /** Drops any page on its way (the whole report is being read again). */
  cancel(): void {
    this.seq++
    if (this.view.loading) this.set({ ...this.view, loading: false })
  }

  /** The next page; nothing when there is none or one is loading. */
  next(fetch: FetchSessionsPage): Promise<void> {
    const cursor = this.view.nextCursor
    if (cursor === null || this.view.loading) return Promise.resolve()
    return this.go(this.view.page + 1, cursor, fetch)
  }

  /** The previous page, read again with its cursor; nothing on the first page or while one is loading. */
  prev(fetch: FetchSessionsPage): Promise<void> {
    if (this.view.page === 0 || this.view.loading) return Promise.resolve()
    return this.go(this.view.page - 1, this.cursors[this.view.page - 1] ?? null, fetch)
  }

  private async go(page: number, cursor: string | null, fetch: FetchSessionsPage): Promise<void> {
    const id = ++this.seq
    this.set({ ...this.view, loading: true })
    try {
      const result = await fetch(cursor)
      if (id !== this.seq) return
      this.cursors.length = page + 1
      this.cursors[page] = cursor
      this.set({ rows: result.rows, page, nextCursor: result.nextCursor, loading: false })
    } catch (e) {
      if (id !== this.seq) return
      this.set({ ...this.view, loading: false })
      throw e
    }
  }

  private set(view: SessionsPageView): void {
    this.view = view
    this.onChange(view)
  }
}

/**
 * The totals table as the CSV export takes it: the rows in the order on screen (every page, not
 * only the one shown), the group as the table names it in full, the numbers raw. `headers` are
 * the column titles in the screen's language. The totals row is left out: a file of records
 * should not mix them with their sum.
 */
export function csvTable(rows: readonly SpendTotals[], groupBy: ReportGroupBy, range: { since: number; until: number }, headers: string[], label: (group: string | null) => { text: string; title?: string }): UsageCsvExport {
  return {
    groupBy,
    since: range.since,
    until: range.until,
    headers,
    rows: rows.map((r) => {
      const l = label(r.group)
      return { group: l.title ?? l.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cache: r.cacheRead + r.cacheWrite, usd: r.usd, sessions: r.sessions, activeSeconds: Math.round(r.activeMs / 1000) }
    })
  }
}
