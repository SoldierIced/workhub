import { CodeHostError } from '@workhub/core'
import { describe, expect, it } from 'vitest'
import { createDemoRunner, GitHubCodeHost } from '../src/codehost-github'
import { mergedSearchQuery } from '../src/codehost-github/host'
import type { CliRunner } from '../src/shared/cli'

const DAY = 86_400_000
const SINCE = Date.UTC(2026, 9, 1)
const UNTIL = Date.UTC(2026, 9, 31)

interface Fake {
  number: number
  mergedAt: number
  author?: string
  extra?: Record<string, unknown>
}

const node = (f: Fake) => ({
  number: f.number,
  title: `Change ${f.number}`,
  url: `https://github.com/acme/api/pull/${f.number}`,
  mergedAt: new Date(f.mergedAt).toISOString(),
  createdAt: new Date(f.mergedAt - DAY).toISOString(),
  headRefName: `feat/c-${f.number}`,
  baseRefName: 'main',
  additions: 10,
  deletions: 4,
  changedFiles: 2,
  author: { login: f.author ?? 'ana' },
  repository: { name: 'api', owner: { login: 'acme' } },
  ...f.extra
})

/** A fake `gh api graphql` over a data set: honors `merged:A..B` and `author:@me`, reports the real total, and (like GitHub) lets no page reach past the 1,000th result. */
function fakeGh(data: Fake[], options: { ignoreWindow?: boolean } = {}) {
  const queries: string[] = []
  let running = 0
  let peak = 0
  const run = (async (_c: string, args: string[]) => {
    const q = args.find((a) => a.startsWith('q='))!.slice(2)
    queries.push(q)
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 1))
    running--
    const range = /merged:(\S+)\.\.(\S+)/.exec(q)!
    const [from, to] = [Date.parse(range[1]!), Date.parse(range[2]!)]
    const mine = q.includes('author:@me')
    const hits = data
      .filter((f) => options.ignoreWindow || (f.mergedAt >= from && f.mergedAt <= to))
      .filter((f) => !mine || f.author === 'me')
      .sort((a, b) => b.mergedAt - a.mergedAt)
    const offset = Number(args.find((a) => a.startsWith('after='))?.slice(6) ?? 0)
    const page = hits.slice(offset, Math.min(offset + 100, 1000))
    const more = offset + 100 < Math.min(hits.length, 1000)
    const search = { issueCount: hits.length, pageInfo: { hasNextPage: more, endCursor: more ? String(offset + 100) : null }, nodes: page.map(node) }
    return { code: 0, stdout: JSON.stringify({ data: { search } }), stderr: '' }
  }) as CliRunner
  return { run, queries, peak: () => peak }
}

/** A clock that only moves when the host waits: the 40-a-minute limit never makes a test slow. */
function fakeClock(start = Date.UTC(2026, 10, 1)) {
  let t = start
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
    sleeps
  }
}

const evenly = (count: number, from = SINCE, to = UNTIL): Fake[] =>
  Array.from({ length: count }, (_, i) => ({ number: i + 1, mergedAt: Math.floor((from + ((to - from) * (i + 0.5)) / count) / 1000) * 1000 }))

