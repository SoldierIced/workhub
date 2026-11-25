import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeHostError, emptyConfig, type CodeHost, type MergedList, type MergedPullRequest, type MergedQuery, type WorkhubConfig } from '@workhub/core'
import { CodeHostService } from '../src/main/codehost'
import { MERGED_LAG_MS, uncoveredParts } from '../src/main/merged-sync'
import { FakeMergedStore } from './merged-store-fake'

const MIN = 60_000
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 24, 12)
const SINCE = NOW - 10 * DAY
/** The end lies after "now", like the Merged view's current month. */
const REQUEST = { since: SINCE, until: NOW + DAY, mine: false }

const merged = (repo: string, number: number, mergedAt: number, author = 'ana'): MergedPullRequest => ({
  provider: 'github', owner: 'acme', repo, number, url: `https://example.com/acme/${repo}/pull/${number}`, title: `Change ${number}`, author, branch: 'feat/x', base: 'main', mergedAt
})

/** A host whose merged search answers from `data` (scope `repo:acme/x`, period, `mine`), and can be told to fail or answer oddly once. */
function fakeHost(data: MergedPullRequest[], login = 'me') {
  const calls: MergedQuery[] = []
  const state = {
    data,
    login,
    signedOut: false,
    fail: null as Error | null,
    next: null as Partial<MergedList> | null,
    gate: null as Promise<void> | null
  }
  const host = {
    provider: 'github',
    status: async () => (state.signedOut ? { state: 'signedOut' as const, cli: 'gh' } : { state: 'ready' as const, login: state.login }),
    listMerged: async (q: MergedQuery): Promise<MergedList> => {
      calls.push(q)
      await state.gate
      if (state.fail) throw state.fail
      const repos = [...(q.scope ?? '').matchAll(/repo:(\S+)/g)].map((m) => m[1]!)
      const items = state.data
        .filter((p) => repos.length === 0 || repos.includes(`${p.owner}/${p.repo}`))
        .filter((p) => p.mergedAt >= q.since && p.mergedAt < q.until)
        .filter((p) => !q.mine || p.author === state.login)
        .sort((a, b) => b.mergedAt - a.mergedAt)
      const odd = state.next
      state.next = null
      return { items, truncated: false, ...odd }
    }
  }
  return { host: host as unknown as CodeHost, calls, state }
}

type Fake = ReturnType<typeof fakeHost>

function setup(hosts: Record<string, Fake>, repos: Record<string, string[]> = { p1: ['acme/api', 'acme/web'], p2: ['acme/api', 'acme/web'] }) {
  const store = new FakeMergedStore()
  const config = {
    ...emptyConfig(),
    activeProfileId: 'p1',
    profiles: Object.keys(hosts).map((id, i) => ({ id, name: id, connections: { codeHost: `c${i + 1}` }, pullRequests: { repos: repos[id] } })),
    connections: Object.keys(hosts).map((_, i) => ({ id: `c${i + 1}`, provider: 'github', settings: {} }))
  } as unknown as WorkhubConfig
  const service = new CodeHostService(async () => config, { demo: false, mergedStore: store })
  const byConnection = Object.fromEntries(Object.keys(hosts).map((id, i) => [`c${i + 1}`, hosts[id]!]))
  vi.spyOn(service as unknown as { hostFor: (c: { id: string }) => unknown }, 'hostFor').mockImplementation((c) => ({ host: byConnection[c.id]!.host, cli: 'gh' }))
  return { service, store, config }
}

