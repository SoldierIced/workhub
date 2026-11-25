import { CodeHostError, type MergedCoverage, type MergedList, type MergedPullRequest, type MergedQuery, type MergedSearch, type MergedStore } from '@workhub/core'
import type { MergedSync } from '../shared/codehost-api'

/** The most merged pull requests an answer holds (the newest); a read also stops when the saved rows reach it. */
export const MERGED_ANSWER_CAP = 10_000
/** A read whose newest end was set less than this long ago is not repeated (unless forced). */
export const MERGED_SKIP_MS = 5 * 60_000
/** The newest minutes are never marked as read: a merge may take that long to show in the host's search. */
export const MERGED_LAG_MS = 15 * 60_000
/** Scopes of one range read in parallel. */
export const MERGED_SCOPES_PARALLEL = 4

/** Why the host could not be read, in the words of the answer's `state`. */
export interface MergedFailure {
  state: 'missingCli' | 'signedOut' | 'error' | 'rateLimited'
  error: string
  retryAt?: number
}

/** A host failure as data: the host's own text, and when a rate limit lifts. */
export function mergedFailureOf(e: unknown): MergedFailure {
  const error = e instanceof Error ? e.message : String(e)
  if (e instanceof CodeHostError) {
    if (e.kind === 'rateLimited') return { state: 'rateLimited', error, ...(e.retryAt !== undefined ? { retryAt: e.retryAt } : {}) }
    if (e.kind === 'signedOut' || e.kind === 'missingCli') return { state: e.kind, error }
  }
  return { state: 'error', error }
}

/** What one profile's read needs: its scopes, the host, and the profile's own filter. */
export interface MergedTarget {
  profileId: string
  /** The connection the profile reads through (part of every search key). */
  hostKey: string
  scopes: string[]
  list(query: MergedQuery): Promise<MergedList>
  /**
   * The signed-in login; a failure says why not (status path: signedOut, missingCli, error). `savedLogin`: the host
   * could not be asked, and this is the last login known, so what was saved under it can still be shown (no read).
   */
  login(): Promise<{ login: string } | { failure: MergedFailure; savedLogin?: string }>
  /** The profile's filter (hidden repositories win). */
  filter(items: MergedPullRequest[]): MergedPullRequest[]
}

export interface MergedProfileRead {
  /** The saved merges of the period (filtered, newest first), not yet capped. */
  items: MergedPullRequest[]
  /** The answer is cut: a read stopped at the cap, or a list was cut and nothing certain came of it. */
  truncated: boolean
  /** Some part of the period before the newest read was never read completely. */
  partial: boolean
  /** Some part of the period is covered by complete reads. */
  covered: boolean
  fetchedAt: number
  sync: MergedSync
  failure?: MergedFailure
  /** The login the read was made as (lowercase), when known. */
  login?: string
}

interface Span {
  since: number
  until: number
}

const searchOf = (profileId: string, key: string): MergedSearch => ({ profileId, key })
const lockKey = (s: MergedSearch) => `${s.profileId}\n${s.key}`

/** The parts of `[since, until)` that no range of `covered` (sorted) holds, oldest first. */
export function uncoveredParts(covered: readonly MergedCoverage[], since: number, until: number): Span[] {
  const out: Span[] = []
  let cursor = since
  for (const r of covered) {
    if (cursor >= until) break
    if (r.until <= cursor) continue
    if (r.since >= until) break
    if (r.since > cursor) out.push({ since: cursor, until: Math.min(r.since, until) })
    cursor = Math.max(cursor, r.until)
  }
  if (cursor < until) out.push({ since: cursor, until })
  return out
}

/**
 * Keeps the merged pull requests of a profile in a store and reads from the host only what is missing:
 * the newest part (the tail) and the uncovered older parts (holes). Syncs of the same search run one
 * after the other.
 */
export class MergedSyncer {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly store: MergedStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** The ranges to read for `end = min(until, now)`: the tail first (unless it is fresh), then the holes, newest first. */
  private plan(cov: readonly MergedCoverage[], since: number, end: number, force: boolean): Span[] {
    if (since >= end) return []
    const newest = cov[cov.length - 1]
    if (!newest || newest.until <= since) return [{ since, until: end }]
    const tailStart = Math.min(newest.until, end)
    const ranges: Span[] = uncoveredParts(cov, since, tailStart).reverse()
    // Fresh: the newest end was set moments ago by a read that reached as far as a read can (up to the lag).
    const fresh = !force && this.now() - newest.at < MERGED_SKIP_MS && newest.until >= newest.at - MERGED_LAG_MS
    if (tailStart < end && !fresh) ranges.unshift({ since: tailStart, until: end })
    return ranges
  }

