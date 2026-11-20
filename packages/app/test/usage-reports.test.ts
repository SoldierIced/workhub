import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SpendPoint, SpendTotals, WeeklyReport } from '../src/shared/analytics-api'
import { TooltipProvider } from '../src/renderer/components/atoms'
import { clampPage, PAGE_SIZE, Pager, pageRows, pagerModel } from '../src/renderer/components/molecules/Pager'
import { ShareBars, shareGeometry } from '../src/renderer/components/molecules/ShareBars'
import { activeBar, MAX_BAR, SEGMENT_GAP, StackedBarChart, stackGeometry, topRoundedPath } from '../src/renderer/components/molecules/StackedBarChart'
import { addTags, capTagDraft, MAX_TAG_LENGTH, MAX_TAGS, normalizeTagInput, tagsErrorKey } from '../src/renderer/components/molecules/TagsEditor'
import { backupErrorKey } from '../src/renderer/screens/settings/WorkhubSections'
import { translate, translatePlural, type MessageKey, type Params, type PluralKey } from '../src/renderer/i18n/translate'
import { tagsSessionId } from '../src/renderer/lib/monitorView'
import {
  bucketFor,
  bucketStarts,
  canClearReport,
  chartSeries,
  clearedReport,
  largestSeries,
  customAdjusted,
  DEFAULT_REPORT_STATE,
  escapeCell,
  formatActive,
  groupLabel,
  OTHER_KEY,
  NONE_KEY,
  parseReportState,
  periodRange,
  projectNames,
  scanNewTranscripts,
  SessionPager,
  sortTable,
  tablePageTo,
  INITIAL_TABLE,
  sortTotals,
  stackBuckets,
  startOfWeek,
  weeklyMarkdown,
  foldSmallProjects,
  type ReportState
} from '../src/renderer/lib/usageReports'
import type { ProjectBudgets } from '@workhub/core'
import { ProjectBudgetsCard } from '../src/renderer/screens/usage/ProjectBudgetsCard'
import { UsageReportsView, withProfile, type ReportData } from '../src/renderer/screens/UsageReportsScreen'
import { ReportFilterPanel, ReportSessions, ReportTable, WeeklySummaryView } from '../src/renderer/screens/usage/ReportParts'
import { Popover } from 'radix-ui'
import type { ReportSession, ReportSessionPage } from '../src/shared/analytics-api'

const render = (el: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, el))
const tEn = (key: MessageKey, params?: Params) => translate('en', key, params)
const fmt = (locale: 'en' | 'es') => ({ t: (k: MessageKey, p?: Params) => translate(locale, k, p), tn: (b: PluralKey, n: number, p?: Params) => translatePlural(locale, b, n, p), locale })

const day = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime()
// Wednesday, 18 November 2026, mid-afternoon.
const NOW = day(2026, 11, 18, 15)

const row = (group: string | null, over: Partial<SpendTotals> = {}): SpendTotals => ({ group, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpricedTokens: 0, activeMs: 0, turns: 1, sessions: 1, ...over })

describe('clearing the report filters', () => {
  const custom: ReportState = { ...DEFAULT_REPORT_STATE, period: 'custom', from: '2025-10-30', to: '2026-11-15', groupBy: 'tag', filters: { profileId: 'personal' } }

  it('removes every filter and sends a custom period back to the last 30 days', () => {
    // A custom period that ended days ago hides everything since: Clear must not leave it behind.
    expect(clearedReport(custom)).toEqual({ filters: {}, period: '30d', from: '', to: '' })
  })

  it('keeps a preset period, which always reaches today', () => {
    expect(clearedReport({ ...DEFAULT_REPORT_STATE, period: '7d', filters: { agent: 'claude' } })).toEqual({ filters: {} })
  })

  it('has something to clear with a filter in use or a custom period', () => {
    expect(canClearReport(DEFAULT_REPORT_STATE)).toBe(false)
    expect(canClearReport({ ...DEFAULT_REPORT_STATE, period: 'week' })).toBe(false)
    expect(canClearReport({ ...DEFAULT_REPORT_STATE, filters: { tag: 'spike' } })).toBe(true)
    expect(canClearReport({ ...custom, filters: {} })).toBe(true)
  })
})

describe('report period', () => {
  it('turns each preset into local days, the end exclusive', () => {
    const at = (period: ReportState['period'], from = '', to = '') => periodRange({ period, from, to }, NOW)
    expect(at('today')).toEqual({ since: day(2026, 11, 18), until: day(2026, 11, 19) })
    expect(at('7d')).toEqual({ since: day(2026, 11, 12), until: day(2026, 11, 19) })
    expect(at('30d')).toEqual({ since: day(2026, 10, 20), until: day(2026, 11, 19) })
    expect(at('week')).toEqual({ since: day(2026, 11, 16), until: day(2026, 11, 23) })
    expect(at('month')).toEqual({ since: day(2026, 11, 1), until: day(2026, 12, 1) })
    expect(at('custom', '2026-11-03', '2026-11-01')).toEqual({ since: day(2026, 11, 1), until: day(2026, 11, 4) })
    // A custom period missing a date reads as the last 30 days.
    expect(at('custom', '2026-11-03', '')).toEqual(at('30d'))
  })

  it('draws bars per day up to 60 days and per week past that, every bucket on the axis', () => {
    const month = periodRange({ period: '30d', from: '', to: '' }, NOW)
    expect(bucketFor(month)).toBe('day')
    expect(bucketStarts(month, 'day')).toHaveLength(30)
    const long = periodRange({ period: 'custom', from: '2026-06-01', to: '2026-11-18' }, NOW)
    expect(bucketFor(long)).toBe('week')
    const weeks = bucketStarts(long, 'week')
    expect(weeks[0]).toBe(startOfWeek(day(2026, 6, 1)))
    expect(new Date(weeks[1]!).getDay()).toBe(1)
  })

  it('restores saved filters, dropping anything malformed', () => {
    expect(parseReportState(null)).toEqual(DEFAULT_REPORT_STATE)
    expect(parseReportState('{nope')).toEqual(DEFAULT_REPORT_STATE)
    expect(parseReportState(JSON.stringify({ period: 'week', groupBy: 'tag', metric: 'usd', from: 'x', filters: { agent: 'codex', bogus: 'y', tag: 3 } }))).toEqual({
      period: 'week',
      from: '',
      to: '',
      groupBy: 'tag',
      metric: 'usd',
      filters: { agent: 'codex' }
    })
    expect(parseReportState(JSON.stringify({ period: 'year', groupBy: 'none' }))).toMatchObject({ period: '30d', groupBy: 'project' })
  })
})

