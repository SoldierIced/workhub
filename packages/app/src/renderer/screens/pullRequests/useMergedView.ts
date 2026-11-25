import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MergedPullRequest } from '@workhub/core'
import type { MergedScope, MergedRequest, MergedSync } from '@shared/codehost-api'
import {
  addDays,
  applyMergedNarrowing,
  clearMergedNarrowing,
  countDays,
  customPeriod,
  defaultGranularity,
  keepSelection,
  localDateValue,
  NO_MERGED_NARROWING,
  presetPeriod,
  previousSince,
  searchMerged,
  splitPeriods,
  type CustomRangeError,
  type Granularity,
  type MergedNarrowing,
  type Period
} from '../../lib/mergedStats'
import { useConfig } from '../../configStore'
import { peekMerged, useMerged } from '../../mergedStore'

export type PeriodChoice = 7 | 30 | 90 | 'custom'
export type Who = 'all' | 'mine'
export type Profiles = 'this' | 'all'
export type Display = 'chart' | 'table'

interface Ui {
  profileId: string | null
  period: PeriodChoice
  from: string
  to: string
  who: Who
  /** Whose saved merges: this profile's or every profile's. */
  profiles: Profiles
  gran: Granularity | null
  display: Display
  narrowing: MergedNarrowing
  selectedUrl: string | null
  /** Everyone has no scope in this profile: Mine is used. */
  noScope: boolean
  /** The day the period was computed on; a new day does not reread by itself. */
  anchor: number
}

const fresh = (profileId: string | null): Ui => {
  const now = Date.now()
  return { profileId, period: 30, from: localDateValue(addDays(now, -29)), to: localDateValue(now), who: 'all', profiles: 'this', gran: null, display: 'chart', narrowing: NO_MERGED_NARROWING, selectedUrl: null, noScope: false, anchor: now }
}

/** The merges whose author is one of `logins` (lowercase, as the read reports them): Mine taken from Everyone. */
export function mergedByLogins(items: readonly MergedPullRequest[], logins: readonly string[]): MergedPullRequest[] {
  return items.filter((p) => logins.includes(p.author.toLowerCase()))
}

/** How many profiles have a code host connection (the config lists it and it exists). */
export function countCodeHostProfiles(config: { profiles: readonly { connections: { codeHost?: string } }[]; connections: readonly { id: string; kind: string }[] } | undefined): number {
  if (!config) return 0
  return config.profiles.filter((p) => config.connections.some((c) => c.id === p.connections.codeHost && c.kind === 'codeHost')).length
}

export interface MergedView {
  ui: Ui
  period: Period | null
  rangeError: CustomRangeError | null
  /** Whether the period's rows are mine only (chosen, or the profile has no scope). */
  mine: boolean
  gran: Granularity
  /** The control for This profile / All profiles shows: more than one profile has a code host connection. */
  canChooseProfiles: boolean
  /** The items come from every profile. */
  allProfiles: boolean
  /** How many profiles the items come from (with all profiles). */
  profileCount: number | null
  /** How the read went against the host; absent counts as synced. */
  sync: MergedSync
  /** Part of the period was not read yet. */
  partial: boolean
  days: number
  provider: string | null
  scope: MergedScope | null
  demo: boolean
  truncated: boolean
  fetchedAt: number | null
  /** Rows read for the whole request (both periods). */
  readCount: number
  loading: boolean
  failure: { state: string; error: string; retryAt?: number } | null
  hasData: boolean
  /** The current period before search and filters. */
  current: MergedPullRequest[]
  /** The current period after the search, before the filters (what the filter panel counts). */
  searched: MergedPullRequest[]
  /** What the search and the filters keep, in the list's order. */
  visible: MergedPullRequest[]
  /** The previous period with the same search and filters. */
  previous: MergedPullRequest[]
  selected: MergedPullRequest | null
  setPeriod: (p: PeriodChoice) => void
  setCustom: (from: string, to: string) => void
  setWho: (w: Who) => void
  setProfiles: (p: Profiles) => void
  setGran: (g: Granularity) => void
  setDisplay: (d: Display) => void
  setNarrowing: (n: MergedNarrowing) => void
  clearFilters: () => void
  select: (url: string | null) => void
  refresh: () => Promise<void>
}

/**
 * The Merged view's state and what it derives: the request (period plus the previous one, local days), the
 * read (kept per profile and request, last good on error), and the rows after search and filters.
 * `requested`: the tab was opened at least once (nothing is read before); `open`: it is on screen now.
 */
