import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeHostCapabilities, PullRequest, PullRequestDetail, PullRequestItem } from '@workhub/core'
import { classifyPullRequest } from '@workhub/core'
import type { CodeHostLists } from '../src/shared/codehost-api'
import { RunQueue } from '../src/renderer/lib/runQueue'
import { initialPanelUi, panelUiFor } from '../src/renderer/lib/prPanelState'
import { clearPatches, patchDetail, patchFor, patchLists, PATCH_TTL_MS, recordPatch, settlePatch } from '../src/renderer/lib/prPatches'
import { cachedCount, clearDetailCache, DETAIL_CACHE_MAX, invalidateDetail, keepDetailsOf, loadDetail, slotOf } from '../src/renderer/lib/prDetailCache'
import { refreshPullRequests } from '../src/renderer/pullRequestsStore'
import { filterFromLists } from '../src/renderer/screens/settings/PullRequestsFilter'

const url = (n: number) => `https://github.com/acme/api/pull/${n}`
const caps = { reviewActions: ['approve', 'comment', 'requestChanges'] } as unknown as CodeHostCapabilities
const pr = (n: number, extra: Partial<PullRequest> = {}): PullRequest =>
  ({ provider: 'github', owner: 'acme', repo: 'api', number: n, url: url(n), title: `PR ${n}`, author: 'ana', branch: 'feat', base: 'main', state: 'open', isDraft: false, reviewDecision: 'none', ci: 'success', mergeable: 'mergeable', additions: 1, deletions: 1, changedFiles: 1, updatedAt: 1000, headSha: 'sha1', ...extra }) as PullRequest
const detailOf = (n: number, extra: Partial<PullRequestDetail> = {}): PullRequestDetail => ({ ...pr(n), body: '', labels: [], requestedReviewers: [], reviews: [], comments: [], threads: [], commits: [], checks: [], ...extra }) as PullRequestDetail
const item = (n: number, extra: Partial<PullRequest> = {}): PullRequestItem => {
  const p = pr(n, extra)
  return { pr: p, status: classifyPullRequest(p), stale: false, ticketKeys: [] }
}
const lists = (mine: PullRequestItem[], toReview: PullRequestItem[]): CodeHostLists => ({ state: 'ready', mine, toReview })

const deferred = <T>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function hub(overrides: Record<string, unknown> = {}) {
  const codeHost = {
    detail: vi.fn(async (_p: string | null, u: string) => ({ ok: true, detail: detailOf(Number(u.split('/').pop())), capabilities: caps, provider: 'github', isMine: false })),
    diff: vi.fn(async () => ({ ok: true, files: [] })),
    lists: vi.fn(async () => lists([], [])),
    onChanged: vi.fn(() => () => {}),
    ...overrides
  }
  ;(globalThis as unknown as { window: unknown }).window = { hub: { codeHost } }
  return codeHost
}

const settleTimers = () => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  clearDetailCache()
  clearPatches()
})
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  vi.useRealTimers()
})

describe('RunQueue', () => {
  it('queues a forced request during a run instead of dropping it, one waiting at most', async () => {
    const q = new RunQueue()
    const first = deferred<void>()
    const runs: string[] = []
    const a = q.request('k', false, async () => (runs.push('first'), first.promise))
    const b = q.request('k', true, async () => void runs.push('second'))
    const c = q.request('k', true, async () => void runs.push('third'))
    const plain = q.request('k', false, async () => void runs.push('plain'))
    expect(runs).toEqual(['first'])
    first.resolve()
    await Promise.all([a, b, c, plain])
    expect(runs).toEqual(['first', 'second'])
  })
})

describe('the lists refresh', () => {
  it('runs a forced refresh asked during a read right after it, and the later caller gets the newer lists', async () => {
    const first = deferred<CodeHostLists>()
    const h = hub({ lists: vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(async () => lists([], [item(2)])) })
    const slow = refreshPullRequests('p-queue')
    const forced = refreshPullRequests('p-queue', true)
    expect(h.lists).toHaveBeenCalledTimes(1)
    first.resolve(lists([], [item(1)]))
    await Promise.all([slow, forced])
    expect(h.lists).toHaveBeenCalledTimes(2)
    expect(h.lists).toHaveBeenLastCalledWith('p-queue', true)
  })
})

describe('local patches', () => {
  it('approve, request changes and a review comment take the PR out of "To review"; a merge reads merged; a close, closed', () => {
    recordPatch(url(1), { reviewed: true }, 5000)
    recordPatch(url(2), { state: 'merged' }, 5000)
    recordPatch(url(3), { state: 'closed' }, 5000)
    const patched = patchLists(lists([item(2), item(3), item(4)], [item(1), item(5)]), (u) => patchFor(u, 6000))
    expect(patched.toReview.map((i) => i.pr.number)).toEqual([5])
    expect(patched.mine.map((i) => [i.pr.number, i.pr.state, i.status])).toEqual([
      [2, 'merged', 'merged'],
      [3, 'closed', 'closed'],
      [4, 'open', expect.any(String)]
    ])
    expect(patchDetail(detailOf(2), patchFor(url(2), 6000))).toMatchObject({ state: 'merged' })
  })

  it('a plain comment patches nothing and keeps the same lists object', () => {
    const l = lists([item(1)], [item(2)])
    expect(patchLists(l, (u) => patchFor(u))).toBe(l)
  })

  it('survives a refresh that did not change the PR, for two minutes; a refresh showing it updated later ends it', () => {
    recordPatch(url(1), { reviewed: true }, 10_000)
    settlePatch(url(1), 9_000, 11_000)
    expect(patchFor(url(1), 12_000)).toBeDefined()
    expect(patchFor(url(1), 10_000 + PATCH_TTL_MS + 1)).toBeUndefined()
    settlePatch(url(1), 20_000, 21_000)
    expect(patchFor(url(1), 21_000)).toBeUndefined()
  })

  it('a failed refresh of the lists keeps the patch', async () => {
    const h = hub({ lists: vi.fn().mockResolvedValueOnce(lists([], [item(1)])).mockRejectedValueOnce(new Error('offline')) })
    await refreshPullRequests('p-fail')
    recordPatch(url(1), { reviewed: true })
    await refreshPullRequests('p-fail', true)
    expect(h.lists).toHaveBeenCalledTimes(2)
    expect(patchFor(url(1))).toBeDefined()
  })
})

