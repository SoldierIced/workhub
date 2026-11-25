import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig, type WorkhubConfig } from '@workhub/core'
import type { CliRunner } from '@workhub/adapters/cli'
import { CodeHostService } from '../src/main/codehost'

const urlOf = (n: number, repo = 'api') => `https://github.com/acme/${repo}/pull/${n}`

interface PrData {
  author: string
  mergeable: string
  title: string
}

/** A fake `gh` that answers like the real one and records every call. */
function fakeGh() {
  const calls: string[][] = []
  const state = {
    authors: {} as Record<string, string>,
    mergeable: 'MERGEABLE',
    title: 'Change',
    listed: [] as { repo: string; number: number; author: string }[],
    /** While set, `pr view` and the searches wait for it. */
    gateView: null as Promise<void> | null,
    gateSearch: null as Promise<void> | null,
    searchError: null as string | null
  }
  const pr = (n: number): PrData => ({ author: state.authors[String(n)] ?? 'someone', mergeable: state.mergeable, title: state.title })
  const run: CliRunner = async (_cmd, args) => {
    calls.push(args)
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' })
    const key = args.slice(0, 2).join(' ')
    if (key === 'auth token') return ok('token-1\n')
    if (args[0] === 'api' && args.includes('user')) return ok('me\n')
    if (args[0] === 'api' && args.includes('graphql')) {
      const title = state.title
      await state.gateSearch
      if (state.searchError) return { code: 1, stdout: '', stderr: state.searchError }
      const nodes = state.listed.map((l) => ({ number: l.number, url: urlOf(l.number, l.repo), title, state: 'OPEN', author: { login: l.author }, repository: { name: l.repo, owner: { login: 'acme' } } }))
      return ok(JSON.stringify({ data: { search: { nodes, pageInfo: { hasNextPage: false } } } }))
    }
    if (key === 'pr view') {
      await state.gateView
      const n = Number(/\/pull\/(\d+)/.exec(args[2]!)![1])
      const d = pr(n)
      return ok(JSON.stringify({ number: n, title: d.title, url: args[2], author: { login: d.author }, state: 'OPEN', mergeable: d.mergeable, headRefName: 'feat', baseRefName: 'main' }))
    }
    if (args[0] === 'api' && args.includes('--paginate')) return ok('[]')
    if (key === 'pr diff') return ok('')
    if (key === 'repo view') return ok(JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false }))
    return ok('')
  }
  const count = (...words: string[]) => calls.filter((c) => words.every((w, i) => c[i] === w)).length
  const graphqlQueries = () => calls.filter((c) => c.includes('graphql')).map((c) => c.find((a) => a.startsWith('q='))!.slice(2))
  return { run, calls, state, count, graphqlQueries }
}

function setup(pullRequests?: { owners?: string[]; repos?: string[]; excludeRepos?: string[] }) {
  const gh = fakeGh()
  const config = { ...emptyConfig(), activeProfileId: 'work', profiles: [{ id: 'work', name: 'Work', connections: { codeHost: 'gh' }, pullRequests }], connections: [{ id: 'gh', provider: 'github', settings: {} }] } as unknown as WorkhubConfig
  const changed = vi.fn()
  const service = new CodeHostService(async () => config, { demo: false, run: gh.run, onChanged: changed })
  return { gh, service, changed }
}

afterEach(() => vi.restoreAllMocks())