let now = NOW
beforeEach(() => {
  now = NOW
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => vi.restoreAllMocks())

const itemsOf = (r: Awaited<ReturnType<CodeHostService['merged']>>) => (r.ok ? r.items.map((i) => `${i.repo}#${i.number}`) : [])

describe('merged sync: what is read', () => {
  const data = [merged('api', 1, NOW - 2 * DAY), merged('web', 2, NOW - 5 * DAY, 'bo')]

  it('answers a second read within 5 minutes from what is saved, with no host call', async () => {
    const a = fakeHost(data)
    const { service } = setup({ p1: a })
    const first = await service.merged('p1', REQUEST)
    expect(first).toMatchObject({ ok: true, sync: { state: 'synced' }, partial: false, truncated: false })
    expect(itemsOf(first)).toEqual(['api#1', 'web#2'])
    expect(a.calls).toHaveLength(1)
    now += 2 * MIN
    const second = await service.merged('p1', REQUEST)
    expect(second).toMatchObject({ ok: true, sync: { state: 'saved' }, partial: false })
    expect(itemsOf(second)).toEqual(['api#1', 'web#2'])
    expect(a.calls).toHaveLength(1)
  })

  it('reads the saved rows once per answer, and only counts them between ranges', async () => {
    const a = fakeHost(data)
    const { service, store } = setup({ p1: a })
    await service.merged('p1', { since: REQUEST.since + 3 * DAY, until: REQUEST.until, mine: false })
    store.reads = 0
    store.counts = 0
    now += 6 * MIN
    // A longer period: the tail and an older hole, two ranges read.
    await service.merged('p1', REQUEST)
    expect(a.calls.length).toBeGreaterThanOrEqual(3)
    expect(store.reads).toBe(1)
    expect(store.counts).toBeGreaterThanOrEqual(1)
  })

  it('reads only the tail after 5 minutes, from the old read end (15 minutes before it started) to now', async () => {
    const a = fakeHost(data)
    const { service } = setup({ p1: a })
    await service.merged('p1', REQUEST)
    expect(a.calls[0]).toMatchObject({ since: SINCE, until: NOW })
    now += 6 * MIN
    a.state.data = [...data, merged('api', 3, NOW + MIN)]
    const result = await service.merged('p1', REQUEST)
    expect(a.calls).toHaveLength(2)
    expect(a.calls[1]).toMatchObject({ since: NOW - MERGED_LAG_MS, until: NOW + 6 * MIN })
    expect(result).toMatchObject({ ok: true, sync: { state: 'synced' } })
    expect(itemsOf(result)).toEqual(['api#3', 'api#1', 'web#2'])
  })

  it('reads an uncovered older period even within 5 minutes, and nothing else', async () => {
    const a = fakeHost(data)
    const { service } = setup({ p1: a })
    await service.merged('p1', { ...REQUEST, since: NOW - 4 * DAY })
    now += MIN
    const result = await service.merged('p1', REQUEST)
    expect(a.calls).toHaveLength(2)
    expect(a.calls[1]).toMatchObject({ since: SINCE, until: NOW - 4 * DAY })
    expect(itemsOf(result)).toEqual(['api#1', 'web#2'])
    expect(result).toMatchObject({ ok: true, partial: false })
  })

  it('reads an old period from the newest to the oldest hole, one after the other, and forces the tail when asked', async () => {
    const a = fakeHost(data)
    const { service } = setup({ p1: a })
    await service.merged('p1', { ...REQUEST, since: NOW - 4 * DAY, until: NOW - 3 * DAY })
    await service.merged('p1', { ...REQUEST, since: NOW - 8 * DAY, until: NOW - 6 * DAY })
    a.calls.length = 0
    await service.merged('p1', { since: NOW - 9 * DAY, until: NOW - DAY, mine: false })
    expect(a.calls.map((c) => [c.since, c.until])).toEqual([
      [NOW - 3 * DAY, NOW - DAY],
      [NOW - 6 * DAY, NOW - 4 * DAY],
      [NOW - 9 * DAY, NOW - 8 * DAY]
    ])
    a.calls.length = 0
    await service.merged('p1', REQUEST, true)
    expect(a.calls.length).toBeGreaterThan(0)
  })

  it('does not show or count the rows of an old scope after the scope changes', async () => {
    const a = fakeHost(data)
    const { service, config } = setup({ p1: a }, { p1: ['acme/api'] })
    expect(itemsOf(await service.merged('p1', REQUEST))).toEqual(['api#1'])
    now += MIN
    config.profiles[0]!.pullRequests = { repos: ['acme/web'] }
    const result = await service.merged('p1', REQUEST)
    expect(a.calls).toHaveLength(2)
    expect(a.calls[1]!.scope).toBe('repo:acme/web')
    expect(itemsOf(result)).toEqual(['web#2'])
  })

  it('serialises the syncs of one search: a second request finds what the first read', async () => {
    const a = fakeHost(data)
    const { service } = setup({ p1: a })
    let open!: () => void
    a.state.gate = new Promise<void>((resolve) => (open = resolve))
    const one = service.merged('p1', REQUEST)
    const two = service.merged('p1', { ...REQUEST, until: NOW + 2 * DAY })
    await vi.waitFor(() => expect(a.calls).toHaveLength(1))
    open()
    await Promise.all([one, two])
    expect(a.calls).toHaveLength(1)
  })
})

describe('merged sync: Mine', () => {
  const data = [merged('api', 1, NOW - 2 * DAY, 'me'), merged('web', 2, NOW - 5 * DAY, 'bo'), merged('api', 3, NOW - DAY, 'Me')]

  it('is answered from Everyone when Everyone has nothing left to read', async () => {
    const a = fakeHost(data)
    const { service } = setup({ p1: a })
    await service.merged('p1', REQUEST)
    now += MIN
    const mine = await service.merged('p1', { ...REQUEST, mine: true })
    expect(a.calls).toHaveLength(1)
    expect(itemsOf(mine)).toEqual(['api#3', 'api#1'])
    expect(mine).toMatchObject({ ok: true, sync: { state: 'saved' } })
  })

  it('reads Mine on its own when Everyone is stale or forced, and keeps it apart', async () => {
    const a = fakeHost(data)
    const { service, store } = setup({ p1: a })
    const mine = await service.merged('p1', { ...REQUEST, mine: true })
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]!.mine).toBe(true)
    expect([...store.ranges.keys()].map((k) => k.split('|')[0])).toEqual(['p1\nmine'])
    expect(itemsOf(mine)).toEqual(['api#1'])
  })

  it('does not reuse the Mine coverage of another login', async () => {
    const a = fakeHost(data)
    const { service, store } = setup({ p1: a })
    await service.merged('p1', { ...REQUEST, mine: true })
    a.state.login = 'bo'
    ;(service as unknown as { logins: Map<string, unknown> }).logins.clear()
    now += MIN
    const result = await service.merged('p1', { ...REQUEST, mine: true })
    expect(a.calls).toHaveLength(2)
    expect(itemsOf(result)).toEqual(['web#2'])
    const keys = [...store.ranges.keys()]
    expect(keys).toHaveLength(2)
    expect(keys.some((k) => k.includes('|me|'))).toBe(true)
    expect(keys.some((k) => k.includes('|bo|'))).toBe(true)
  })
})

