/**
 * The Merged view's model: target-branch groups, local-day periods (and the previous one), buckets by
 * day or Monday week, totals with "not reported" handling, the rows of the two tables, and the view's
 * own filters. Pure functions: the screen and the tests share them. All dates are local.
 */
import type { MergedPullRequest, PullRequest } from '@workhub/core'

// ---- target groups -------------------------------------------------------------------------------

export const BRANCH_GROUPS = ['main', 'master', 'release', 'develop', 'other'] as const
export type BranchGroup = (typeof BRANCH_GROUPS)[number]

/** Series slots of the Usage palette (`--wh-series-N`); 0 is the neutral gray. A group keeps its slot whatever is filtered. */
export const GROUP_SLOT: Record<BranchGroup, number> = { main: 1, master: 4, release: 3, develop: 2, other: 0 }

/** The message of each group's name (`other` is `rest`: a key ending in `.other` would read as a plural form). */
export const GROUP_LABEL = {
  main: 'pr.merged.group.main',
  master: 'pr.merged.group.master',
  release: 'pr.merged.group.release',
  develop: 'pr.merged.group.develop',
  other: 'pr.merged.group.rest'
} as const satisfies Record<BranchGroup, string>

/** `main`, `master`, `develop` (also `dev`, `development`), `release/*` and `release-*`; anything else is "other". */
export function groupOf(base: string): BranchGroup {
  if (base === 'main') return 'main'
  if (base === 'master') return 'master'
  if (base === 'develop' || base === 'dev' || base === 'development') return 'develop'
  if (base.startsWith('release/') || base.startsWith('release-')) return 'release'
  return 'other'
}

// ---- local dates ---------------------------------------------------------------------------------