describe('report series', () => {
  it('colors the largest groups in order and folds the rest into Other', () => {
    const totals = Array.from({ length: 10 }, (_, i) => row(`/w/p${i}`, { tokensIn: (i + 1) * 100 }))
    const series = chartSeries(totals, 'tokens')
    expect(series.map((s) => [s.key, s.slot])).toEqual([
      ['/w/p9', 1],
      ['/w/p8', 2],
      ['/w/p7', 3],
      ['/w/p6', 4],
      ['/w/p5', 5],
      ['/w/p4', 6],
      ['/w/p3', 7],
      [OTHER_KEY, 0]
    ])
    expect(series.at(-1)!.total).toBe(100 + 200 + 300)
    // Eight groups fit without an "Other"; a group with nothing in the metric is left out.
    expect(chartSeries([...totals.slice(0, 8), row('/w/zero')], 'tokens').map((s) => s.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(chartSeries([row(null, { usd: 2 }), row('a', { usd: 1 })], 'usd').map((s) => s.key)).toEqual([NONE_KEY, 'a'])
  })

  it('keeps each group on its color whatever the measure', () => {
    const totals = [row('/w/big', { tokensIn: 900, usd: 1, activeMs: 10 }), row('/w/small', { tokensIn: 100, usd: 5, activeMs: 99 })]
    const slots = (m: 'tokens' | 'usd' | 'active') => chartSeries(totals, m).map((s) => [s.key, s.slot])
    expect(slots('usd')).toEqual(slots('tokens'))
    expect(slots('active')).toEqual([
      ['/w/big', 1],
      ['/w/small', 2]
    ])
    expect(chartSeries(totals, 'usd').map((s) => s.total)).toEqual([1, 5])
  })

  it('names as largest the group with the most of the measure shown, not the token leader', () => {
    const totals = [row('/w/big', { tokensIn: 900, usd: 1 }), row('/w/small', { tokensIn: 100, usd: 5 })]
    expect(largestSeries(chartSeries(totals, 'tokens'))?.key).toBe('/w/big')
    expect(largestSeries(chartSeries(totals, 'usd'))?.key).toBe('/w/small')
    // "Other" never counts as the largest group, even when it adds up to more.
    const many = Array.from({ length: 12 }, (_, i) => row(`/w/p${i}`, { tokensIn: 1000 - i, usd: 1 }))
    const series = chartSeries(many, 'usd')
    expect(series.at(-1)!.key).toBe(OTHER_KEY)
    expect(largestSeries(series)?.key).toBe('/w/p0')
    expect(largestSeries([])).toBeUndefined()
  })

  it('stacks each bucket per series, groups outside the series counted in Other', () => {
    const starts = [day(2026, 11, 16), day(2026, 11, 17)]
    const totals = Array.from({ length: 9 }, (_, i) => row(`g${i}`, { activeMs: (9 - i) * 1000 }))
    const series = chartSeries(totals, 'active')
    const points: SpendPoint[] = [
      { ...row('g0', { activeMs: 4000 }), bucketStart: starts[0]! },
      { ...row('g8', { activeMs: 500 }), bucketStart: starts[0]! },
      { ...row('g7', { activeMs: 700 }), bucketStart: starts[1]! },
      { ...row('g0', { activeMs: 1 }), bucketStart: day(2026, 1, 1) }
    ]
    const buckets = stackBuckets(points, series, starts, 'active')
    expect(buckets[0]).toMatchObject({ start: starts[0], total: 4500 })
    expect(buckets[0]!.values[0]).toBe(4000)
    expect(buckets[0]!.values.at(-1)).toBe(500)
    expect(buckets[1]!.values.at(-1)).toBe(700)
  })

  it('sorts the table by any column, labels by their text', () => {
    const rows = [row('/w/b', { usd: 1, turns: 9 }), row('/w/a', { usd: 3, turns: 1 }), row(null, { usd: 2, turns: 5 })]
    const label = (g: string | null) => groupLabel('project', g, tEn)
    expect(sortTotals(rows, { key: 'usd', desc: true }, label).map((r) => r.group)).toEqual(['/w/a', null, '/w/b'])
    expect(sortTotals(rows, { key: 'turns', desc: false }, label).map((r) => r.group)).toEqual(['/w/a', null, '/w/b'])
    expect(sortTotals(rows, { key: 'group', desc: false }, label).map((r) => r.group)).toEqual(['/w/a', '/w/b', null])
  })

  it('names groups the way the rest of the app does', () => {
    expect(groupLabel('project', '/home/someone/code/acme/apps/notes-api', tEn)).toBe('~/…/apps/notes-api')
    expect(groupLabel('pr', 'https://example.com/acme/notes-api/pull/12', tEn)).toBe('acme/notes-api#12')
    expect(groupLabel('account', 'work', tEn, { accounts: new Map([['work', 'Work account']]) })).toBe('Work account')
    expect(groupLabel('ticket', null, tEn)).toBe('No ticket')
    expect(groupLabel('tag', OTHER_KEY, tEn)).toBe('Other')
    expect(formatActive(0)).toBe('0 min')
    expect(formatActive(20_000)).toBe('< 1 min')
    expect(formatActive(125 * 60_000)).toBe('2 h 05 min')
  })
})

describe('chart geometry', () => {
  it('caps bar width, stacks from the baseline with a surface gap and rounds only the top', () => {
    const { columns, plot } = stackGeometry(
      [
        { start: 1, values: [60, 40], total: 100 },
        { start: 2, values: [0, 0], total: 0 }
      ],
      400,
      200,
      100
    )
    const baseline = plot.y + plot.height
    const [a, b] = columns[0]!.segments
    expect(columns[0]!.width).toBeCloseTo(plot.width / 2)
    expect(a!.width).toBe(MAX_BAR)
    expect(a!.y + a!.height).toBeCloseTo(baseline)
    expect(a!.height).toBeCloseTo(plot.height * 0.6)
    expect(b!.y + b!.height + SEGMENT_GAP).toBeCloseTo(a!.y)
    expect(b!.y).toBeCloseTo(plot.y)
    expect([a!.top, b!.top]).toEqual([false, true])
    expect(columns[1]!.segments).toEqual([])
    expect(topRoundedPath(0, 0, 10, 20)).toBe('M0,20 V4 Q0,0 4,0 H6 Q10,0 10,4 V20 Z')
  })

  it('renders an accessible stacked chart: a summary label, one focus stop and a data table', () => {
    const html = render(
      createElement(StackedBarChart, {
        buckets: [
          { start: day(2026, 11, 16), values: [3, 1], total: 4 },
          { start: day(2026, 11, 17), values: [0, 2], total: 2 }
        ],
        series: [
          { key: 'a', slot: 1, label: 'notes-api' },
          { key: 'b', slot: 2, label: 'notes-web' }
        ],
        tick: (s) => String(new Date(s).getDate()),
        title: (s) => `Day ${new Date(s).getDate()}`,
        format: (v) => `${v} t`,
        summary: 'Tokens per day by project. Total 6 t.',
        tableCaption: 'Tokens per day by project',
        bucketHeader: 'Day',
        totalLabel: 'total'
      })
    )
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="Tokens per day by project. Total 6 t."')
    expect(html.match(/data-testid="chart-column"/g)).toHaveLength(2)
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    // A role, so screen readers announce each focusable bar's label.
    expect(html).toMatch(/role="img" aria-label="Day 16: 4 t"/)
    expect(html).toContain('<caption>Tokens per day by project</caption>')
    expect(html).toContain('var(--wh-series-1)')
  })

  it('keeps the chart tab stop on a bar that exists', () => {
    expect(activeBar(29, 7)).toBe(6)
    expect(activeBar(3, 7)).toBe(3)
    expect(activeBar(0, 0)).toBe(0)
  })

  it('measures shares against the period total when groups overlap', () => {
    // Two tickets on one session: each holds all of it, not half.
    expect(shareGeometry([{ value: 10 }, { value: 10 }], 10).map((g) => g.share)).toEqual([1, 1])
  })

  it('sizes share bars against the largest row and reports each share', () => {
    expect(shareGeometry([{ value: 30 }, { value: 10 }, { value: 0 }])).toEqual([
      { share: 0.75, length: 1 },
      { share: 0.25, length: 1 / 3 },
      { share: 0, length: 0 }
    ])
    const html = render(
      createElement(ShareBars, {
        rows: [
          { key: '/w/a', slot: 1, label: 'a', value: 30 },
          { key: OTHER_KEY, slot: 0, label: 'Other', value: 10 }
        ],
        format: (v: number) => `$${v}`,
        formatPercent: (f: number) => `${Math.round(f * 100)}%`,
        label: 'Share by project',
        onPick: () => undefined
      })
    )
    expect(html).toContain('aria-label="Share by project"')
    expect(html).toContain('$30')
    expect(html).toContain('75%')
    expect(html).toContain('var(--wh-series-other)')
    // "Other" is not a value to filter by.
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(1)
  })
})

const DATA: ReportData = {
  points: [
    { ...row('/w/acme/notes-api', { tokensIn: 5000, tokensOut: 1000, usd: 2.5, activeMs: 3_600_000, turns: 12, sessions: 2 }), bucketStart: day(2026, 11, 17) },
    { ...row('/w/acme/notes-web', { tokensIn: 1000, tokensOut: 500, usd: 0.75, activeMs: 600_000, turns: 3 }), bucketStart: day(2026, 11, 18) }
  ],
  totals: [row('/w/acme/notes-api', { tokensIn: 5000, tokensOut: 1000, usd: 2.5, activeMs: 3_600_000, turns: 12, sessions: 2 }), row('/w/acme/notes-web', { tokensIn: 1000, tokensOut: 500, usd: 0.75, activeMs: 600_000, turns: 3 })],
  overall: row(null, { tokensIn: 6000, tokensOut: 1500, usd: 3.25, activeMs: 4_200_000, turns: 15, sessions: 3 }),
  sessions: [
    {
      id: 'demo-1',
      agent: 'claude',
      accountId: null,
      profileId: 'p1',
      project: '/w/acme/notes-api',
      cwd: '/w/acme/notes-api',
      workPath: null,
      title: 'Fix ABC-123 login',
      startedAt: day(2026, 11, 17, 10),
      endedAt: day(2026, 11, 17, 11),
      activeMs: 3_600_000,
      lastModel: 'claude-sonnet-4-5',
      source: 'workhub',
      tokensIn: 5000,
      tokensOut: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      usd: 2.5,
      unpricedTokens: 0,
      turns: 12,
      links: [],
      tickets: ['ABC-123'],
      prs: ['https://example.com/acme/notes-api/pull/7'],
      branches: [],
      tags: ['spike']
    }
  ],
  nextCursor: null
}

const VALUES = { profiles: ['p1', 'p2'], projects: ['/w/acme/notes-api', '/w/acme/notes-web'], agents: ['claude'], accounts: [], models: ['claude-sonnet-4-5', 'gpt-5'], tickets: ['ABC-123'], prs: [], tags: ['spike', 'perf'] }

/** The Filters popover's content, as it renders once opened. */
const panel = (over: Partial<Parameters<typeof ReportFilterPanel>[0]> = {}) =>
  render(
    createElement(
      Popover.Root,
      { open: true },
      createElement(ReportFilterPanel, { state: { ...DEFAULT_REPORT_STATE, period: '7d' }, values: VALUES, names: {}, onChange: () => undefined, overall: DATA.overall, ...over })
    )
  )

const view = (over: Partial<Parameters<typeof UsageReportsView>[0]> = {}) =>
  render(
    createElement(UsageReportsView, {
      state: { ...DEFAULT_REPORT_STATE, period: '7d' },
      onChange: () => undefined,
      range: periodRange({ period: '7d', from: '', to: '' }, NOW),
      data: DATA,
      values: VALUES,
      loading: false,
      names: {},
      onRefresh: async () => undefined,
      onSessionsPage: () => undefined,
      onOpenSession: () => undefined,
      ...over
    })
  )

describe('Usage and reports screen', () => {
  it('offers Export CSV for the totals table only when the screen can export', () => {
    expect(view()).not.toContain('data-testid="report-export-csv"')
    const html = view({ onExportCsv: async () => ({ ok: false, canceled: true }) })
    expect(html).toContain('data-testid="report-export-csv"')
    expect(html).toContain('Export CSV')
  })

  it('keeps a greyed-out Tag menu while no session has a tag, saying where tags are added', () => {
    const html = panel({ values: { profiles: ['p1'], projects: ['/w/acme/notes-api'], agents: ['claude'], accounts: [], models: ['gpt-5'], tickets: [], prs: [], tags: [] } })
    expect(html).toContain('aria-label="Tag"')
    expect(html).toContain('No tags yet: add them from History or the session monitor')
    expect(html).not.toContain('aria-label="Pull request"')
  })

  it('keeps period, group by and measure in the row and folds the filter menus into a Filters button', () => {
    const html = view()
    expect(html).toContain('data-testid="report-filters"')
    expect(html).toContain('aria-label="Period"')
    expect(html).toContain('aria-label="Group by"')
    expect(html).toContain('data-testid="report-filters-button"')
    expect(html).not.toContain('aria-label="Profile"')
    // No filter in use: the button has no count and no chips show.
    expect(html).toMatch(/data-testid="report-filters-button"[^>]*><span>Filters<\/span>/)
    expect(html).not.toContain('data-testid="report-active-filters"')
  })

  it('puts the menus with something to pick in the Filters panel, with the sessions and turns the report counts', () => {
    const html = panel()
    expect(html).toContain('aria-label="Profile"')
    expect(html).toContain('aria-label="Project"')
    expect(html).toContain('aria-label="Model"')
    expect(html).toContain('aria-label="Tag"')
    // One agent, one ticket: the menus stay, so the filter can be found; no account: no menu.
    expect(html).toContain('aria-label="Agent"')
    expect(html).toContain('aria-label="Ticket"')
    expect(html).not.toContain('aria-label="Account"')
    expect(html).toContain('data-testid="report-filter-count"')
    expect(html).toMatch(/\d+ sessions? · \d+ turns?/)
    expect(html).toContain('>Done<')
    // Nothing to clear yet.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="report-clear-filters"/)
  })

  it('offers Clear for a custom period even with no filter in use', () => {
    const html = panel({ state: { ...DEFAULT_REPORT_STATE, period: 'custom', from: '2025-10-30', to: '2026-11-15' } })
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="report-clear-filters"/)
    expect(html).toContain('data-testid="report-clear-filters"')
  })

  it('tints the menus in use and counts them in the panel', () => {
    const html = panel({ state: { ...DEFAULT_REPORT_STATE, filters: { project: '/w/acme/notes-api', agent: 'claude' } } })
    expect(html).toContain('2 active')
    expect(html.match(/border-accent! bg-accent-soft!/g)).toHaveLength(2)
  })

  it('shows the tiles, both charts, the table and the sessions', () => {
    const html = view()
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('data-testid="report-tiles"')
    expect(html).toContain('$3.25')
    expect(html).toContain('1 h 10 min')
    expect(html).toContain('data-testid="stacked-bar-chart"')
    expect(html).toContain('data-testid="share-bars"')
    expect(html.match(/data-testid="report-row"/g)).toHaveLength(2)
    expect(html).toContain('Fix ABC-123 login')
    expect(html).toContain('acme/notes-api#7')
    expect(html).toContain('spike')
    // Sorted by cost, largest first.
    expect(html.indexOf('notes-api</span></span></th>')).toBeLessThan(html.indexOf('notes-web</span></span></th>'))
    expect(html).toContain('aria-sort="descending"')
  })

  it('names the largest group by the measure shown in the chart summary', () => {
    const totals = [row('/w/acme/notes-api', { tokensIn: 9000, usd: 1 }), row('/w/acme/notes-web', { tokensIn: 100, usd: 4 })]
    const html = view({ state: { ...DEFAULT_REPORT_STATE, period: '7d', metric: 'usd' }, data: { ...DATA, totals } })
    expect(html).toContain('Largest: /w/acme/notes-web, $4.00.')
  })

  it('labels the chart as a group of focusable bars, takes its total from the period, and reads tokens that add up', () => {
    const html = view({ data: { ...DATA, overall: { ...DATA.overall!, tokensIn: 5000, tokensOut: 2000, cacheWrite: 500, cacheRead: 90_000 } } })
    expect(html).toMatch(/<svg role="group" aria-label="Tokens per day by project[^"]*Total 7\.5K/)
    expect(html).toContain('5K in · 2K out · 500 cache writes. Cache reads: 90K')
  })

  it('says a session linked to several tickets counts in each, under the chart and the share card too', () => {
    const html = view({ state: { ...DEFAULT_REPORT_STATE, period: '7d', groupBy: 'ticket' } })
    expect(html.match(/counts in each/g)).toHaveLength(3)
  })

  it('shows a failed first load as an error with Retry, never as an empty period', () => {
    const html = view({ data: null, error: 'database locked' })
    expect(html).toContain('data-testid="report-error"')
    expect(html).toContain('database locked')
    expect(html).toContain('Retry')
    expect(html).not.toContain('Nothing recorded')
  })

  it('shows the custom range actually read when it is cut or a date is missing', () => {
    expect(customAdjusted({ period: 'custom', from: '2026-11-01', to: '2026-11-18' }, NOW)).toBeNull()
    expect(customAdjusted({ period: '7d', from: '', to: '' }, NOW)).toBeNull()
    expect(customAdjusted({ period: 'custom', from: '', to: '2026-11-18' }, NOW)).toEqual(periodRange({ period: '30d', from: '', to: '' }, NOW))
    const cut = customAdjusted({ period: 'custom', from: '2020-01-01', to: '2026-11-18' }, NOW)!
    expect(cut.since).toBeGreaterThan(day(2020, 1, 1))
    const html = view({ state: { ...DEFAULT_REPORT_STATE, period: 'custom', from: '', to: '2026-11-18' }, effective: { since: day(2026, 10, 20), until: day(2026, 11, 19) } })
    expect(html).toContain('Showing Oct 20, 2026 – Nov 18, 2026')
  })

  it('opens on the active profile, and "All profiles" clears it', () => {
    const state = { ...DEFAULT_REPORT_STATE, filters: { tag: 'spike', profileId: 'old' } }
    expect(withProfile(state, 'work').filters).toEqual({ tag: 'spike', profileId: 'work' })
    expect(withProfile(state, null).filters).toEqual({ tag: 'spike' })
  })

  it('offers an exact project menu and a folder-and-below one', () => {
    const html = panel()
    expect(html).toContain('aria-label="Folder and below"')
  })

  it('shows the filters in use as removable chips with Clear, the count on the button, and the custom dates for a custom period', () => {
    const html = view({ state: { ...DEFAULT_REPORT_STATE, period: 'custom', from: '2026-11-01', to: '2026-11-18', filters: { tag: 'spike', project: '/w/acme/notes-api' } } })
    expect(html).toContain('data-testid="report-active-filters"')
    expect(html).toContain('<span>Filters · 2</span>')
    // A folder goes by its name on the chip, its path in the tooltip.
    expect(html).toContain('Project: notes-api')
    expect(html).toContain('Tag: spike')
    expect(html).toContain('aria-label="Remove Tag: spike"')
    expect(html).toContain('data-testid="active-filters-clear"')
    expect(html).toContain('data-testid="report-from"')
    expect(html).toContain('value="2026-11-01"')
  })

  it('says when nothing was recorded, and when the filters match nothing', () => {
    const empty = { ...DATA, points: [], totals: [], overall: null, sessions: [] }
    expect(view({ data: empty })).toContain('Nothing recorded in this period')
    expect(view({ data: empty, state: { ...DEFAULT_REPORT_STATE, filters: { agent: 'codex' } } })).toContain('Nothing matches these filters')
    expect(view({ data: null, loading: true })).toContain('data-testid="report-loading"')
  })
})

