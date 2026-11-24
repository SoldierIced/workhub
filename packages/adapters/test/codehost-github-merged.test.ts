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
  it('halves a window that reports 1,000 or more and reads all of it, newest first, four searches at most at once', async () => {
    const data = evenly(2600)
    const f = fakeGh(data)
    const { items, truncated } = await new GitHubCodeHost({ run: f.run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(truncated).toBe(false)
    expect(items).toHaveLength(2600)
    expect(new Set(items.map((i) => i.url)).size).toBe(2600)
    expect(items.map((i) => i.mergedAt)).toEqual([...data].map((d) => d.mergedAt).sort((a, b) => b - a))
    expect(new Set(f.queries.map((q) => /merged:\S+/.exec(q)![0])).size).toBeGreaterThan(3)
    expect(f.peak()).toBeLessThanOrEqual(4)
    expect(f.peak()).toBeGreaterThan(1)
  })

  it('keeps the newest 3,000 and says truncated when there are more', async () => {
    const data = evenly(4600)
    const f = fakeGh(data)
    const { items, truncated } = await new GitHubCodeHost({ run: f.run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
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