describe('pull request reads', () => {
  it('reads pr view once for A, B, A within a minute and never runs the diff for a detail', async () => {
    const { service, gh } = setup()
    for (const n of [1, 2, 1]) expect((await service.detail('work', urlOf(n))).ok).toBe(true)
    expect(gh.count('pr', 'view')).toBe(2)
    expect(gh.count('pr', 'diff')).toBe(0)
    expect((await service.diff('work', urlOf(1))).ok).toBe(true)
    expect(gh.count('pr', 'diff')).toBe(1)
  })

  it('reads the detail again after a minute', async () => {
    const { service, gh } = setup()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    await service.detail('work', urlOf(1))
    now.mockReturnValue(1_000_000 + 61_000)
    await service.detail('work', urlOf(1))
    expect(gh.count('pr', 'view')).toBe(2)
  })

  it('reads the host again for a fresh detail (Refresh) even with a copy kept', async () => {
    const { service, gh } = setup()
    await service.detail('work', urlOf(1))
    await service.detail('work', urlOf(1), true)
    expect(gh.count('pr', 'view')).toBe(2)
  })

  it('does not keep a detail that was being read when a write happened', async () => {
    const { service, gh } = setup()
    let release!: () => void
    gh.state.gateView = new Promise<void>((r) => (release = r))
    const first = service.detail('work', urlOf(1))
    await vi.waitFor(() => expect(gh.count('pr', 'view')).toBe(1))
    expect(await service.comment('work', urlOf(1), 'hello')).toEqual({ ok: true })
    gh.state.gateView = null
    release()
    expect((await first).ok).toBe(true)
    await service.detail('work', urlOf(1))
    expect(gh.count('pr', 'view')).toBe(2)
  })
})

describe('sign-in', () => {
  it('checks the login once for ten list reads', async () => {
    const { service, gh } = setup()
    const now = vi.spyOn(Date, 'now')
    let t = 1_000_000
    for (let i = 0; i < 10; i++) {
      now.mockReturnValue((t += 31_000))
      expect((await service.lists('work')).state).toBe('ready')
    }
    expect(gh.count('api', 'user')).toBe(1)
    expect(gh.count('auth', 'token')).toBe(1)
  })

  it('reports signed out when a search fails with a gh auth message', async () => {
    const { service, gh } = setup()
    expect((await service.lists('work')).state).toBe('ready')
    gh.state.searchError = 'To get started with GitHub CLI, please run:  gh auth login'
    expect(await service.lists('work', true)).toMatchObject({ state: 'signedOut', mine: [], toReview: [] })
  })
})

describe('lists coalescing', () => {
  it('gives a forced caller the read after the one running and does not delay a plain caller', async () => {
    const { service, gh } = setup()
    gh.state.listed = [{ repo: 'api', number: 1, author: 'me' }]
    let release!: () => void
    gh.state.gateSearch = new Promise<void>((r) => (release = r))
    const first = service.lists('work')
    await vi.waitFor(() => expect(gh.graphqlQueries().length).toBeGreaterThan(0))
    // The host changes while the first read is under way (a write finished).
    gh.state.title = 'After the write'
    const forced = service.lists('work', true)
    const plain = service.lists('work')
    gh.state.gateSearch = null
    release()
    const [a, b] = await Promise.all([first, plain])
    expect(b).toBe(a)
    expect(a.mine[0]!.pr.title).toBe('Change')
    expect((await forced).mine[0]!.pr.title).toBe('After the write')
  })

  it('does not keep lists read before a write', async () => {
    const { service, gh } = setup()
    gh.state.listed = [{ repo: 'api', number: 1, author: 'me' }]
    let release!: () => void
    gh.state.gateSearch = new Promise<void>((r) => (release = r))
    const running = service.lists('work')
    await vi.waitFor(() => expect(gh.graphqlQueries().length).toBeGreaterThan(0))
    await service.comment('work', urlOf(1), 'hello')
    gh.state.gateSearch = null
    release()
    await running
    expect(await service.cachedLists('work')).toBeNull()
  })
})