const WEEK: WeeklyReport = {
  weekStart: day(2026, 11, 16),
  weekEnd: day(2026, 11, 23),
  sessions: 3,
  activeMs: 4_200_000,
  usd: 3.25,
  tokensIn: 6000,
  tokensOut: 1500,
  projects: [
    { ref: '/home/someone/code/acme/notes-api', project: '/home/someone/code/acme/notes-api', activeMs: 3_600_000, usd: 2.5, tokens: 6000, turns: 12, sessions: 2 },
    { ref: '/w/acme/notes|web', project: '/w/acme/notes|web', activeMs: 600_000, usd: 0.75, tokens: 1500, turns: 3, sessions: 1 }
  ],
  prs: [{ ref: 'https://example.com/acme/notes-api/pull/7', activeMs: 3_600_000, usd: 2.5, tokens: 6000, turns: 12, sessions: 2 }],
  tickets: [{ ref: 'ABC-123', activeMs: 3_600_000, usd: 2.5, tokens: 6000, turns: 12, sessions: 2 }],
  prsOpened: [],
  prsMerged: [],
  prsReviewed: [],
  ticketMoves: []
}

describe('escapeCell', () => {
  it('escapes backslashes before pipes so a cell never leaks into the next one', () => {
    expect(escapeCell('notes|web')).toBe('notes\\|web')
    expect(escapeCell('trailing\\')).toBe('trailing\\\\')
    expect(escapeCell('a\\|b')).toBe('a\\\\\\|b')
    expect(escapeCell('plain')).toBe('plain')
  })
})