export function useMergedView(profileId: string | null, requested: boolean, open: boolean, query: string): MergedView {
  const [ui, setUi] = useState<Ui>(() => fresh(profileId))
  // A profile change starts the view over (filters, period, selection).
  if (ui.profileId !== profileId) setUi(fresh(profileId))
  const patch = useCallback((p: Partial<Ui>) => setUi((u) => ({ ...u, ...p })), [])

  const custom = useMemo(() => (ui.period === 'custom' ? customPeriod(ui.from, ui.to) : null), [ui.period, ui.from, ui.to])
  // Shown on another local day, a preset period already ends today (no read of the old one first); the effect below stores it.
  const today = localDateValue(Date.now())
  const anchor = open && ui.period !== 'custom' && localDateValue(ui.anchor) !== today ? Date.now() : ui.anchor
  const anchorDay = localDateValue(anchor)
  const period = useMemo<Period | null>(() => {
    if (ui.period !== 'custom') return presetPeriod(ui.period, anchor)
    return custom && 'period' in custom ? custom.period : null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the period depends on the anchor's day, not its time
  }, [ui.period, anchorDay, custom])
  const rangeError = custom && 'error' in custom ? custom.error : null
  const mine = ui.who === 'mine' || ui.noScope
  const config = useConfig()
  const canChooseProfiles = countCodeHostProfiles(config?.config) > 1
  // The choice only counts while the control shows (a profile lost its connection meanwhile: back to this profile).
  const allProfiles = canChooseProfiles && ui.profiles === 'all'

  const ownRequest = useMemo<MergedRequest | null>(() => (requested && period ? { since: previousSince(period), until: period.until, mine, ...(allProfiles ? { allProfiles: true } : {}) } : null), [requested, period, mine, allProfiles])
  const everyoneRequest = useMemo<MergedRequest | null>(() => (requested && period && !ui.noScope ? { since: previousSince(period), until: period.until, mine: false, ...(allProfiles ? { allProfiles: true } : {}) } : null), [requested, period, ui.noScope, allProfiles])
  // Mine, once Everyone of the same period was read, is Everyone's merges by the signed-in login(s): shown at once, with no read of its own.
  const everyoneLogins = ui.who === 'mine' && everyoneRequest ? peekMerged(profileId, everyoneRequest).data?.logins : undefined
  const fromEveryone = everyoneLogins !== undefined && everyoneLogins.length > 0
  const request = fromEveryone ? everyoneRequest : ownRequest
  const entry = useMerged(profileId, request, open)

  // The read says when Everyone has nothing to search in: remember it and use Mine. Any read that reports a
  // scope (the user set repositories meanwhile; a Mine read also reports it) gives Everyone back.
  const readSaysNoScope = entry.failure?.state === 'noScope' || entry.data?.scope.kind === 'none'
  const readHasScope = entry.data !== null && entry.data.scope.kind !== 'none' && entry.failure?.state !== 'noScope'
  useEffect(() => {
    if (readSaysNoScope && !ui.noScope) patch({ noScope: true })
    else if (readHasScope && ui.noScope) patch({ noScope: false })
  }, [readSaysNoScope, readHasScope, ui.noScope, patch])

  // A preset period ends today: coming back to the tab on another day moves it (and so reads the new period).
  const presetDay = ui.period !== 'custom' ? localDateValue(ui.anchor) : null
  useEffect(() => {
    if (open && presetDay !== null && presetDay !== localDateValue(Date.now())) patch({ anchor: Date.now() })
  }, [open, presetDay, patch])

  const read = entry.data?.items
  const items = useMemo(() => (read && fromEveryone ? mergedByLogins(read, everyoneLogins!) : read), [read, fromEveryone, everyoneLogins])
  const parts = useMemo(() => {
    if (!items || !period) return { current: [], previous: [] }
    return splitPeriods(items, period)
  }, [items, period])
  const searchedNow = useMemo(() => searchMerged(parts.current, query), [parts.current, query])
  const visible = useMemo(() => applyMergedNarrowing(searchedNow, ui.narrowing), [searchedNow, ui.narrowing])
  const previous = useMemo(() => applyMergedNarrowing(searchMerged(parts.previous, query), ui.narrowing), [parts.previous, query, ui.narrowing])
  const selectedUrl = keepSelection(ui.selectedUrl, visible)
  const selected = selectedUrl ? (visible.find((i) => i.url === selectedUrl) ?? null) : null

  const days = period ? countDays(period.since, period.until) : 30
  const gran = ui.gran ?? defaultGranularity(days)

  return {
    ui,
    period,
    rangeError,
    mine,
    gran,
    canChooseProfiles,
    allProfiles,
    profileCount: allProfiles ? (entry.data?.profiles ?? null) : null,
    sync: entry.data?.sync ?? { state: 'synced' },
    partial: entry.data?.partial === true,
    days,
    provider: entry.data?.provider ?? null,
    scope: entry.data?.scope ?? null,
    demo: entry.data?.demo === true,
    truncated: entry.data?.truncated === true,
    fetchedAt: entry.data?.fetchedAt ?? null,
    readCount: items?.length ?? 0,
    loading: entry.loading,
    failure: entry.failure,
    hasData: entry.data !== null,
    current: parts.current,
    searched: searchedNow,
    visible,
    previous,
    selected,
    setPeriod: (p) => patch({ period: p, gran: null, anchor: Date.now(), selectedUrl: null }),
    setCustom: (from, to) => patch({ period: 'custom', from, to, gran: null, anchor: Date.now(), selectedUrl: null }),
    setWho: (w) => patch({ who: w, selectedUrl: null }),
    setProfiles: (p) => patch({ profiles: p, selectedUrl: null }),
    setGran: (g) => patch({ gran: g }),
    setDisplay: (d) => patch({ display: d }),
    setNarrowing: (n) => patch({ narrowing: n }),
    clearFilters: () => setUi((u) => ({ ...u, narrowing: clearMergedNarrowing(u.narrowing) })),
    select: (url) => patch({ selectedUrl: url }),
    refresh: async () => {
      // On another day the period moves, and the new request reads by itself; otherwise read this one again.
      if (presetDay !== null && presetDay !== localDateValue(Date.now())) patch({ anchor: Date.now() })
      else await entry.refresh()
    }
  }
}