describe('merged sync: failures and coverage', () => {
  const data = [merged('api', 1, NOW - 2 * DAY), merged('web', 2, NOW - 5 * DAY)]

  it('keeps what an interrupted read found and covers up to coveredSince', async () => {
    const a = fakeHost(data)
    const { service, store } = setup({ p1: a })
    const retryAt = NOW + 5 * MIN
    a.state.next = { truncated: true, coveredSince: NOW - 3 * DAY, interrupted: { kind: 'rateLimited', message: 'secondary rate limit', retryAt } }
    const result = await service.merged('p1', REQUEST)
    expect(result).toMatchObject({ ok: true, sync: { state: 'failed', reason: 'rateLimited', error: 'secondary rate limit', retryAt }, partial: true })
    expect(itemsOf(result)).toEqual(['api#1', 'web#2'])
    expect([...store.ranges.values()]).toEqual([[{ since: NOW - 3 * DAY, until: NOW - MERGED_LAG_MS, at: NOW }]])
  })

  it('answers saved rows with the failure and retryAt when the host is rate limited, and ok:false when nothing is saved', async () => {
    const a = fakeHost(data)
    const { service } = setup({ p1: a })
    await service.merged('p1', REQUEST)
    now += 6 * MIN
    const retryAt = now + 5 * MIN
    a.state.fail = new CodeHostError('API rate limit exceeded', 'rateLimited', retryAt)
    const result = await service.merged('p1', REQUEST)
    expect(result).toMatchObject({ ok: true, sync: { state: 'failed', reason: 'rateLimited', error: 'API rate limit exceeded', retryAt }, partial: false })
    expect(itemsOf(result)).toEqual(['api#1', 'web#2'])

    const b = fakeHost(data)
    b.state.fail = new CodeHostError('secondary rate limit', 'rateLimited', retryAt)
    const empty = setup({ p1: b })
    expect(await empty.service.merged('p1', REQUEST)).toEqual({ ok: false, state: 'rateLimited', error: 'secondary rate limit', retryAt })
  })

  it('keeps the failure states as before when nothing is saved', async () => {
    const a = fakeHost(data)
    a.state.signedOut = true
    const { service } = setup({ p1: a })
    expect(await service.merged('p1', REQUEST)).toMatchObject({ ok: false, state: 'signedOut' })
    a.state.signedOut = false
    a.state.fail = new Error('HTTP 502')
    expect(await service.merged('p1', REQUEST)).toMatchObject({ ok: false, state: 'error', error: 'HTTP 502' })
  })

  it('is not partial right after a full read, and is when an older hole could not be read', async () => {
    const a = fakeHost(data)
    const { service } = setup({ p1: a })
    expect(await service.merged('p1', { ...REQUEST, since: NOW - 4 * DAY })).toMatchObject({ ok: true, partial: false })
    now += MIN
    a.state.fail = new Error('HTTP 502')
    const result = await service.merged('p1', REQUEST)
    expect(result).toMatchObject({ ok: true, partial: true, sync: { state: 'failed', reason: 'error' } })
  })

  it('marks nothing read when a list is cut and says nothing certain', async () => {
    const a = fakeHost(data)
    const { service, store } = setup({ p1: a })
    a.state.next = { truncated: true }
    const result = await service.merged('p1', REQUEST)
    expect(result).toMatchObject({ ok: true, truncated: true, partial: false })
    expect(store.ranges.size).toBe(0)
    // Kept in memory like before: the next call within 10 minutes does not read.
    expect(await service.merged('p1', REQUEST)).toBe(result)
    expect(a.calls).toHaveLength(1)
  })
})