/** Local midnight of the day holding `ms`. */
export function dayStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** `n` local calendar days later (or earlier), at the same local time: never a multiple of 24 hours. */
export function addDays(ms: number, n: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

/** Local calendar days in `[since, until)`, counted day by day so a 23 or 25 hour day is still one. */
export function countDays(since: number, until: number): number {
  let n = 0
  for (let t = since; t < until && n < 4000; t = addDays(t, 1)) n++
  return n
}

/** The Monday (local midnight) of the week holding `ms`, as Usage's weeks. */
export function mondayOf(ms: number): number {
  const s = dayStart(ms)
  return addDays(s, -((new Date(s).getDay() + 6) % 7))
}

export interface Period {
  /** Local midnight of the first day. */
  since: number
  /** Local midnight after the last day (excluded). */
  until: number
}

export const PRESET_DAYS = [7, 30, 90] as const
/** The longest custom range. */
export const MAX_CUSTOM_DAYS = 366

/** The last `days` local days, today included. */
export function presetPeriod(days: number, now: number): Period {
  const until = addDays(dayStart(now), 1)
  return { since: addDays(until, -days), until }
}

export type CustomRangeError = 'incomplete' | 'order' | 'tooLong'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** `yyyy-mm-dd` as local midnight; null when it is not a real date. */
export function parseLocalDate(value: string): number | null {
  const m = DATE_RE.exec(value)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date.getTime() : null
}

/** `yyyy-mm-dd` of a local day. */
export function localDateValue(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A custom range: both days included (`until` is the midnight after `to`), at most a year. */
export function customPeriod(from: string, to: string): { period: Period } | { error: CustomRangeError } {
  const a = parseLocalDate(from)
  const b = parseLocalDate(to)
  if (a === null || b === null) return { error: 'incomplete' }
  if (b < a) return { error: 'order' }
  const period = { since: a, until: addDays(b, 1) }
  return countDays(period.since, period.until) > MAX_CUSTOM_DAYS ? { error: 'tooLong' } : { period }
}

/** The start of the previous period: as many local calendar days before `since` as the period has. */
export function previousSince(p: Period): number {
  return addDays(p.since, -countDays(p.since, p.until))
}

/** Splits one read that covers the previous period and the current one. */
export function splitPeriods(items: readonly MergedPullRequest[], p: Period): { current: MergedPullRequest[]; previous: MergedPullRequest[] } {
  const prev = previousSince(p)
  return {
    current: items.filter((i) => i.mergedAt >= p.since && i.mergedAt < p.until),
    previous: items.filter((i) => i.mergedAt >= prev && i.mergedAt < p.since)
  }
}

// ---- buckets -------------------------------------------------------------------------------------

export type Granularity = 'day' | 'week'

/** 90 days and custom ranges over 45 days start in weeks. */
export function defaultGranularity(days: number): Granularity {
  return days > 45 ? 'week' : 'day'
}

export function bucketStartOf(ms: number, g: Granularity): number {
  return g === 'day' ? dayStart(ms) : mondayOf(ms)
}

/** Every bucket of the period, oldest first (the first week starts on the Monday on or before `since`). */
export function bucketStarts(p: Period, g: Granularity): number[] {
  const out: number[] = []
  const step = g === 'day' ? 1 : 7
  for (let t = bucketStartOf(p.since, g); t < p.until && out.length < 4000; t = addDays(t, step)) out.push(t)
  return out
}

/** The first and last day a bucket covers inside the period. */
export function bucketRange(start: number, g: Granularity, p: Period): { from: number; to: number } {
  const lastDay = addDays(p.until, -1)
  const end = g === 'day' ? start : addDays(start, 6)
  return { from: Math.max(start, p.since), to: Math.min(end, lastDay) }
}

/** The groups the items reach, in the fixed order (so the legend and the stacking never reshuffle). */
export function presentGroups(items: readonly MergedPullRequest[]): BranchGroup[] {
  const seen = new Set(items.map((i) => groupOf(i.base)))
  return BRANCH_GROUPS.filter((g) => seen.has(g))
}

export interface MergedBucket {
  start: number
  /** One count per group given, in that order. */
  values: number[]
  total: number
  additions: number
  deletions: number
}

export function bucketItems(items: readonly MergedPullRequest[], groups: readonly BranchGroup[], p: Period, g: Granularity): MergedBucket[] {
  const starts = bucketStarts(p, g)
  const byStart = new Map(starts.map((start) => [start, { start, values: new Array<number>(groups.length).fill(0), total: 0, additions: 0, deletions: 0 }]))
  for (const i of items) {
    const b = byStart.get(bucketStartOf(i.mergedAt, g))
    const idx = groups.indexOf(groupOf(i.base))
    if (!b || idx < 0) continue
    b.values[idx]!++
    b.total++
    b.additions += i.additions ?? 0
    b.deletions += i.deletions ?? 0
  }
  return starts.map((s) => byStart.get(s)!)
}

// ---- totals --------------------------------------------------------------------------------------

export const DAY_MS = 86_400_000

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Days from opening to merge; null when the host did not say when it was opened. */
export function leadDays(i: MergedPullRequest): number | null {
  return i.createdAt !== undefined && i.mergedAt >= i.createdAt ? (i.mergedAt - i.createdAt) / DAY_MS : null
}

export interface Totals {
  count: number
  additions: number
  deletions: number
  /** Items that reported their lines / files: undefined means not reported, not zero. */
  withLines: number
  files: number
  withFiles: number
  leadMedianDays: number | null
  leadMaxDays: number | null
}

export function totalsOf(items: readonly MergedPullRequest[]): Totals {
  let additions = 0
  let deletions = 0
  let withLines = 0
  let files = 0
  let withFiles = 0
  const leads: number[] = []
  for (const i of items) {
    if (i.additions !== undefined || i.deletions !== undefined) {
      withLines++
      additions += i.additions ?? 0
      deletions += i.deletions ?? 0
    }
    if (i.changedFiles !== undefined) {
      withFiles++
      files += i.changedFiles
    }
    const lead = leadDays(i)
    if (lead !== null) leads.push(lead)
  }
  return { count: items.length, additions, deletions, withLines, files, withFiles, leadMedianDays: medianOf(leads), leadMaxDays: leads.length ? Math.max(...leads) : null }
}

/** How a sum reads: no item reported it, only some did (the sums cover those), or all did. */
export function coverage(count: number, reported: number): 'none' | 'partial' | 'all' {
  return count === 0 || reported === count ? 'all' : reported === 0 ? 'none' : 'partial'
}

/** Average per item that reported the figure; null when none did. */
export function averagePer(sum: number, reported: number): number | null {
  return reported > 0 ? sum / reported : null
}

/** This period's count minus the previous one's; null when the search was cut (the previous period is then undercounted). */
export function deltaVsPrevious(current: number, previous: number, truncated: boolean): number | null {
  return truncated ? null : current - previous
}

// ---- tables --------------------------------------------------------------------------------------

export interface BranchRow {
  /** A group key, or a release branch name under it. */
  key: string
  group: BranchGroup
  /** The branch name for a child row. */
  branch?: string
  count: number
  additions: number
  deletions: number
  withLines: number
  files: number
  withFiles: number
}

const emptyRow = (key: string, group: BranchGroup, branch?: string): BranchRow => ({ key, group, ...(branch ? { branch } : {}), count: 0, additions: 0, deletions: 0, withLines: 0, files: 0, withFiles: 0 })

function addTo(row: BranchRow, i: MergedPullRequest): void {
  row.count++
  if (i.additions !== undefined || i.deletions !== undefined) {
    row.withLines++
    row.additions += i.additions ?? 0
    row.deletions += i.deletions ?? 0
  }
  if (i.changedFiles !== undefined) {
    row.withFiles++
    row.files += i.changedFiles
  }
}

/** One row per group present (fixed order); with more than one release branch, each is its own row right after `release`. */
export function byBranch(items: readonly MergedPullRequest[]): BranchRow[] {
  const groups = new Map<BranchGroup, BranchRow>()
  const releases = new Map<string, BranchRow>()
  for (const i of items) {
    const g = groupOf(i.base)
    let row = groups.get(g)
    if (!row) groups.set(g, (row = emptyRow(g, g)))
    addTo(row, i)
    if (g === 'release') {
      let child = releases.get(i.base)
      if (!child) releases.set(i.base, (child = emptyRow(`release:${i.base}`, g, i.base)))
      addTo(child, i)
    }
  }
  const out: BranchRow[] = []
  for (const g of BRANCH_GROUPS) {
    const row = groups.get(g)
    if (!row) continue
    out.push(row)
    if (g === 'release' && releases.size > 1) out.push(...[...releases.values()].sort((a, b) => b.count - a.count || a.branch!.localeCompare(b.branch!)))
  }
  return out
}

export interface RepoRow {
  /** `owner/repo`. */
  key: string
  count: number
  additions: number
  deletions: number
  withLines: number
  leadMedianDays: number | null
}

export const repoKey = (i: Pick<MergedPullRequest, 'owner' | 'repo'>): string => `${i.owner}/${i.repo}`

/** One row per repository, most merged first. */
export function byRepo(items: readonly MergedPullRequest[]): RepoRow[] {
  const map = new Map<string, { row: RepoRow; leads: number[] }>()
  for (const i of items) {
    const key = repoKey(i)
    let e = map.get(key)
    if (!e) map.set(key, (e = { row: { key, count: 0, additions: 0, deletions: 0, withLines: 0, leadMedianDays: null }, leads: [] }))
    e.row.count++
    if (i.additions !== undefined || i.deletions !== undefined) {
      e.row.withLines++
      e.row.additions += i.additions ?? 0
      e.row.deletions += i.deletions ?? 0
    }
    const lead = leadDays(i)
    if (lead !== null) e.leads.push(lead)
  }
  return [...map.values()].map((e) => ({ ...e.row, leadMedianDays: medianOf(e.leads) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

// ---- filters -------------------------------------------------------------------------------------

export type MergedOrder = 'newest' | 'oldest' | 'repo'
export const MERGED_ORDERS: readonly MergedOrder[] = ['newest', 'oldest', 'repo']
export type MergedField = 'into' | 'repos' | 'authors'

/** The `release/*` choice of the Into filter: every release branch, present and future. */
export const RELEASE_ALL = 'release/*'

export interface MergedNarrowing {
  /** Target branch names, each on its own, and `RELEASE_ALL`. */
  into: string[]
  /** `owner/repo`. */
  repos: string[]
  authors: string[]
  order: MergedOrder
}

export const NO_MERGED_NARROWING: MergedNarrowing = { into: [], repos: [], authors: [], order: 'newest' }

export function mergedNarrowingCount(n: MergedNarrowing): number {
  return n.into.length + n.repos.length + n.authors.length
}

export const isMergedNarrowed = (n: MergedNarrowing): boolean => mergedNarrowingCount(n) > 0

/** Clears the filters and keeps the order. */
export function clearMergedNarrowing(n: MergedNarrowing): MergedNarrowing {
  return { ...NO_MERGED_NARROWING, order: n.order }
}

/** Whether the Into filter keeps a base branch. */
export function intoKeeps(into: readonly string[], base: string): boolean {
  return into.length === 0 || into.includes(base) || (into.includes(RELEASE_ALL) && groupOf(base) === 'release')
}

function fieldKeeps(n: MergedNarrowing, field: MergedField, i: MergedPullRequest): boolean {
  switch (field) {
    case 'into':
      return intoKeeps(n.into, i.base)
    case 'repos':
      return n.repos.length === 0 || n.repos.includes(repoKey(i))
    case 'authors':
      return n.authors.length === 0 || n.authors.includes(i.author)
  }
}

const FIELDS: readonly MergedField[] = ['into', 'repos', 'authors']

/** Title, author, head and base branch, and `repo#number`. */
export function searchMerged(items: readonly MergedPullRequest[], query: string): MergedPullRequest[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((i) => [i.title, i.author, i.branch, i.base, `${i.repo}#${i.number}`].some((s) => s.toLowerCase().includes(q)))
}

/** The items the filters keep (`skip`: leave one field out, to count its options), in the narrowing's order. */
export function applyMergedNarrowing(items: readonly MergedPullRequest[], n: MergedNarrowing, skip?: MergedField): MergedPullRequest[] {
  const kept = items.filter((i) => FIELDS.every((f) => f === skip || fieldKeeps(n, f, i)))
  switch (n.order) {
    case 'newest':
      return kept.sort((a, b) => b.mergedAt - a.mergedAt)
    case 'oldest':
      return kept.sort((a, b) => a.mergedAt - b.mergedAt)
    case 'repo':
      return kept.sort((a, b) => repoKey(a).localeCompare(repoKey(b)) || b.mergedAt - a.mergedAt)
  }
}

export interface MergedOption {
  value: string
  count: number
}

function countBy(items: readonly MergedPullRequest[], valueOf: (i: MergedPullRequest) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const i of items) counts.set(valueOf(i), (counts.get(valueOf(i)) ?? 0) + 1)
  return counts
}

/** Options of Repo or Author, counted with the other filters applied; a picked value the list no longer has stays (count 0). Most common first. */
export function mergedOptions(items: readonly MergedPullRequest[], n: MergedNarrowing, field: 'repos' | 'authors'): MergedOption[] {
  const counts = countBy(applyMergedNarrowing(items, n, field), field === 'repos' ? repoKey : (i) => i.author)
  for (const v of n[field]) if (!counts.has(v)) counts.set(v, 0)
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

export interface IntoOption {
  /** A branch name, or `RELEASE_ALL`. */
  value: string
  group: BranchGroup
  count: number
  /** Release branches are indented under `release/*`. */
  child: boolean
}

/** Every target branch on its own, in group order, with `release/*` ahead of the release branches. */
export function intoOptions(items: readonly MergedPullRequest[], n: MergedNarrowing): IntoOption[] {
  const pool = applyMergedNarrowing(items, n, 'into')
  const counts = countBy(pool, (i) => i.base)
  const bases = new Set([...countBy(items, (i) => i.base).keys(), ...n.into.filter((v) => v !== RELEASE_ALL)])
  const out: IntoOption[] = []
  for (const g of BRANCH_GROUPS) {
    const names = [...bases].filter((b) => groupOf(b) === g).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
    if (g === 'release' && names.length > 0) out.push({ value: RELEASE_ALL, group: g, count: pool.filter((i) => groupOf(i.base) === 'release').length, child: false })
    for (const b of names) out.push({ value: b, group: g, count: counts.get(b) ?? 0, child: g === 'release' })
  }
  return out
}

/** The state of the `release/*` choice: all release branches in the filter, only some, or none. */
export function releaseSelection(into: readonly string[], releaseBranches: readonly string[]): 'all' | 'some' | 'none' {
  if (into.includes(RELEASE_ALL)) return 'all'
  const picked = releaseBranches.filter((b) => into.includes(b)).length
  return picked === 0 ? 'none' : picked === releaseBranches.length ? 'all' : 'some'
}

/** Whether an Into option is on: itself, or through `release/*`. */
export function intoIsOn(into: readonly string[], base: string): boolean {
  return into.includes(base) || (into.includes(RELEASE_ALL) && groupOf(base) === 'release')
}

/** Turns an Into choice on or off. `release/*` selects (or, when all are on, clears) every release branch. */
export function toggleInto(n: MergedNarrowing, value: string, releaseBranches: readonly string[]): MergedNarrowing {
  const without = (drop: readonly string[]) => n.into.filter((v) => !drop.includes(v))
  if (value === RELEASE_ALL) {
    const all = releaseSelection(n.into, releaseBranches) === 'all'
    return { ...n, into: all ? without([RELEASE_ALL, ...releaseBranches]) : [...without(releaseBranches), RELEASE_ALL] }
  }
  // A release branch turned off while `release/*` is on: the others stay as themselves.
  if (n.into.includes(RELEASE_ALL) && groupOf(value) === 'release') {
    return { ...n, into: [...without([RELEASE_ALL]), ...releaseBranches.filter((b) => b !== value && !n.into.includes(b))] }
  }
  return { ...n, into: n.into.includes(value) ? without([value]) : [...n.into, value] }
}

export function toggleMergedValue(n: MergedNarrowing, field: 'repos' | 'authors', value: string): MergedNarrowing {
  return { ...n, [field]: n[field].includes(value) ? n[field].filter((v) => v !== value) : [...n[field], value] }
}

// ---- list ----------------------------------------------------------------------------------------

export interface DayGroup {
  /** Local midnight. */
  start: number
  items: MergedPullRequest[]
}

/** Consecutive items of the same local day (for the list's sticky headers; items already in order). */
export function groupByDay(items: readonly MergedPullRequest[]): DayGroup[] {
  const out: DayGroup[] = []
  for (const i of items) {
    const start = dayStart(i.mergedAt)
    const last = out.at(-1)
    if (last && last.start === start) last.items.push(i)
    else out.push({ start, items: [i] })
  }
  return out
}

/** A selection survives only while its PR is in the (filtered) list; null otherwise, which shows the summary. */
export function keepSelection(url: string | null, shown: readonly MergedPullRequest[]): string | null {
  return url !== null && shown.some((i) => i.url === url) ? url : null
}

/** What the detail panel's header shows while the full view loads: the merged row as a (merged) pull request. */
export function mergedSeed(m: MergedPullRequest): PullRequest {
  return { ...m, state: 'merged', isDraft: false, reviewDecision: 'none', ci: 'none', mergeable: 'unknown', additions: m.additions ?? 0, deletions: m.deletions ?? 0, changedFiles: m.changedFiles ?? 0, updatedAt: m.mergedAt }
}

/** The first `limit` rows across the day groups, each group keeping its full count for its header; groups past the limit are left out. */
export function firstRows<T>(groups: readonly { start: number; items: readonly T[] }[], limit: number): { start: number; items: readonly T[]; total: number }[] {
  const out: { start: number; items: readonly T[]; total: number }[] = []
  let left = limit
  for (const g of groups) {
    if (left <= 0) break
    out.push({ start: g.start, items: g.items.slice(0, left), total: g.items.length })
    left -= g.items.length
  }
  return out
}
