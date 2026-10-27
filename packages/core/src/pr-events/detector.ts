import type { PullRequest } from '../codehost/domain'
import type { PrEvent, PrEventKind, PrProfileState, PrSnapshot } from './types'

/** How many handled ids are remembered per profile. */
export const SEEN_LIMIT = 2000
/** Syncs a vanished PR whose state cannot be read is kept before it is forgotten. */
export const MISS_LIMIT = 5

const nameOf = (pr: Pick<PullRequest, 'repo' | 'number'>) => `${pr.repo}#${pr.number}`
const slugOf = (pr: Pick<PullRequest, 'owner' | 'repo' | 'number'>) => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase()

export function snapshotOf(pr: PullRequest): PrSnapshot {
  return {
    url: pr.url,
    title: pr.title,
    name: nameOf(pr),
    decision: pr.reviewDecision,
    ci: pr.ci,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {}),
    ...(pr.commentCount !== undefined ? { commentCount: pr.commentCount } : {})
  }
}

export interface DetectInput {
  /** Undefined on the first sync of a profile (or after an upgrade that had no memory): everything is only remembered. */
  previous: PrProfileState | undefined
  /** My open PRs; undefined when the list could not be read, so its memory is kept as it was. */
  mine: PullRequest[] | undefined
  /** PRs waiting for my review; undefined when the list could not be read. */
  toReview: PullRequest[] | undefined
  /**
   * The PRs of mine that left the open list, as read again by URL (merged or closed). A URL
   * missing here means its state could not be read.
   */
  left: Record<string, PullRequest>
  now: number
}

export interface DetectResult {
  events: PrEvent[]
  state: PrProfileState
}

/**
 * Compares two syncs of one profile. The first sync only seeds the memory, so an upgrade or a new
 * profile never reports the current state as new. A field the host does not report (or an old
 * memory lacks) is seeded the same way instead of being read as a change. Events already handled
 * (same id) are dropped, so each one is reported once per profile.
 */
export function detectPrEvents({ previous, mine, toReview, left, now }: DetectInput): DetectResult {
  const first = previous === undefined
  const before: PrProfileState = previous ?? { mine: {}, seen: [] }
  const found: PrEvent[] = []
  const event = (kind: PrEventKind, pr: Pick<PullRequest, 'owner' | 'repo' | 'number'> & { url: string; title: string }, id: string, extra: Partial<PrEvent> = {}) =>
    found.push({ id: `${slugOf(pr)}|${id}`, kind, url: pr.url, title: pr.title, name: nameOf(pr), at: now, ...extra })

  let nextMine = before.mine
  if (mine) {
    nextMine = {}
    const open = new Set(mine.map((p) => p.url))
    for (const pr of mine) {
      const cur = snapshotOf(pr)
      nextMine[pr.url] = cur
      const old = before.mine[pr.url]
      if (first || !old) continue
      if (old.decision !== cur.decision) {
        if (cur.decision === 'approved') event('approved', pr, `approved|${pr.headSha ?? ''}|${pr.updatedAt ?? ''}`, { headSha: pr.headSha })
        else if (cur.decision === 'changesRequested') event('changesRequested', pr, `changes-requested|${pr.headSha ?? ''}|${pr.updatedAt ?? ''}`, { headSha: pr.headSha })
      }
      if (old.ci !== cur.ci) {
        const stamp = pr.headSha ?? String(pr.updatedAt ?? '')
        if (cur.ci === 'failure') event('ciFailed', pr, `ci-failed|${stamp}`, { headSha: pr.headSha })
        else if (cur.ci === 'success' && old.ci === 'failure') event('ciPassed', pr, `ci-passed|${stamp}`, { headSha: pr.headSha })
      }
      if (old.mergeable !== 'conflicting' && cur.mergeable === 'conflicting') {
        event('conflicts', pr, `conflicts|${pr.headSha ?? pr.updatedAt ?? ''}`, { headSha: pr.headSha })
      }
      if (old.headSha && cur.headSha && old.headSha !== cur.headSha) event('newCommits', pr, `commits|${cur.headSha}`, { headSha: cur.headSha })
      if (old.commentCount !== undefined && cur.commentCount !== undefined && cur.commentCount > old.commentCount) {
        event('newComments', pr, `comments|${cur.commentCount}`, { count: cur.commentCount - old.commentCount, headSha: pr.headSha })
      }
    }
    // PRs that left the open list: merged or closed when their state can be read, kept a few syncs otherwise.
    for (const [url, old] of Object.entries(before.mine)) {
      if (open.has(url)) continue
      const gone = left[url]
      if (gone && (gone.state === 'merged' || gone.state === 'closed')) {
        if (!first) event(gone.state, gone, gone.state)
        continue
      }
      const misses = (old.misses ?? 0) + 1
      if (gone?.state !== 'open' && misses < MISS_LIMIT) nextMine[url] = { ...old, misses }
    }
  }

  let requested = before.requested
  if (toReview) {
    requested = toReview.map((p) => p.url)
    if (before.requested !== undefined) {
      const had = new Set(before.requested)
      for (const pr of toReview) {
        if (!had.has(pr.url)) event('reviewRequested', pr, `review-requested|${pr.updatedAt ?? ''}`, { actor: pr.author })
      }
    }
  }

  const seen = new Set(before.seen)
  const events = found.filter((e) => !seen.has(e.id))
  const kept = [...before.seen, ...events.map((e) => e.id)]
  return {
    events,
    state: { mine: nextMine, ...(requested ? { requested } : {}), seen: kept.length > SEEN_LIMIT ? kept.slice(kept.length - SEEN_LIMIT) : kept }
  }
}