  async read(t: MergedTarget, request: { since: number; until: number; mine: boolean }, force: boolean): Promise<MergedProfileRead> {
    const { since, until, mine } = request
    const scopeKey = t.scopes.join(' ')
    const resolved = await t.login()
    // Every key names the account: another account (after `gh auth switch`) may see other repositories, so its reads never count for this one.
    if ('failure' in resolved) {
      const saved = resolved.savedLogin?.toLowerCase()
      if (saved === undefined) return this.answer(t, undefined, request, undefined, { failure: resolved.failure })
      // Offline or limited: what was saved under the last login shows, with the failure (Mine from its own rows).
      const key = mine ? `mine|${t.hostKey}|${saved}|${scopeKey}` : `all|${t.hostKey}|${saved}|${scopeKey}`
      return this.answer(t, searchOf(t.profileId, key), request, undefined, { failure: resolved.failure, login: saved })
    }
    const login = resolved.login.toLowerCase()
    const everyone = searchOf(t.profileId, `all|${t.hostKey}|${login}|${scopeKey}`)
    if (mine && !force) {
      // Mine from Everyone: when Everyone has nothing left to read, its rows of the author are the answer.
      const cov = await this.store.covered(everyone)
      const end = Math.min(until, this.now())
      if (cov.length > 0 && this.plan(cov, since, end, false).length === 0) return this.answer(t, everyone, request, login, { login })
    }
    const search = mine ? searchOf(t.profileId, `mine|${t.hostKey}|${login}|${scopeKey}`) : everyone
    return this.locked(search, async () => {
      const startedAt = this.now()
      const end = Math.min(until, startedAt)
      const ranges = this.plan(await this.store.covered(search), since, end, force)
      if (ranges.length === 0) return this.answer(t, search, request, undefined, { login })
      let failure: MergedFailure | undefined
      let stoppedByCap = false
      let cutUncovered = false
      for (const [i, range] of ranges.entries()) {
        if (i > 0 && (await this.store.count([search], since, until)) >= MERGED_ANSWER_CAP) {
          stoppedByCap = true
          break
        }
        const done = await this.readRange(t, search, mine, range)
        cutUncovered ||= done.cutUncovered
        if (done.failure) {
          failure = done.failure
          break
        }
      }
      return this.answer(t, search, request, undefined, { failure, stoppedByCap, cutUncovered, synced: true, login })
    })
  }

  /** One range over every scope: saves what came back, and marks the range read only when every scope says it is complete. */
  private async readRange(t: MergedTarget, search: MergedSearch, mine: boolean, range: Span): Promise<{ failure?: MergedFailure; cutUncovered: boolean }> {
    const startedAt = this.now()
    const lists: MergedList[] = []
    let failure: MergedFailure | undefined
    let next = 0
    const worker = async (): Promise<void> => {
      while (!failure && next < t.scopes.length) {
        const scope = t.scopes[next++]!
        try {
          lists.push(await t.list({ scope, since: range.since, until: range.until, mine }))
        } catch (e) {
          failure ??= mergedFailureOf(e)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MERGED_SCOPES_PARALLEL, t.scopes.length) }, worker))
    // Saved whatever happens next.
    const items = new Map<string, MergedPullRequest>()
    for (const l of lists) for (const p of l.items) items.set(p.url, p)
    if (items.size > 0) await this.store.save(search, [...items.values()])
    const interrupted = lists.flatMap((l) => (l.interrupted ? [l.interrupted] : []))
    if (!failure && interrupted.length > 0) {
      const retryAt = Math.max(...interrupted.map((i) => i.retryAt))
      failure = { state: 'rateLimited', error: interrupted[0]!.message, retryAt }
    }
    const certain = lists.every((l) => !(l.truncated || l.interrupted) || l.coveredSince !== undefined)
    if (!failure || interrupted.length > 0) {
      if (certain && lists.length === t.scopes.length) {
        const coveredSince = Math.max(range.since, ...lists.map((l) => l.coveredSince ?? range.since))
        await this.store.cover(search, coveredSince, Math.min(range.until, startedAt - MERGED_LAG_MS), startedAt)
      }
    }
    const cutUncovered = lists.some((l) => l.truncated && l.coveredSince === undefined)
    return { ...(failure ? { failure } : {}), cutUncovered }
  }

  /** The saved rows of the period for `search` (Mine from Everyone: `login` filters the author), and how the read went. */
  private async answer(
    t: MergedTarget,
    search: MergedSearch | undefined,
    request: { since: number; until: number },
    authorLogin: string | undefined,
    how: { failure?: MergedFailure; stoppedByCap?: boolean; cutUncovered?: boolean; synced?: boolean; login?: string }
  ): Promise<MergedProfileRead> {
    const { since, until } = request
    const rows = search ? (await this.store.read([search], since, until)).map((r) => r.pr) : []
    const mineRows = authorLogin ? rows.filter((p) => p.author.toLowerCase() === authorLogin) : rows
    const cov = search ? await this.store.covered(search) : []
    const newest = cov[cov.length - 1]
    const covered = cov.some((r) => r.until > since && r.since < until)
    const partial = newest ? uncoveredParts(cov, since, Math.min(newest.until, until)).length > 0 : false
    const items = t.filter(mineRows)
    const failure = how.failure
    const sync: MergedSync = failure
      ? { state: 'failed', reason: failure.state, error: failure.error, ...(failure.retryAt !== undefined ? { retryAt: failure.retryAt } : {}) }
      : { state: how.synced ? 'synced' : 'saved' }
    return {
      items,
      truncated: Boolean(how.stoppedByCap || how.cutUncovered || items.length > MERGED_ANSWER_CAP),
      partial,
      covered,
      fetchedAt: newest?.at ?? this.now(),
      sync,
      ...(failure ? { failure } : {}),
      ...(how.login ? { login: how.login } : {})
    }
  }

  private async locked<T>(search: MergedSearch, run: () => Promise<T>): Promise<T> {
    const key = lockKey(search)
    const before = this.locks.get(key) ?? Promise.resolve()
    const mine = before.then(run, run)
    const tail = mine.then(() => undefined, () => undefined)
    this.locks.set(key, tail)
    try {
      return await mine
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }
}