describe('weekly summary', () => {
  it('writes self-contained Markdown: totals, a table per project by folder name, PRs and tickets', () => {
    const md = weeklyMarkdown(WEEK, fmt('en'))
    expect(md).toBe(
      [
        '## Weekly summary: Nov 16, 2026 – Nov 22, 2026',
        '',
        '- 3 agent sessions',
        '- Agent time: 1 h 10 min',
        '- Cost at list prices: $3.25',
        '- Tokens: 6K input, 1.5K output',
        '',
        '### Time per project',
        '',
        '| Project | Agent time | Cost |',
        '|---|---:|---:|',
        '| notes-api | 1 h 00 min | $2.50 |',
        '| notes\\|web | 10 min | $0.75 |',
        '',
        '### Pull requests',
        '',
        '- [acme/notes-api#7](https://example.com/acme/notes-api/pull/7) · 1 h 00 min · $2.50',
        '',
        '### Tickets',
        '',
        '- ABC-123 · 1 h 00 min · $2.50',
        '',
        `_${translate('en', 'reports.weekly.mdFootnote')}_`
      ].join('\n')
    )
    // Never a home path in what gets pasted.
    expect(md).not.toContain('/home/')
  })

  it('writes it in Spanish too, and says so when the week is empty', () => {
    const md = weeklyMarkdown(WEEK, fmt('es'))
    expect(md).toContain('## Resumen semanal: 16 nov 2026 – 22 nov 2026')
    expect(md).toContain('- 3 sesiones de agente')
    expect(md).toContain('### Tiempo por proyecto')
    expect(weeklyMarkdown({ ...WEEK, sessions: 0, projects: [], prs: [], tickets: [] }, fmt('en'))).toBe('## Weekly summary: Nov 16, 2026 – Nov 22, 2026\n\nNo agent work recorded this week.')
  })

  it('renders the week with its copy button, and no next week past this one', () => {
    const html = render(createElement(WeeklySummaryView, { week: WEEK, loading: false, weekStart: WEEK.weekStart, isCurrent: true, onWeek: () => undefined, scope: 'All profiles' }))
    expect(html).toContain('Weekly summary')
    expect(html).toContain('Copy summary')
    expect(html).toContain('data-testid="copy-button"')
    expect(html).toContain('notes-api')
    expect(html).toContain('ABC-123')
    expect(html).toMatch(/aria-label="Next week"[^>]*disabled=""|disabled=""[^>]*aria-label="Next week"/)
    // Whose week it is, always next to Copy summary; badges are list items.
    expect(html).toContain('Scope: All profiles')
    expect(html).toMatch(/<ul[^>]*><li><span[^>]*>/)
  })

  it('says when the week could not be read instead of calling it empty, with Retry', () => {
    const html = render(createElement(WeeklySummaryView, { week: null, loading: false, error: 'disk full', onRetry: () => undefined, weekStart: WEEK.weekStart, isCurrent: true, onWeek: () => undefined, scope: 'Work' }))
    expect(html).toContain('data-testid="weekly-error"')
    expect(html).toContain('The week could not be read: disk full')
    expect(html).toContain('Retry')
    expect(html).not.toContain('No agent work recorded')
    expect(html).not.toContain('Copy summary')
    expect(html).toContain('Scope: Work')
  })

  it('folds projects under a dollar into one "Other" row, unless they are alone or all of them', () => {
    const small = (ref: string, usd: number, activeMs: number) => ({ ...WEEK.projects[1]!, ref, project: ref, usd, activeMs })
    const projects = [WEEK.projects[0]!, small('/w/acme/a', 0.4, 60_000), small('/w/acme/b', 0.2, 30_000), small('/w/acme/c', 0.9, 90_000)]
    const { shown, other } = foldSmallProjects(projects)
    expect(shown.map((p) => p.ref)).toEqual([WEEK.projects[0]!.ref])
    expect(other).toEqual({ count: 3, activeMs: 180_000, usd: 1.5 })
    // One small project is listed as is; so is a week where every project is small.
    expect(foldSmallProjects(WEEK.projects).other).toBeNull()
    expect(foldSmallProjects(projects.slice(1)).other).toBeNull()
    const md = weeklyMarkdown({ ...WEEK, projects }, fmt('en'))
    expect(md).toContain('| Other (3 projects under $1.00) | 3 min | $1.50 |')
    expect(md).not.toContain('| a |')
    expect(weeklyMarkdown({ ...WEEK, projects }, fmt('es'))).toContain('Otros (3 proyectos de menos de')
  })

  it('tells two projects with the same folder name apart by their parent folder', () => {
    const names = projectNames(['/w/acme/api', '/w/other/api', '/w/acme/web'])
    expect([...names.values()]).toEqual(['acme/api', 'other/api', 'web'])
    const md = weeklyMarkdown({ ...WEEK, projects: [{ ...WEEK.projects[0]!, ref: '/w/acme/api' }, { ...WEEK.projects[1]!, ref: '/w/other/api' }] }, fmt('en'))
    expect(md).toContain('| acme/api |')
    expect(md).toContain('| other/api |')
  })
})