describe('merged sync: all profiles', () => {
  const shared = merged('api', 5, NOW - DAY)
  const dataA = [merged('api', 1, NOW - 2 * DAY), shared]
  const dataB = [merged('web', 7, NOW - 3 * DAY), shared]

  it('unions, dedupes by URL, counts the profiles and takes sync and scope from the active one', async () => {
    const a = fakeHost(dataA)
    const b = fakeHost(dataB)
    const { service, store } = setup({ p1: a, p2: b })
    const result = await service.merged('p1', { ...REQUEST, allProfiles: true })
    expect(itemsOf(result)).toEqual(['api#5', 'api#1', 'web#7'])
    expect(result).toMatchObject({ ok: true, profiles: 2, sync: { state: 'synced' }, partial: false, scope: { kind: 'repos' } })
    expect(new Set([...store.found.keys()].map((k) => k.split('\n')[0]))).toEqual(new Set(['p1', 'p2']))
    // This profile's view does not include the other's rows and has no `profiles`.
    const own = await service.merged('p1', REQUEST)
    expect(own.ok && own.items.map((i) => i.number)).toEqual([5, 1])
    expect(own.ok && own.profiles).toBeUndefined()
  })

  it('lets a failing profile contribute what is saved without changing the sync', async () => {
    const a = fakeHost(dataA)
    const b = fakeHost(dataB)
    const { service } = setup({ p1: a, p2: b })
    await service.merged('p1', { ...REQUEST, allProfiles: true })
    now += 6 * MIN
    b.state.fail = new CodeHostError('secondary rate limit', 'rateLimited', now + 5 * MIN)
    const result = await service.merged('p1', { ...REQUEST, allProfiles: true })
    expect(result).toMatchObject({ ok: true, profiles: 2, sync: { state: 'synced' } })
    expect(result.ok && result.items).toHaveLength(3)
  })

  it('keeps All and This apart in the flights', async () => {
    const a = fakeHost(dataA)
    const b = fakeHost(dataB)
    const { service } = setup({ p1: a, p2: b })
    let open!: () => void
    a.state.gate = new Promise<void>((resolve) => (open = resolve))
    const own = service.merged('p1', REQUEST)
    const all = service.merged('p1', { ...REQUEST, allProfiles: true })
    await vi.waitFor(() => expect(a.calls).toHaveLength(1))
    open()
    const [ownResult, allResult] = await Promise.all([own, all])
    expect(ownResult.ok && ownResult.profiles).toBeUndefined()
    expect(allResult.ok && allResult.profiles).toBe(2)
    expect(ownResult.ok && ownResult.items).toHaveLength(2)
    expect(allResult.ok && allResult.items).toHaveLength(3)
  })

  it('reads Mine with each profile\'s own login', async () => {
    const a = fakeHost([merged('api', 1, NOW - DAY, 'me')], 'me')
    const b = fakeHost([merged('web', 2, NOW - DAY, 'bo')], 'bo')
    const { service } = setup({ p1: a, p2: b })
    const result = await service.merged('p1', { ...REQUEST, mine: true, allProfiles: true })
    expect(itemsOf(result).sort()).toEqual(['api#1', 'web#2'])
  })
})

