import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MergedPullRequest } from '@workhub/core'
import type { MergedPullRequestsResult, MergedRequest } from '../src/shared/codehost-api'
import {
  applyMergedNarrowing,
  clearMergedNarrowing,
  intoIsOn,
  intoKeeps,
  intoOptions,
  mergedNarrowingCount,
  mergedOptions,
  NO_MERGED_NARROWING,
  RELEASE_ALL,
  releaseSelection,
  searchMerged,
  toggleInto,
  toggleMergedValue,
  type MergedNarrowing
} from '../src/renderer/lib/mergedStats'
import { applyNarrowing, baseGroup, narrowOptions, NO_NARROWING } from '../src/renderer/lib/prNarrowing'
import { clearMerged, mergedKey, peekMerged, readMerged, watchMerged } from '../src/renderer/mergedStore'

const T = Date.UTC(2026, 10, 20, 12)
function pr(n: number, base: string, extra: Partial<MergedPullRequest> = {}): MergedPullRequest {
  return { provider: 'github', owner: 'acme', repo: 'api', number: n, url: `https://github.com/acme/api/pull/${n}`, title: `Change ${n}`, author: 'ana', branch: `feat-${n}`, base, mergedAt: T - n * 1000, ...extra }
}
const items = [
  pr(1, 'main'),
  pr(2, 'master', { repo: 'web', author: 'bo' }),
  pr(3, 'release/2.4'),
  pr(4, 'release/2.5', { author: 'bo' }),
  pr(5, 'release-2.6'),
  pr(6, 'develop', { repo: 'web' }),
  pr(7, 'dev'),
  pr(8, 'hotfix/x', { author: 'cy' })
]
const releases = ['release/2.4', 'release/2.5', 'release-2.6']
const withInto = (into: string[]): MergedNarrowing => ({ ...NO_MERGED_NARROWING, into })
const numbers = (list: MergedPullRequest[]) => list.map((i) => i.number).sort((a, b) => a - b)

describe('the Into filter', () => {
  it('keeps main and master apart', () => {
    expect(numbers(applyMergedNarrowing(items, withInto(['main'])))).toEqual([1])
    expect(numbers(applyMergedNarrowing(items, withInto(['master'])))).toEqual([2])
    expect(numbers(applyMergedNarrowing(items, withInto(['main', 'master'])))).toEqual([1, 2])
  })

  it('keeps develop, dev and development as their own names', () => {
    expect(numbers(applyMergedNarrowing(items, withInto(['develop'])))).toEqual([6])
    expect(numbers(applyMergedNarrowing(items, withInto(['dev'])))).toEqual([7])
  })

  it('release/* selects every release branch, whatever its separator', () => {
    expect(numbers(applyMergedNarrowing(items, withInto([RELEASE_ALL])))).toEqual([3, 4, 5])
    expect(intoKeeps([RELEASE_ALL], 'release/9.9')).toBe(true)
    expect(intoKeeps([RELEASE_ALL], 'hotfix/x')).toBe(false)
    expect(intoKeeps([], 'anything')).toBe(true)
  })

  it('toggles release/* on, off, and from a partial selection', () => {
    let n = toggleInto(NO_MERGED_NARROWING, RELEASE_ALL, releases)
    expect(releaseSelection(n.into, releases)).toBe('all')
    expect(intoIsOn(n.into, 'release/2.4')).toBe(true)
    n = toggleInto(n, RELEASE_ALL, releases)
    expect(n.into).toEqual([])

    const some = withInto(['release/2.4', 'main'])
    expect(releaseSelection(some.into, releases)).toBe('some')
    const all = toggleInto(some, RELEASE_ALL, releases)
    expect(releaseSelection(all.into, releases)).toBe('all')
    expect(all.into).toContain('main')
    expect(all.into).not.toContain('release/2.4')
  })

  it('shows release/* as all when every release branch is picked one by one', () => {
    expect(releaseSelection(['release/2.4', 'release/2.5', 'release-2.6'], releases)).toBe('all')
  })

  it('turning one release off while release/* is on keeps the others', () => {
    const n = toggleInto(withInto([RELEASE_ALL]), 'release/2.5', releases)
    expect(n.into).not.toContain(RELEASE_ALL)
    expect(numbers(applyMergedNarrowing(items, n))).toEqual([3, 5])
  })

  it('toggles a plain branch', () => {
    const n = toggleInto(NO_MERGED_NARROWING, 'main', releases)
    expect(n.into).toEqual(['main'])
    expect(toggleInto(n, 'main', releases).into).toEqual([])
  })

  it('offers every branch on its own with release/* ahead of the release branches', () => {
    const opts = intoOptions(items, NO_MERGED_NARROWING)
    expect(opts.map((o) => o.value)).toEqual(['main', 'master', RELEASE_ALL, 'release-2.6', 'release/2.4', 'release/2.5', 'dev', 'develop', 'hotfix/x'])
    expect(opts.find((o) => o.value === RELEASE_ALL)).toMatchObject({ count: 3, child: false })
    expect(opts.find((o) => o.value === 'release/2.4')).toMatchObject({ count: 1, child: true })
  })

  it('counts Into options under the other filters, and keeps a picked branch that has no PRs', () => {
    const n: MergedNarrowing = { ...NO_MERGED_NARROWING, authors: ['bo'], into: ['gone'] }
    const opts = intoOptions(items, n)
    expect(opts.find((o) => o.value === 'master')!.count).toBe(1)
    expect(opts.find((o) => o.value === 'main')!.count).toBe(0)
    expect(opts.find((o) => o.value === 'gone')!.count).toBe(0)
  })
})