describe('GitHub listMerged: the query', () => {
  it('names the merged state, archived:false, UTC date-times and the scope; author:@me only when mine', async () => {
    const f = fakeGh(evenly(3))
    const host = new GitHubCodeHost({ run: f.run })
    await host.listMerged({ scope: 'repo:acme/api repo:acme/web', since: SINCE, until: UNTIL, mine: false })
    expect(f.queries).toEqual(['is:pr is:merged archived:false merged:2026-10-01T00:00:00Z..2026-10-30T23:59:59Z repo:acme/api repo:acme/web'])
    f.queries.length = 0
    await host.listMerged({ scope: 'org:acme', since: SINCE, until: UNTIL, mine: true })
    expect(f.queries[0]).toBe('is:pr is:merged archived:false merged:2026-10-01T00:00:00Z..2026-10-30T23:59:59Z org:acme author:@me')
  })

  it('does not ask GitHub for changedFiles: it makes every page about four times slower', async () => {
    const calls: string[][] = []
    const f = fakeGh(evenly(3))
    const run = (async (c: string, args: string[]) => {
      calls.push(args)
      return f.run(c, args)
    }) as CliRunner
    await new GitHubCodeHost({ run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    const query = calls[0]!.find((a) => a.startsWith('query='))!
    expect(query).toContain('additions deletions')
    expect(query).not.toContain('changedFiles')
  })

  it('leaves a missing scope out and keeps a short query under 256 characters', () => {
    expect(mergedSearchQuery(undefined, SINCE, UNTIL, false)).toBe('is:pr is:merged archived:false merged:2026-10-01T00:00:00Z..2026-10-30T23:59:59Z')
    expect(mergedSearchQuery('x'.repeat(150), SINCE, UNTIL, true).length).toBeLessThanOrEqual(256)
  })

  it('reads over the GitHub Enterprise host when one is set', async () => {
    const seen: string[][] = []
    const run: CliRunner = async (_c, args) => {
      seen.push(args)
      return { code: 0, stdout: JSON.stringify({ data: { search: { issueCount: 0, nodes: [] } } }), stderr: '' }
    }
    await new GitHubCodeHost({ run, host: 'ghe.example.com' }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(seen[0]).toContain('--hostname')
  })
})

describe('GitHub listMerged: the answer', () => {
  it('maps a merged PR, keeps a field the API did not send undefined and counts bots', async () => {
    const f = fakeGh([
      { number: 1, mergedAt: SINCE + DAY },
      { number: 2, mergedAt: SINCE + 2 * DAY, author: 'dependabot', extra: { additions: undefined, deletions: undefined, changedFiles: undefined, createdAt: undefined } },
      { number: 3, mergedAt: SINCE + 3 * DAY, extra: { additions: 0, deletions: 0, changedFiles: 0 } }
    ])
    const { items, truncated } = await new GitHubCodeHost({ run: f.run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(truncated).toBe(false)
    expect(items.map((i) => i.number)).toEqual([3, 2, 1])
    expect(items[2]).toMatchObject({ provider: 'github', owner: 'acme', repo: 'api', author: 'ana', branch: 'feat/c-1', base: 'main', additions: 10, deletions: 4, changedFiles: 2, mergedAt: SINCE + DAY, createdAt: SINCE })
    expect(items[1]).toMatchObject({ author: 'dependabot', additions: undefined, deletions: undefined, changedFiles: undefined, createdAt: undefined })
    // A real zero stays a zero.
    expect(items[0]).toMatchObject({ additions: 0, deletions: 0, changedFiles: 0 })
  })

  it('keeps only since <= mergedAt < until, whatever the search returned', async () => {
    const f = fakeGh(
      [
        { number: 1, mergedAt: SINCE - 1000 },
        { number: 2, mergedAt: SINCE },
        { number: 3, mergedAt: UNTIL - 1000 },
        { number: 4, mergedAt: UNTIL }
      ],
      { ignoreWindow: true }
    )
    const { items } = await new GitHubCodeHost({ run: f.run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(items.map((i) => i.number)).toEqual([3, 2])
  })

  it('dedupes by URL', async () => {
    const run: CliRunner = async () => {
      const n = node({ number: 7, mergedAt: SINCE + DAY })
      return { code: 0, stdout: JSON.stringify({ data: { search: { issueCount: 2, nodes: [n, n] } } }), stderr: '' }
    }
    expect((await new GitHubCodeHost({ run }).listMerged({ since: SINCE, until: UNTIL, mine: false })).items).toHaveLength(1)
  })

  it('reads every page of a window under 1,000', async () => {
    const f = fakeGh(evenly(250))
    const { items, truncated } = await new GitHubCodeHost({ run: f.run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(items).toHaveLength(250)
    expect(truncated).toBe(false)
    expect(f.queries).toHaveLength(3)
  })
})

describe('GitHub listMerged: windows and the cap', () => {
  it('halves a window that reports 1,000 or more and reads all of it, newest first, two searches at most at once', async () => {
    const data = evenly(2600)
    const f = fakeGh(data)
    const { items, truncated } = await new GitHubCodeHost({ run: f.run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(truncated).toBe(false)
    expect(items).toHaveLength(2600)
    expect(new Set(items.map((i) => i.url)).size).toBe(2600)
    expect(items.map((i) => i.mergedAt)).toEqual([...data].map((d) => d.mergedAt).sort((a, b) => b - a))
    expect(new Set(f.queries.map((q) => /merged:\S+/.exec(q)![0])).size).toBeGreaterThan(3)
    expect(f.peak()).toBeLessThanOrEqual(2)
    expect(f.peak()).toBeGreaterThan(1)
  })

  it('keeps the newest 3,000 and says truncated when there are more', async () => {
    const data = evenly(4600)
    const f = fakeGh(data)
    const { items, truncated } = await new GitHubCodeHost({ run: f.run, ...fakeClock() }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(truncated).toBe(true)
    expect(items).toHaveLength(3000)
    const newest = [...data].sort((a, b) => b.mergedAt - a.mergedAt).slice(0, 3000)
    expect(items.map((i) => i.number)).toEqual(newest.map((d) => d.number))
    // The oldest windows were never read.
    expect(f.queries.length).toBeLessThan(60)
  })

  it('reads a window it cannot split any further as it is and marks the result truncated', async () => {
    const hour = Date.UTC(2026, 9, 10, 8)
    const data = Array.from({ length: 1200 }, (_, i) => ({ number: i + 1, mergedAt: hour + Math.floor(i * 2.9) * 1000 }))
    const f = fakeGh(data)
    const { items, truncated } = await new GitHubCodeHost({ run: f.run }).listMerged({ since: hour, until: hour + 3_600_000, mine: false })
    expect(truncated).toBe(true)
    expect(items).toHaveLength(1000)
  })

  it('reads a merged page again with half the pull requests after an HTTP 504, and still reads the whole window', async () => {
    const data = evenly(150)
    const f = fakeGh(data)
    let failed = false
    const sizes: string[] = []
    const run = (async (c: string, args: string[]) => {
      sizes.push(args.find((a) => a.startsWith('first='))!)
      if (!failed) {
        failed = true
        return { code: 1, stdout: '', stderr: 'gh: HTTP 504: Gateway Timeout' }
      }
      return f.run(c, args)
    }) as CliRunner
    const list = await new GitHubCodeHost({ run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(sizes.slice(0, 2)).toEqual(['first=100', 'first=50'])
    expect(list.items).toHaveLength(150)
    expect(list.truncated).toBe(false)
  })

  it('reads nothing for an empty period', async () => {
    const f = fakeGh(evenly(5))
    expect(await new GitHubCodeHost({ run: f.run }).listMerged({ since: UNTIL, until: SINCE, mine: false })).toEqual({ items: [], truncated: false })
    expect(f.queries).toHaveLength(0)
  })
})

describe('GitHub listMerged: failures', () => {
  it('turns a signed-out answer into a CodeHostError of that kind', async () => {
    const run: CliRunner = async () => ({ code: 1, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login' })
    await expect(new GitHubCodeHost({ run }).listMerged({ since: SINCE, until: UNTIL, mine: false })).rejects.toMatchObject({ kind: 'signedOut' })
  })

  it('turns an unreadable answer into a CodeHostError', async () => {
    const run: CliRunner = async () => ({ code: 0, stdout: 'nope', stderr: '' })
    await expect(new GitHubCodeHost({ run }).listMerged({ since: SINCE, until: UNTIL, mine: false })).rejects.toBeInstanceOf(CodeHostError)
  })
})

describe('the demo runner', () => {
  const NOW = Date.UTC(2026, 9, 27, 12)
  const demo = () => new GitHubCodeHost({ run: createDemoRunner(NOW) })

  it('answers the merged search with about 120 days of merges: master, two releases, a bot', async () => {
    const { items, truncated } = await demo().listMerged({ scope: 'org:acme-demo', since: NOW - 130 * DAY, until: NOW, mine: false })
    expect(truncated).toBe(false)
    expect(items.length).toBeGreaterThan(150)
    const bases = new Set(items.map((i) => i.base))
    expect(bases.has('master')).toBe(true)
    expect(bases.has('main')).toBe(true)
    expect(bases.has('develop')).toBe(true)
    expect([...bases].filter((b) => b.startsWith('release/'))).toHaveLength(2)
    expect(items.some((i) => i.author === 'dependabot')).toBe(true)
    expect(Math.max(...items.map((i) => NOW - i.mergedAt)) / DAY).toBeGreaterThan(100)
    expect(items.every((i) => typeof i.additions === 'number')).toBe(true)
  })

  it('splits the period when it holds 1,000 or more, and honors author:@me', async () => {
    const mine = await demo().listMerged({ since: NOW - 130 * DAY, until: NOW, mine: true })
    expect(mine.items.length).toBeGreaterThan(0)
    expect(mine.items.every((i) => i.author === 'demo-dev')).toBe(true)
  })

  it('opens a merged PR through pr view', async () => {
    const host = demo()
    const [first] = (await host.listMerged({ since: NOW - 30 * DAY, until: NOW, mine: false })).items
    const detail = await host.detail(first!)
    expect(detail).toMatchObject({ state: 'merged', number: first!.number, base: first!.base })
    expect(detail.mergedAt).toBe(first!.mergedAt)
  })

  it('does not touch the open lists: the merged PRs are not in them', async () => {
    const authored = await demo().listAuthored({})
    expect(authored.every((p) => p.state === 'open')).toBe(true)
  })
})

const query = { since: SINCE, until: UNTIL, mine: false }

/** Every merge of `[coveredSince, until)` is in the list: what the contract promises. */
function expectCovered(data: Fake[], list: { items: { number: number }[]; coveredSince?: number }): void {
  expect(list.coveredSince).toBeDefined()
  const have = new Set(list.items.map((i) => i.number))
  const missing = data.filter((d) => d.mergedAt >= list.coveredSince! && d.mergedAt < UNTIL && !have.has(d.number))
  expect(missing).toEqual([])
}

describe('GitHub listMerged: coveredSince', () => {
  it('is absent when the whole period was read', async () => {
    const list = await new GitHubCodeHost({ run: fakeGh(evenly(30)).run }).listMerged(query)
    expect(list.truncated).toBe(false)
    expect(list.coveredSince).toBeUndefined()
    expect(list.interrupted).toBeUndefined()
  })

  it('after the cap, certifies the windows read and the final slice of the two parallel windows', async () => {
    const data = evenly(4600)
    const list = await new GitHubCodeHost({ run: fakeGh(data).run, ...fakeClock() }).listMerged(query)
    expect(list.truncated).toBe(true)
    expect(list.items).toHaveLength(3000)
    expect(list.coveredSince).toBeGreaterThan(SINCE)
    expect(list.coveredSince).toBeLessThan(UNTIL)
    expectCovered(data, list)
    // The oldest kept merge may be older than coveredSince only when the slice cut a window.
    expect(list.items.at(-1)!.mergedAt).toBeLessThan(UNTIL)
  })

  it('after the final slice, starts after the newest dropped merge', async () => {
    // Two windows of 700 each read in parallel (1,400 > cap of 3,000? no): force a slice with 3,100 read in windows below the limit.
    const data = evenly(3100, Date.UTC(2026, 9, 10), Date.UTC(2026, 9, 11))
    const list = await new GitHubCodeHost({ run: fakeGh(data).run, ...fakeClock() }).listMerged({ since: Date.UTC(2026, 9, 10), until: Date.UTC(2026, 9, 11), mine: false })
    expect(list.items).toHaveLength(3000)
    const dropped = [...data].sort((a, b) => b.mergedAt - a.mergedAt)[3000]!
    expect(list.coveredSince).toBeGreaterThanOrEqual(dropped.mergedAt + 1)
    const have = new Set(list.items.map((i) => i.number))
    expect(data.filter((d) => d.mergedAt >= list.coveredSince! && !have.has(d.number))).toEqual([])
  })

  it('equals until for a window that cannot be split', async () => {
    const hour = Date.UTC(2026, 9, 10, 8)
    const data = Array.from({ length: 1200 }, (_, i) => ({ number: i + 1, mergedAt: hour + Math.floor(i * 2.9) * 1000 }))
    const list = await new GitHubCodeHost({ run: fakeGh(data).run }).listMerged({ since: hour, until: hour + 3_600_000, mine: false })
    expect(list.truncated).toBe(true)
    expect(list.coveredSince).toBe(hour + 3_600_000)
  })

  it('stops at an interruption, keeps what was read and says how far it is certain', async () => {
    const data = evenly(2600)
    const f = fakeGh(data)
    const clock = fakeClock()
    let calls = 0
    const run = (async (c: string, args: string[]) => {
      if (++calls > 20) return { code: 1, stdout: '', stderr: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }
      return f.run(c, args)
    }) as CliRunner
    const list = await new GitHubCodeHost({ run, ...clock }).listMerged(query)
    expect(list.truncated).toBe(true)
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.interrupted).toEqual({ kind: 'rateLimited', message: 'You have exceeded a secondary rate limit. Please wait a few minutes.', retryAt: clock.now() + 5 * 60_000 })
    expectCovered(data, list)
    expect(list.coveredSince).toBeGreaterThan(SINCE)
  })

  it('throws rateLimited when nothing was read', async () => {
    const run: CliRunner = async () => ({ code: 1, stdout: '', stderr: 'You have exceeded a secondary rate limit' })
    const clock = fakeClock()
    await expect(new GitHubCodeHost({ run, ...clock }).listMerged(query)).rejects.toMatchObject({ kind: 'rateLimited', retryAt: clock.now() + 5 * 60_000 })
  })

  it('throws any other error as before', async () => {
    const run: CliRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' })
    await expect(new GitHubCodeHost({ run }).listMerged(query)).rejects.toMatchObject({ kind: 'failed' })
  })
})

describe('GitHub listMerged: 40 searches a minute', () => {
  it('lets 40 calls run at once and makes the 41st wait for the oldest to leave the minute', async () => {
    const clock = fakeClock()
    const f = fakeGh([])
    const host = new GitHubCodeHost({ run: f.run, ...clock })
    for (let i = 0; i < 40; i++) await host.listMerged(query)
    expect(clock.sleeps).toEqual([])
    await host.listMerged(query)
    expect(clock.sleeps).toEqual([60_000])
    expect(f.queries).toHaveLength(41)
  })

  it('counts a call again once its minute is over', async () => {
    const clock = fakeClock()
    const host = new GitHubCodeHost({ run: fakeGh([]).run, ...clock })
    for (let i = 0; i < 40; i++) await host.listMerged(query)
    clock.advance(60_001)
    await host.listMerged(query)
    expect(clock.sleeps).toEqual([])
  })

  it('does not count the calls that are not merged searches', async () => {
    const clock = fakeClock()
    const run: CliRunner = async () => ({ code: 0, stdout: JSON.stringify({ data: { search: { nodes: [] } } }), stderr: '' })
    const host = new GitHubCodeHost({ run, ...clock })
    for (let i = 0; i < 45; i++) await host.listAuthored({})
    expect(clock.sleeps).toEqual([])
  })
})

describe('GitHub rate limit', () => {
  const secondary = 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'

  it.each([
    ['secondary rate limit', secondary],
    ['API rate limit exceeded', 'HTTP 403: API rate limit exceeded for user ID 1.'],
    ['API rate limit already exceeded (GraphQL)', 'GraphQL: API rate limit already exceeded for user ID 1.'],
    ['rate limit exceeded', 'graphql: rate limit exceeded']
  ])('turns "%s" into a rateLimited error with GitHub\'s own text', async (_n, text) => {
    const run: CliRunner = async (_c, args) => (args.includes('rate_limit') ? { code: 1, stdout: '', stderr: 'no' } : { code: 1, stdout: '', stderr: text })
    const clock = fakeClock()
    const err = await new GitHubCodeHost({ run, ...clock }).listAuthored({}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodeHostError)
    expect(err).toMatchObject({ kind: 'rateLimited', message: text, retryAt: clock.now() + 5 * 60_000 })
  })

  it('answers every later call of the host at once without running gh, status excepted, until the time passes', async () => {
    const clock = fakeClock()
    let calls: string[][] = []
    let limited = true
    const run: CliRunner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'auth') return { code: 0, stdout: 'tok', stderr: '' }
      if (args.includes('user')) return { code: 0, stdout: 'ana', stderr: '' }
      return limited ? { code: 1, stdout: '', stderr: secondary } : { code: 0, stdout: JSON.stringify({ data: { search: { nodes: [] } } }), stderr: '' }
    }
    const host = new GitHubCodeHost({ run, ...clock })
    await expect(host.listAuthored({})).rejects.toMatchObject({ kind: 'rateLimited' })
    calls = []
    await expect(host.listReviewRequested({})).rejects.toMatchObject({ kind: 'rateLimited', message: secondary })
    await expect(host.listMerged(query)).rejects.toMatchObject({ kind: 'rateLimited' })
    await expect(host.merge({ provider: 'github', owner: 'acme', repo: 'api', number: 1, url: 'https://github.com/acme/api/pull/1' }, { method: 'squash', deleteBranch: false, branch: 'x' })).rejects.toMatchObject({ kind: 'rateLimited' })
    expect(calls).toEqual([])
    expect(await host.status()).toEqual({ state: 'ready', login: 'ana' })
    clock.advance(5 * 60_000)
    limited = false
    await expect(host.listAuthored({})).resolves.toEqual([])
    expect(calls.some((a) => a[0] === 'api' && a.includes('graphql'))).toBe(true)
  })

  it('reads the reset of the primary limit through gh api rate_limit: the later of graphql and search', async () => {
    const clock = fakeClock(Date.UTC(2026, 10, 1))
    const reset = (clock.now() + 20 * 60_000) / 1000
    const seen: string[][] = []
    const run: CliRunner = async (_c, args) => {
      seen.push(args)
      if (args.includes('rate_limit')) return { code: 0, stdout: JSON.stringify({ resources: { graphql: { reset: reset - 600 }, search: { reset } } }), stderr: '' }
      return { code: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded for user ID 1.' }
    }
    const host = new GitHubCodeHost({ run, ...clock })
    await expect(host.listAuthored({})).rejects.toMatchObject({ kind: 'rateLimited', retryAt: reset * 1000 })
    expect(seen.filter((a) => a.includes('rate_limit'))).toHaveLength(1)
    await expect(host.listAuthored({})).rejects.toMatchObject({ retryAt: reset * 1000 })
    expect(seen.filter((a) => a.includes('rate_limit'))).toHaveLength(1)
  })

  it('does not ask for the reset on a secondary limit', async () => {
    const seen: string[][] = []
    const run: CliRunner = async (_c, args) => {
      seen.push(args)
      return { code: 1, stdout: '', stderr: secondary }
    }
    await expect(new GitHubCodeHost({ run, ...fakeClock() }).listAuthored({})).rejects.toMatchObject({ kind: 'rateLimited' })
    expect(seen.some((a) => a.includes('rate_limit'))).toBe(false)
  })
})
