// The pull requests screen's state: both lists, each paged on its own, and the answers of "Load
// more" that still belong to what is on screen (a profile switch or a refresh starts a new
// generation, and an answer of an older one is dropped).
import { isTicketKey, type PullRequestItem } from '@workhub/core'
import type { CodeHostLists } from '../shared/codehost-api'
import type { RemotePage, RemotePullRequestList, RemotePullRequestsPage } from '../shared/remote-api'

export const PR_LISTS: readonly RemotePullRequestList[] = ['mine', 'toReview']

export interface PrListState {
  items: PullRequestItem[]
  cursor: string | null
  loading: boolean
}

export interface PrPagesState {
  /** Which first page this state grew from; "Load more" answers of another one are dropped. */
  generation: number
  lists: RemotePullRequestsPage['lists']
  counts: Record<RemotePullRequestList, number>
  mine: PrListState
  toReview: PrListState
}

/** Rows each once, by link (a row can come again when the list moved between pages). */
function addRows(have: readonly PullRequestItem[], rows: readonly PullRequestItem[]): PullRequestItem[] {
  const seen = new Set(have.map((i) => i.pr.url))
  const out = [...have]
  for (const row of rows) {
    if (seen.has(row.pr.url)) continue
    seen.add(row.pr.url)
    out.push(row)
  }
  return out
}

/** The state of a first answer: a paged one, or both lists whole from a desktop that does not page (or its cached answer). */
export function prStateFrom(data: RemotePullRequestsPage | CodeHostLists, generation: number): PrPagesState {
  if ('counts' in data && data.counts) {
    const page = data as RemotePullRequestsPage
    const list = (p: RemotePage<PullRequestItem> | undefined): PrListState => ({ items: addRows([], p?.items ?? []), cursor: p?.nextCursor ?? null, loading: false })
    return { generation, lists: page.lists ?? { state: 'ready' }, counts: page.counts, mine: list(page.mine), toReview: list(page.toReview) }
  }
  const { mine = [], toReview = [], ...lists } = data as CodeHostLists
  const whole = (items: PullRequestItem[]): PrListState => ({ items: addRows([], items), cursor: null, loading: false })
  return { generation, lists, counts: { mine: mine.length, toReview: toReview.length }, mine: whole(mine), toReview: whole(toReview) }
}

/** A "Load more" of `list` went out for `generation`. */
export function prLoading(state: PrPagesState, list: RemotePullRequestList, generation: number): PrPagesState {
  if (state.generation !== generation) return state
  return { ...state, [list]: { ...state[list], loading: true } }
}

/** Its answer: the next rows of `list` and where the one after starts. Dropped when the screen moved on. */
export function prLoaded(state: PrPagesState, list: RemotePullRequestList, generation: number, answer: RemotePullRequestsPage): PrPagesState {
  if (state.generation !== generation) return state
  const page = answer[list]
  return {
    ...state,
    counts: answer.counts ?? state.counts,
    [list]: { items: addRows(state[list].items, page?.items ?? []), cursor: page?.nextCursor ?? null, loading: false }
  }
}

/** It failed (offline, refused): the row stays, to try again. */
export function prFailed(state: PrPagesState, list: RemotePullRequestList, generation: number): PrPagesState {
  if (state.generation !== generation) return state
  return { ...state, [list]: { ...state[list], loading: false } }
}

/**
 * What the screen shows before the desktop answers: the cached first page, else (a phone that
 * cached the lists before the desktop paged them) the cached whole lists.
 */
export function cachedPullRequests(cached: <T>(channel: string, args: unknown[]) => T | null, profileId: string | null, firstArgs: unknown[]): RemotePullRequestsPage | CodeHostLists | null {
  return cached<RemotePullRequestsPage>('remote:pullRequests', firstArgs) ?? cached<CodeHostLists>('codeHost:lists', [profileId])
}

/**
 * The ticket key a title starts with ("ABC-123 Fix the cart", "[ABC-123] Fix", "ABC-123: Fix"); core
 * then decides whether it is a key (not "UTF-8", "HTTP-2"...). The phone is not told the profile's
 * project keys (the config it receives has no connections), so core's exclusions are what it has.
 */
const TICKET_PREFIX = /^\s*\[?([A-Z][A-Z0-9]{1,9}-\d+)\]?\s*[:\-–]?\s+(?=\S)/
/** A draft marker a title carries ("Draft: ...", "[Draft] ...", "WIP: ..."); the row's chip says it already. */
const DRAFT_PREFIX = /^\s*(?:\[(?:draft|wip)\]|(?:draft|wip)\s*:)\s*/i

/**
 * What a row shows of a title: the ticket key apart (it goes in the meta line) and the rest, so the
 * line the title owns starts with what tells two pull requests apart. A draft's own marker is dropped.
 */
export function prTitleParts(title: string, isDraft: boolean): { key: string | null; title: string } {
  let rest = title
  if (isDraft) rest = rest.replace(DRAFT_PREFIX, '')
  const m = TICKET_PREFIX.exec(rest)
  if (!m || !isTicketKey(m[1]!, { provider: 'jira' })) return { key: null, title: rest.trim() || title }
  return { key: m[1]!, title: rest.slice(m[0].length).trim() }
}