describe('Repo, Author, search and order', () => {
  it('counts the options under the other filters', () => {
    const n: MergedNarrowing = { ...NO_MERGED_NARROWING, into: ['main', 'master'] }
    expect(mergedOptions(items, n, 'repos')).toEqual([{ value: 'acme/api', count: 1 }, { value: 'acme/web', count: 1 }])
    expect(mergedOptions(items, withInto([RELEASE_ALL]), 'authors')).toEqual([{ value: 'ana', count: 2 }, { value: 'bo', count: 1 }])
  })

  it('combines the fields with AND and the values of a field with OR', () => {
    const n = toggleMergedValue(toggleMergedValue(NO_MERGED_NARROWING, 'authors', 'bo'), 'authors', 'cy')
    expect(numbers(applyMergedNarrowing(items, n))).toEqual([2, 4, 8])
    expect(numbers(applyMergedNarrowing(items, { ...n, repos: ['acme/web'] }))).toEqual([2])
    expect(mergedNarrowingCount({ ...n, into: ['main'], repos: ['acme/web'] })).toBe(4)
    expect(clearMergedNarrowing({ ...n, order: 'oldest' })).toEqual({ ...NO_MERGED_NARROWING, order: 'oldest' })
  })

  it('orders by merge time, newest or oldest, or by repository', () => {
    expect(applyMergedNarrowing(items, NO_MERGED_NARROWING).map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(applyMergedNarrowing(items, { ...NO_MERGED_NARROWING, order: 'oldest' }).map((i) => i.number)).toEqual([8, 7, 6, 5, 4, 3, 2, 1])
    expect(applyMergedNarrowing(items, { ...NO_MERGED_NARROWING, order: 'repo' }).map((i) => i.repo)).toEqual(['api', 'api', 'api', 'api', 'api', 'api', 'web', 'web'])
  })

  it('searches the title, author, head and base branch', () => {
    expect(numbers(searchMerged(items, 'change 3'))).toEqual([3])
    expect(numbers(searchMerged(items, 'CY'))).toEqual([8])
    expect(numbers(searchMerged(items, 'feat-6'))).toEqual([6])
    expect(numbers(searchMerged(items, 'hotfix'))).toEqual([8])
    expect(searchMerged(items, '  ')).toHaveLength(8)
  })

  it('does not change the input', () => {
    const copy = [...items]
    applyMergedNarrowing(items, { ...NO_MERGED_NARROWING, order: 'oldest' })
    expect(items).toEqual(copy)
  })
})

describe('the other tabs keep their grouping', () => {
  it('still groups main and master as one target, and develop, dev and development as one', () => {
    expect(baseGroup('main')).toBe('master / main')
    expect(baseGroup('master')).toBe('master / main')
    expect(baseGroup('dev')).toBe('develop')
    expect(baseGroup('release/2.4')).toBe('release/2.4')
    const open = ['main', 'master', 'develop'].map((base, n) => ({ pr: { ...pr(n, base), state: 'open' }, status: 'waitingReview', stale: false, ticketKeys: [] }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = open as any
    expect(narrowOptions(list, 'bases')).toEqual([{ value: 'master / main', count: 2 }, { value: 'develop', count: 1 }])
    expect(applyNarrowing(list, { ...NO_NARROWING, bases: ['master / main'] })).toHaveLength(2)
  })
})

describe('the merged read store', () => {
  const req: MergedRequest = { since: 1, until: 2, mine: false }
  const ok = (n: number): MergedPullRequestsResult => ({ ok: true, items: [pr(n, 'main')], truncated: false, provider: 'github', fetchedAt: n, scope: { kind: 'repos', values: ['acme/api'] }, sync: { state: 'synced' }, partial: false })
  let changed: ((url: string, profileId: string | null) => void) | undefined
  let merged: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clearMerged()
    changed = undefined
    merged = vi.fn(async () => ok(1))
    ;(globalThis as unknown as { window: unknown }).window = {
      hub: { codeHost: { merged, onChanged: (cb: typeof changed) => ((changed = cb), () => {}) } }
    }
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('reads once per request and passes force through', async () => {
    await readMerged('p1', req)
    await readMerged('p1', req, true)
    expect(merged.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([['p1', req, false], ['p1', req, true]])
  })

  it('keeps the last good answer when a read fails or is refused', async () => {
    const { useMergedProbe } = await probe()
    await readMerged('p1', req)
    merged.mockResolvedValueOnce({ ok: false, state: 'error', error: 'boom' })
    await readMerged('p1', req, true)
    expect(useMergedProbe('p1', req)).toMatchObject({ data: { items: [expect.objectContaining({ number: 1 })] }, failure: { state: 'error', error: 'boom' }, loading: false })
    merged.mockRejectedValueOnce(new Error('offline'))
    await readMerged('p1', req, true)
    expect(useMergedProbe('p1', req).failure?.error).toContain('offline')
    expect(useMergedProbe('p1', req).data).not.toBeNull()
    merged.mockResolvedValueOnce(ok(2))
    await readMerged('p1', req, true)
    expect(useMergedProbe('p1', req)).toMatchObject({ failure: null, data: { fetchedAt: 2 } })
  })

  it('drops an old refusal as soon as a new read starts, keeping the data', async () => {
    const { useMergedProbe } = await probe()
    merged.mockResolvedValueOnce({ ok: false, state: 'noScope', error: 'no scope' })
    await readMerged('p1', req)
    expect(useMergedProbe('p1', req).failure?.state).toBe('noScope')
    let release!: (r: MergedPullRequestsResult) => void
    merged.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const running = readMerged('p1', req, true)
    expect(useMergedProbe('p1', req)).toMatchObject({ failure: null, loading: true })
    release(ok(3))
    await running
    expect(useMergedProbe('p1', req)).toMatchObject({ failure: null, data: { fetchedAt: 3 } })
  })

  it('has no data for a request never read, and keeps profiles and requests apart', async () => {
    const { useMergedProbe } = await probe()
    await readMerged('p1', req)
    expect(useMergedProbe('p2', req).data).toBeNull()
    expect(useMergedProbe('p1', { ...req, mine: true }).data).toBeNull()
    expect(mergedKey('p1', req)).not.toBe(mergedKey('p1', { ...req, until: 3 }))
  })

  it('reads again, forced, after a write for a request an open view shows, and only that profile', async () => {
    const release = watchMerged('p1', req)
    const other = watchMerged('p2', req)
    changed?.('https://github.com/acme/api/pull/1', 'p1')
    await vi.waitFor(() => expect(merged).toHaveBeenCalledTimes(1))
    expect(merged).toHaveBeenCalledWith('p1', req, true)
    changed?.('https://github.com/acme/api/pull/1', null)
    await vi.waitFor(() => expect(merged).toHaveBeenCalledTimes(3))
    release()
    other()
    changed?.('url', null)
    await new Promise((r) => setTimeout(r, 10))
    expect(merged).toHaveBeenCalledTimes(3)
  })

  it('sends the version it holds and keeps its items when main says they did not change', async () => {
    const full = { ...ok(1), version: 'v1' } as MergedPullRequestsResult
    merged.mockResolvedValueOnce(full)
    await readMerged('p1', req)
    merged.mockResolvedValueOnce({ ...full, items: [], unchanged: true, fetchedAt: 9 } as MergedPullRequestsResult)
    await readMerged('p1', req, true)
    expect(merged).toHaveBeenLastCalledWith('p1', { ...req, known: 'v1' }, true)
    expect(peekMerged('p1', req).data).toMatchObject({ fetchedAt: 9, items: [{ number: 1 }] })
  })

  it('keeps the newest answers only, never one on screen', async () => {
    const { MERGED_KEPT } = await import('../src/renderer/mergedStore')
    const shown = watchMerged('p1', req)
    await readMerged('p1', req)
    for (let i = 0; i < MERGED_KEPT + 3; i++) await readMerged('p1', { ...req, until: 10 + i })
    expect(peekMerged('p1', req).data).not.toBeNull()
    expect(peekMerged('p1', { ...req, until: 10 }).data).toBeNull()
    expect(peekMerged('p1', { ...req, until: 10 + MERGED_KEPT + 2 }).data).not.toBeNull()
    shown()
  })
})

/** Reads an entry without React: the store's snapshot is what the hook returns. */
async function probe() {
  const store = await import('../src/renderer/mergedStore')
  return { useMergedProbe: (p: string | null, r: MergedRequest) => store.peekMerged(p, r) }
}

describe('Merged view: all profiles and rate limits', () => {
  const req: MergedRequest = { since: 1, until: 2, mine: false }
  const okAnswer: MergedPullRequestsResult = { ok: true, items: [pr(1, 'main')], truncated: false, provider: 'github', fetchedAt: 1, scope: { kind: 'repos', values: ['acme/api'] }, sync: { state: 'synced' }, partial: false }
  let merged: ReturnType<typeof vi.fn>
  beforeEach(() => {
    clearMerged()
    merged = vi.fn(async () => okAnswer)
    ;(globalThis as unknown as { window: unknown }).window = { hub: { codeHost: { merged, onChanged: () => () => {} } } }
  })

  it('keeps This profile and All profiles apart in the key', () => {
    expect(mergedKey('p1', { ...req, allProfiles: true })).not.toBe(mergedKey('p1', req))
    expect(mergedKey('p1', { ...req, allProfiles: false })).toBe(mergedKey('p1', req))
  })

  it('counts the profiles whose code host connection exists', async () => {
    const { countCodeHostProfiles } = await import('../src/renderer/screens/pullRequests/useMergedView')
    const connections = [{ id: 'gh1', kind: 'codeHost' }, { id: 'gh2', kind: 'codeHost' }, { id: 'jira', kind: 'tracker' }]
    expect(countCodeHostProfiles(undefined)).toBe(0)
    expect(countCodeHostProfiles({ connections, profiles: [{ connections: { codeHost: 'gh1' } }, { connections: {} }, { connections: { codeHost: 'jira' } }] })).toBe(1)
    expect(countCodeHostProfiles({ connections, profiles: [{ connections: { codeHost: 'gh1' } }, { connections: { codeHost: 'gh2' } }] })).toBe(2)
  })

  it('reads once more after retryAt while the request is on screen, and not after it leaves', async () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      merged.mockResolvedValueOnce({ ok: false, state: 'rateLimited', error: 'limited', retryAt: now + 5000 })
      const release = watchMerged('p1', req)
      await readMerged('p1', req)
      const { peekMerged } = await import('../src/renderer/mergedStore')
      expect(peekMerged('p1', req).failure).toMatchObject({ state: 'rateLimited', retryAt: now + 5000 })
      expect(merged).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(6100)
      expect(merged).toHaveBeenCalledTimes(2)
      expect(merged).toHaveBeenLastCalledWith('p1', req, false)
      release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the scheduled read when the request leaves the screen', async () => {
    vi.useFakeTimers()
    try {
      merged.mockResolvedValueOnce({ ok: false, state: 'rateLimited', error: 'limited', retryAt: Date.now() + 5000 })
      const release = watchMerged('p1', req)
      await readMerged('p1', req)
      release()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(merged).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Mine taken from Everyone', () => {
  it('keeps the merges whose author is a signed-in login, whatever its case', async () => {
    const { mergedByLogins } = await import('../src/renderer/screens/pullRequests/useMergedView')
    const pr = (n: number, author: string) => ({ provider: 'github', owner: 'acme', repo: 'api', number: n, url: `https://github.com/acme/api/pull/${n}`, title: 't', author, branch: 'b', base: 'main', mergedAt: n })
    expect(mergedByLogins([pr(1, 'Ana'), pr(2, 'bo'), pr(3, 'ana')], ['ana']).map((p) => p.number)).toEqual([1, 3])
    expect(mergedByLogins([pr(1, 'ana'), pr(2, 'bo')], ['ana', 'bo']).map((p) => p.number)).toEqual([1, 2])
  })
})

describe('the merged list draws its first rows only', () => {
  it('cuts across day groups and keeps each group full count for its header', async () => {
    const { firstRows } = await import('../src/renderer/lib/mergedStats')
    const groups = [
      { start: 3, items: [1, 2, 3] },
      { start: 2, items: [4, 5] },
      { start: 1, items: [6] }
    ]
    expect(firstRows(groups, 4)).toEqual([
      { start: 3, items: [1, 2, 3], total: 3 },
      { start: 2, items: [4], total: 2 }
    ])
    expect(firstRows(groups, 10).map((g) => g.items.length)).toEqual([3, 2, 1])
    expect(firstRows(groups, 0)).toEqual([])
  })
})