describe('writes', () => {
  it('keeps the last good lists when the read after a write fails', async () => {
    const { service, gh } = setup()
    gh.state.listed = [{ repo: 'api', number: 7, author: 'someone' }]
    expect((await service.lists('work')).toReview).toHaveLength(1)
    await service.comment('work', urlOf(7), 'hello')
    gh.state.searchError = 'HTTP 502: server error'
    const after = await service.lists('work')
    expect(after.toReview.map((i) => i.pr.number)).toEqual([7])
  })

  it('asks the host who is signed in before a write that depends on whose PR it is', async () => {
    const { service, gh } = setup()
    gh.state.listed = [{ repo: 'api', number: 7, author: 'someone' }]
    await service.lists('work')
    const before = gh.count('auth', 'token')
    await service.review('work', urlOf(7), 'approve', '')
    expect(gh.count('auth', 'token')).toBe(before + 1)
  })

  it('approves with one write and no pr view when the author is known from the lists', async () => {
    const { service, gh, changed } = setup()
    gh.state.listed = [{ repo: 'api', number: 7, author: 'someone' }]
    await service.lists('work')
    const before = gh.calls.length
    expect(await service.review('work', urlOf(7), 'approve', '')).toEqual({ ok: true })
    const added = gh.calls.slice(before)
    expect(added.map((c) => c.slice(0, 2).join(' '))).toEqual(['auth token', 'pr review'])
    expect(changed).toHaveBeenCalledWith(urlOf(7), 'work')
  })

  it('reads the author once when it is not known, and still refuses to approve one\'s own PR', async () => {
    const { service, gh } = setup()
    gh.state.authors['3'] = 'me'
    const r = await service.review('work', urlOf(3), 'approve', '')
    expect(r).toMatchObject({ ok: false, kind: 'unsupported' })
    expect(gh.count('pr', 'view')).toBe(1)
    expect(gh.count('pr', 'review')).toBe(0)
  })

  it('merges with the cached detail when it says mergeable, and reads again when it does not', async () => {
    const mergeable = setup()
    await mergeable.service.detail('work', urlOf(1))
    expect(await mergeable.service.merge('work', urlOf(1), 'squash', false)).toMatchObject({ ok: true })
    expect(mergeable.gh.count('pr', 'view')).toBe(1)
    expect(mergeable.gh.count('pr', 'merge')).toBe(1)

    const unknown = setup()
    unknown.gh.state.mergeable = 'UNKNOWN'
    await unknown.service.detail('work', urlOf(1))
    unknown.gh.state.mergeable = 'MERGEABLE'
    expect(await unknown.service.merge('work', urlOf(1), 'squash', false)).toMatchObject({ ok: true })
    expect(unknown.gh.count('pr', 'view')).toBe(2)
  })

  it('keeps the merge methods of a repository between merge dialogs', async () => {
    const { service, gh } = setup()
    await service.mergeMethods('work', urlOf(1))
    await service.mergeMethods('work', urlOf(2))
    expect(gh.count('repo', 'view')).toBe(1)
  })
})

describe('repositories allowlist', () => {
  it('searches with repo: qualifiers only, owners and excluded repositories aside', async () => {
    const { service, gh } = setup({ owners: ['other'], repos: ['acme/api', 'acme/web'], excludeRepos: ['acme/web'] })
    gh.state.listed = [
      { repo: 'api', number: 1, author: 'me' },
      { repo: 'cli', number: 2, author: 'me' }
    ]
    const lists = await service.lists('work')
    const queries = gh.graphqlQueries()
    expect(queries).toHaveLength(2)
    for (const q of queries) {
      expect(q).toContain('repo:acme/api')
      expect(q).not.toContain('acme/web')
      expect(q).not.toContain('user:')
    }
    expect(lists.mine.map((i) => i.pr.repo)).toEqual(['api'])
  })

  it('splits fifty repositories into parallel batches', async () => {
    const repos = Array.from({ length: 50 }, (_, i) => `acme/service-number-${i}`)
    const { service, gh } = setup({ repos })
    await service.lists('work')
    const queries = gh.graphqlQueries()
    // Two searches (mine, to review) per batch.
    expect(queries.length).toBeGreaterThanOrEqual(4)
    expect(queries.length % 2).toBe(0)
    const seen = new Set(queries.flatMap((q) => [...q.matchAll(/repo:(\S+)/g)].map((m) => m[1]!)))
    expect([...seen].sort()).toEqual([...repos].sort())
    for (const q of queries) expect(q.replace(/^is:pr is:open archived:false (?:author|review-requested):@me /, '').length).toBeLessThanOrEqual(200)
  })
})