describe('merged sync: demo and helpers', () => {
  it('never touches the store with the demo host', async () => {
    const store = new FakeMergedStore()
    const service = new CodeHostService(async () => emptyConfig() as WorkhubConfig, { demo: true, mergedStore: store })
    const result = await service.merged(null, { since: NOW - 30 * DAY, until: NOW + DAY, mine: false, allProfiles: true })
    expect(result).toMatchObject({ ok: true, demo: true, sync: { state: 'synced' }, partial: false })
    expect(store.calls).toBe(0)
  })

  it('finds the uncovered parts of a period', () => {
    const cov = [
      { since: 10, until: 20, at: 1 },
      { since: 30, until: 40, at: 1 }
    ]
    expect(uncoveredParts(cov, 0, 50)).toEqual([{ since: 0, until: 10 }, { since: 20, until: 30 }, { since: 40, until: 50 }])
    expect(uncoveredParts(cov, 12, 35)).toEqual([{ since: 20, until: 30 }])
    expect(uncoveredParts(cov, 12, 18)).toEqual([])
    expect(uncoveredParts([], 5, 9)).toEqual([{ since: 5, until: 9 }])
  })

  it('the fake store joins ranges like the port says: the newest end keeps its `at`, an empty range does nothing', async () => {
    const store = new FakeMergedStore()
    const s = { profileId: 'p', key: 'k' }
    await store.cover(s, 10, 20, 100)
    await store.cover(s, 0, 10, 200)
    expect(await store.covered(s)).toEqual([{ since: 0, until: 20, at: 100 }])
    await store.cover(s, 5, 5, 300)
    await store.cover(s, 30, 20, 300)
    expect(await store.covered(s)).toHaveLength(1)
  })
})