describe('the detail cache', () => {
  it('opens a seen PR at once from the cache and refreshes it in the background; the diff follows the detail', async () => {
    const h = hub()
    await loadDetail(null, url(1), true)
    await settleTimers()
    expect(slotOf(null, url(1)).data?.detail.number).toBe(1)
    expect(h.diff).toHaveBeenCalledTimes(1)
    await loadDetail(null, url(2), true)
    // Back to A: the copy is there before any read ends.
    const gate = deferred<unknown>()
    h.detail.mockImplementationOnce(() => gate.promise as never)
    const back = loadDetail(null, url(1), true)
    expect(slotOf(null, url(1)).data?.detail.number).toBe(1)
    expect(slotOf(null, url(1)).refreshing).toBe(true)
    gate.resolve({ ok: true, detail: detailOf(1, { title: 'Newer' }), capabilities: caps, provider: 'github', isMine: false })
    await back
    expect(slotOf(null, url(1)).data?.detail.title).toBe('Newer')
    await settleTimers()
    // Same head: the diff is not read again.
    expect((h.diff.mock.calls as unknown as [string | null, string][]).filter((c) => c[1] === url(1))).toHaveLength(1)
  })

  it('asks main for a fresh read only when forced', async () => {
    const h = hub()
    await loadDetail(null, url(1), true)
    expect(h.detail).toHaveBeenLastCalledWith(null, url(1), true)
    await loadDetail(null, url(3))
    expect(h.detail).toHaveBeenLastCalledWith(null, url(3), false)
  })

  it('a failed refresh keeps the last good copy and records the error; a failed diff keeps its own error', async () => {
    const h = hub()
    await loadDetail(null, url(1), true)
    await settleTimers()
    h.detail.mockResolvedValueOnce({ ok: false, error: 'offline' } as never)
    await loadDetail(null, url(1), true)
    expect(slotOf(null, url(1))).toMatchObject({ error: 'offline', refreshing: false, data: { detail: { number: 1 } } })
    h.diff.mockResolvedValueOnce({ ok: false, error: 'too big' } as never)
    await loadDetail(null, url(2), true)
    await settleTimers()
    expect(slotOf(null, url(2)).diff).toMatchObject({ error: 'too big', files: null })
    expect(slotOf(null, url(2)).data?.detail.number).toBe(2)
  })

  it('reads the diff again when the head moved', async () => {
    const h = hub()
    await loadDetail(null, url(1), true)
    await settleTimers()
    h.detail.mockResolvedValueOnce({ ok: true, detail: detailOf(1, { headSha: 'sha2' }), capabilities: caps, provider: 'github', isMine: false } as never)
    await loadDetail(null, url(1), true)
    await settleTimers()
    expect(h.diff).toHaveBeenCalledTimes(2)
  })

  it('keeps about 30 entries, least recently used out first', async () => {
    hub()
    for (let n = 1; n <= DETAIL_CACHE_MAX + 5; n++) await loadDetail(null, url(n), true)
    expect(cachedCount()).toBe(DETAIL_CACHE_MAX)
    expect(slotOf(null, url(1)).data).toBeNull()
    expect(slotOf(null, url(DETAIL_CACHE_MAX + 5)).data).not.toBeNull()
  })

  it('drops a PR when a write changed it, and the other profiles when the profile switches', async () => {
    hub()
    await loadDetail('a', url(1), true)
    await loadDetail('a', url(2), true)
    await loadDetail('b', url(3), true)
    invalidateDetail(url(1))
    expect(slotOf('a', url(1)).data).toBeNull()
    expect(slotOf('a', url(2)).data).not.toBeNull()
    keepDetailsOf('b')
    expect(slotOf('a', url(2)).data).toBeNull()
    expect(slotOf('b', url(3)).data).not.toBeNull()
  })
})

describe('per-PR panel state', () => {
  it('a dialog opened on A is gone on B, and comes back fresh, not with A\'s dialog, when A is shown again', () => {
    const onA = { ...initialPanelUi(url(1)), action: 'approve' as const, merging: true, tab: 'files' }
    const onB = panelUiFor(onA, url(2))
    expect(onB).toEqual(initialPanelUi(url(2)))
    expect(onB.action).toBeNull()
    expect(panelUiFor(onA, url(1))).toBe(onA)
    expect(panelUiFor(onB, url(1), 'slack')).toEqual(initialPanelUi(url(1), 'slack'))
  })
})

describe('Settings: only these repositories', () => {
  it('is kept next to owners and hidden repositories, and alone', () => {
    expect(filterFromLists(['acme'], ['acme/old'], ['acme/api'])).toEqual({ owners: ['acme'], repos: ['acme/api'], excludeRepos: ['acme/old'] })
    expect(filterFromLists([], [], ['acme/api'])).toEqual({ repos: ['acme/api'] })
    expect(filterFromLists([], [], [])).toBeUndefined()
  })
})