describe('session tags', () => {
  it('normalizes and adds tags the way main stores them', () => {
    expect(normalizeTagInput('  Client   A ')).toBe('client a')
    expect(addTags(['spike'], 'Perf, spike,  , New idea')).toEqual(['spike', 'perf', 'new idea'])
  })

  it('stops at the most tags a session keeps, and at the longest tag', () => {
    const full = Array.from({ length: MAX_TAGS - 1 }, (_, i) => `t${i}`)
    expect(addTags(full, 'a, b, c')).toEqual([...full, 'a'])
    expect(normalizeTagInput('x'.repeat(60))).toHaveLength(40)
  })

  it('holds each tag of the field to the longest tag, so a pasted list keeps every tag', () => {
    const long = 'y'.repeat(60)
    const pasted = `alpha, ${'b'.repeat(30)}, gamma, ${long}`
    expect(capTagDraft(pasted)).toBe(`alpha, ${'b'.repeat(30)}, gamma, ${'y'.repeat(MAX_TAG_LENGTH)}`)
    expect(addTags([], capTagDraft(pasted))).toEqual(['alpha', 'b'.repeat(30), 'gamma', 'y'.repeat(MAX_TAG_LENGTH)])
    expect(capTagDraft('x'.repeat(50))).toHaveLength(MAX_TAG_LENGTH)
  })

  it('names refused tags and failed backups in the app language, never with main\'s English text', () => {
    expect(tagsErrorKey(new Error("Error invoking remote method 'analytics:setTags': Error: tags must be a list of strings"))).toBe('tags.error.invalid')
    expect(tagsErrorKey(new Error('a session id is required'))).toBe('tags.error.noSession')
    expect(tagsErrorKey(new Error('SQLITE_BUSY'))).toBe('tags.error.failed')
    expect(backupErrorKey('no backup written')).toBe('storage.backupNotWritten')
    expect(backupErrorKey('ENOSPC: no space left on device, write')).toBe('storage.backupNoSpace')
    expect(backupErrorKey("EACCES: permission denied, open '/x/backups/a.db'")).toBe('storage.backupNoAccess')
    expect(backupErrorKey('database is locked')).toBe('storage.backupFailed')
    expect(translate('es', 'storage.backupFailed')).not.toContain('{error}')
  })

  it('keys a live session by its agent session id, and only once it is known', () => {
    expect(tagsSessionId({ agentSessionId: 'abc' })).toBe('abc')
    // No fallback to the terminal's id: tags saved there would be orphaned once the agent reports its own.
    expect(tagsSessionId({})).toBeNull()
    expect(tagsSessionId({ agentSessionId: 'abc', readOnly: true })).toBeNull()
  })
})

describe('Refresh on Usage', () => {
  it('waits for the scan of new transcripts, and goes on when the call is missing or fails', async () => {
    let done = false
    const hub = { analytics: { spend: vi.fn(), refresh: vi.fn(async () => void (await Promise.resolve(), (done = true))) } }
    await scanNewTranscripts(hub.analytics)
    expect(hub.analytics.refresh).toHaveBeenCalledOnce()
    expect(done).toBe(true)
    await expect(scanNewTranscripts({ spend: vi.fn() })).resolves.toBeUndefined()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(scanNewTranscripts({ refresh: async () => Promise.reject(new Error('busy')) })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('pager', () => {
  const pager = (props: Partial<Parameters<typeof Pager>[0]> = {}) => render(createElement(Pager, { offset: 0, count: 10, total: 57, onPrev: () => undefined, onNext: () => undefined, ...props }))
  const disabled = (html: string, which: 'prev' | 'next') => new RegExp(`<button[^>]*disabled=""[^>]*data-testid="pager-${which}"`).test(html)

  it('counts rows from 1, with no page before the first nor after the last', () => {
    expect(PAGE_SIZE).toBe(10)
    expect(pagerModel({ offset: 0, count: 10, total: 57 })).toEqual({ from: 1, to: 10, hasPrev: false, hasNext: true, single: false })
    expect(pagerModel({ offset: 50, count: 7, total: 57 })).toEqual({ from: 51, to: 57, hasPrev: true, hasNext: false, single: false })
    expect(pagerModel({ offset: 0, count: 7, total: 7 }).single).toBe(true)
    // A cursor API: no total, the next page known by its cursor.
    expect(pagerModel({ offset: 10, count: 10, hasNext: true })).toMatchObject({ from: 11, to: 20, hasPrev: true, hasNext: true })
    expect(pagerModel({ offset: 0, count: 10 }).hasNext).toBe(false)
    // A cursor left over at the very end does not offer an empty page past the total.
    expect(pagerModel({ offset: 50, count: 7, total: 57, hasNext: true }).hasNext).toBe(false)
    expect(pagerModel({ offset: 0, count: 0, total: 0 })).toMatchObject({ from: 0, to: 0, single: true })
  })

  it('slices a page and keeps a page index within the rows', () => {
    const rows = Array.from({ length: 25 }, (_, i) => i)
    expect(pageRows(rows, 0)).toEqual(rows.slice(0, 10))
    expect(pageRows(rows, 2)).toEqual([20, 21, 22, 23, 24])
    expect(clampPage(5, 25)).toBe(2)
    expect(clampPage(-1, 25)).toBe(0)
    expect(clampPage(3, 0)).toBe(0)
  })

  it('reads "1–10 of 57" with Previous disabled on the first page and Next on the last', () => {
    const first = pager()
    expect(first).toContain('1–10 of 57')
    expect(first).toContain('aria-label="Previous page"')
    expect(first).toContain('aria-label="Next page"')
    expect(first).toContain('<nav aria-label="Pages"')
    expect(disabled(first, 'prev')).toBe(true)
    expect(disabled(first, 'next')).toBe(false)
    const last = pager({ offset: 50, count: 7 })
    expect(last).toContain('51–57 of 57')
    expect(disabled(last, 'prev')).toBe(false)
    expect(disabled(last, 'next')).toBe(true)
    // Unknown total: "of more than" while a next page exists, the bare range on the last.
    expect(pager({ offset: 10, total: null, hasNext: true })).toContain('11–20 of more than 20')
    expect(pager({ offset: 10, count: 4, total: null, hasNext: false })).toMatch(/>11–14</)
    // Both wait while a page loads; one page needs no pager.
    const busy = pager({ offset: 10, busy: true })
    expect(disabled(busy, 'prev') && disabled(busy, 'next')).toBe(true)
    expect(busy).toContain('aria-busy="true"')
    expect(pager({ count: 7, total: 7 })).toBe('')
  })

  it('speaks Spanish through the same keys', () => {
    expect(translate('es', 'reports.pager.rangeOf', { from: '11', to: '20', total: '57' })).toBe('11–20 de 57')
    expect(translate('es', 'reports.pager.prev')).toBe('Página anterior')
  })
})

describe('totals table paging', () => {
  const totals = Array.from({ length: 23 }, (_, i) => row(`/w/acme/svc-${String(i).padStart(2, '0')}`, { usd: 100 - i }))
  const table = (page: number, groupBy: 'project' | 'tag' = 'project') =>
    render(
      createElement(ReportTable, {
        rows: totals,
        overall: row(null, { usd: 999, sessions: 23 }),
        groupBy,
        sort: { key: 'usd', desc: true },
        onSort: () => undefined,
        label: (g) => ({ text: g ?? '—' }),
        colors: () => null,
        page
      })
    )

  it('shows ten rows a page with the pager below and the totals row over every group', () => {
    const first = table(0)
    expect(first.match(/data-testid="report-row"/g)).toHaveLength(10)
    expect(first).toContain('svc-00')
    expect(first).not.toContain('svc-10')
    expect(first).toContain('1–10 of 23')
    expect(first).toContain('$999.00')
    const last = table(2)
    expect(last.match(/data-testid="report-row"/g)).toHaveLength(3)
    expect(last).toContain('svc-22')
    expect(last).toContain('21–23 of 23')
    expect(last.indexOf('data-testid="report-table"')).toBeLessThan(last.indexOf('data-testid="report-table-pager"'))
  })

  it('keeps the overlap note under the pager', () => {
    const html = table(1, 'tag')
    expect(html).toContain('11–20 of 23')
    expect(html.indexOf('data-testid="report-table-pager"')).toBeLessThan(html.indexOf('counts in each, so the rows can add up'))
  })

  it('goes back to the first page when the sort changes, and opens on the first page', () => {
    const on3 = tablePageTo(INITIAL_TABLE, 2)
    expect(on3).toEqual({ sort: { key: 'usd', desc: true }, page: 2 })
    expect(tablePageTo(on3, 2)).toBe(on3)
    expect(sortTable(on3, { key: 'group', desc: false })).toEqual({ sort: { key: 'group', desc: false }, page: 0 })
    expect(sortTable(on3, { key: 'usd', desc: false }).page).toBe(0)
    const totalsMany = Array.from({ length: 23 }, (_, i) => row(`/w/acme/svc-${i}`, { usd: i }))
    const html = view({ data: { ...DATA, totals: totalsMany } })
    expect(html).toContain('1–10 of 23')
    expect(html.match(/data-testid="report-row"/g)).toHaveLength(10)
  })
})

describe('sessions paging', () => {
  const session = (n: number): ReportSession => ({ ...DATA.sessions[0]!, id: `s-${n}`, title: `Session ${n}` })
  const pageOf = (start: number, end: number, next: string | null): ReportSessionPage => ({ rows: Array.from({ length: end - start }, (_, i) => session(start + i)), nextCursor: next })
  /** A fake `analytics.sessions` over 25 sessions: the cursor is the offset; replies wait for `release`. */
  const fakeHub = () => {
    const calls: (string | null)[] = []
    const waiting: (() => void)[] = []
    const fetch = (cursor: string | null) => {
      calls.push(cursor)
      const at = cursor ? Number(cursor) : 0
      const end = Math.min(25, at + 10)
      return new Promise<ReportSessionPage>((resolve) => waiting.push(() => resolve(pageOf(at, end, end < 25 ? String(end) : null))))
    }
    const release = async () => {
      waiting.shift()?.()
      await new Promise((r) => setTimeout(r, 0))
    }
    return { calls, fetch, release }
  }

  it('walks forward with each nextCursor and back with the stack of cursors', async () => {
    const hub = fakeHub()
    const seen: number[] = []
    const pager = new SessionPager((v) => !v.loading && seen.push(v.page))
    pager.reset(pageOf(0, 10, '10'))
    let step = pager.next(hub.fetch)
    expect(pager.view.loading).toBe(true)
    await hub.release()
    await step
    expect(pager.view).toMatchObject({ page: 1, nextCursor: '20', loading: false })
    expect(pager.view.rows[0]!.id).toBe('s-10')
    step = pager.next(hub.fetch)
    await hub.release()
    await step
    expect(pager.view).toMatchObject({ page: 2, nextCursor: null })
    expect(pager.view.rows).toHaveLength(5)
    // No page past the last.
    await pager.next(hub.fetch)
    expect(hub.calls).toEqual(['10', '20'])
    step = pager.prev(hub.fetch)
    await hub.release()
    await step
    expect(pager.view).toMatchObject({ page: 1, nextCursor: '20' })
    step = pager.prev(hub.fetch)
    await hub.release()
    await step
    expect(pager.view).toMatchObject({ page: 0, nextCursor: '10' })
    expect(pager.view.rows[0]!.id).toBe('s-0')
    expect(hub.calls).toEqual(['10', '20', '10', null])
    // No page before the first.
    await pager.prev(hub.fetch)
    expect(hub.calls).toHaveLength(4)
    expect(seen).toEqual([0, 1, 2, 1, 0])
  })

  it('ignores a page that arrives after new filters reset the list, and a click while one loads', async () => {
    const hub = fakeHub()
    const pager = new SessionPager()
    pager.reset(pageOf(0, 10, '10'))
    const late = pager.next(hub.fetch)
    // A second click while the page loads asks nothing more.
    await pager.next(hub.fetch)
    expect(hub.calls).toEqual(['10'])
    // New filters: a new first page, the cursor stack dropped.
    pager.reset({ rows: [session(100)], nextCursor: null })
    await hub.release()
    await late
    expect(pager.view).toMatchObject({ page: 0, nextCursor: null, loading: false })
    expect(pager.view.rows.map((r) => r.id)).toEqual(['s-100'])
    // A reload started (cancel) drops the reply too.
    pager.reset(pageOf(0, 10, '10'))
    const dropped = pager.next(hub.fetch)
    pager.cancel()
    expect(pager.view.loading).toBe(false)
    await hub.release()
    await dropped
    expect(pager.view.page).toBe(0)
  })

  it('reads the page on screen again when the same report reloads', async () => {
    const hub = fakeHub()
    const pager = new SessionPager()
    pager.reset(pageOf(0, 10, '10'))
    const step = pager.next(hub.fetch)
    await hub.release()
    await step
    expect(pager.cursor).toBe('10')
    pager.reset(pageOf(10, 20, '20'), 1)
    expect(pager.view.page).toBe(1)
    expect(pager.cursor).toBe('10')
    pager.reset(pageOf(0, 10, '10'))
    expect(pager.cursor).toBeNull()
  })

  it('shows "11–20 of 25" from the tiles\' count, and "of more than" without it', () => {
    const list = (total: number | null, hasNext: boolean, page = 1, rows = pageOf(10, 20, null).rows) =>
      render(createElement(ReportSessions, { sessions: rows, names: {}, page, total, hasNext, onPage: () => undefined, onOpen: () => undefined }))
    const known = list(25, true)
    expect(known.match(/data-testid="report-session"/g)).toHaveLength(10)
    expect(known).toContain('11–20 of 25')
    expect(list(null, true)).toContain('11–20 of more than 20')
    // An emptied later page keeps Previous reachable.
    expect(list(25, false, 2, [])).toContain('data-testid="report-sessions-pager"')
    expect(list(25, false, 0, [])).toContain('No session matches')
  })
})

describe('monthly project budgets card', () => {
  const total = (group: string, usd: number, tokensIn: number): SpendTotals => ({ group, tokensIn, tokensOut: 0, cacheRead: 0, cacheWrite: 0, usd, unpricedTokens: 0, activeMs: 0, turns: 1, sessions: 1 })
  const card = (budgets: ProjectBudgets, month: SpendTotals[]) =>
    render(createElement(ProjectBudgetsCard, { budgets, month, projects: ['/w/acme/notes-api'], now: NOW, onSave: async () => true }))

  it('marks a project ok, warned from 80 % and over from 100 %', () => {
    const html = card({ '/w/acme/ok': { usd: 100 }, '/w/acme/warn': { usd: 100 }, '/w/acme/over': { tokens: 1000 } }, [total('/w/acme/ok', 79, 0), total('/w/acme/warn', 80, 0), total('/w/acme/over', 0, 1500)])
    expect(html.match(/data-state="(ok|warn|over)"/g)).toEqual(['data-state="ok"', 'data-state="warn"', 'data-state="over"'])
    expect(html).toContain('Warning: 80 % reached')
    expect(html).toContain('Over budget')
  })

  it('says the dollars are a lower bound when tokens had no price', () => {
    expect(card({ '/w/acme/a': { usd: 10 } }, [{ ...total('/w/acme/a', 1, 0), unpricedTokens: 5000 }])).toContain('project-budget-unpriced')
  })

  it('folds to one line with a link to set one while there is no budget', () => {
    const html = card({}, [])
    expect(html).toContain('data-folded="true"')
    expect(html).toContain('No budgets')
    expect(html).toContain('data-testid="project-budgets-define"')
    expect(html).not.toContain('project-budget-project')
    expect(card({ '/w/acme/a': { usd: 10 } }, [])).not.toContain('data-folded')
  })
})
