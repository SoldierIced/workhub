import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig, type WorkhubConfig } from '@workhub/core'
import { CliNotFoundError, type CliRunner } from '@workhub/adapters/cli'
import { REMOTE_INVOKES } from '../src/main/remote/allowlist'
import { CodeHostService, registerCodeHostIpc, validMergedRequest } from '../src/main/codehost'

const DAY = 86_400_000
const SINCE = Date.UTC(2026, 9, 1)
const UNTIL = Date.UTC(2026, 9, 31)
const REQUEST = { since: SINCE, until: UNTIL, mine: false }

interface Fake {
  repo: string
  number: number
  mergedAt: number
  author?: string
}

/** A fake `gh`: sign-in checks, and a merged search over `data` that honors `repo:`, `merged:` and `author:@me` like GitHub (1,000 reachable results per search). */
function fakeGh(data: Fake[] = []) {
  const calls: string[][] = []
  const state = { data, signedOut: false, missing: false, searchError: null as string | null, gate: null as Promise<void> | null }
  const run: CliRunner = async (_cmd, args) => {
    calls.push(args)
    if (state.missing) throw new CliNotFoundError('gh')
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' })
    if (args[0] === 'auth' && args[1] === 'token') return state.signedOut ? { code: 1, stdout: '', stderr: 'no token' } : ok('token-1\n')
    if (args[0] === 'api' && args.includes('user')) return ok('me\n')
    if (args[0] === 'api' && args.includes('graphql')) {
      await state.gate
      if (state.searchError) return { code: 1, stdout: '', stderr: state.searchError }
      const q = args.find((a) => a.startsWith('q='))!.slice(2)
      const repos = [...q.matchAll(/(?<![-\w])repo:(\S+)/g)].map((m) => m[1]!)
      const range = /merged:(\S+)\.\.(\S+)/.exec(q)!
      const [from, to] = [Date.parse(range[1]!), Date.parse(range[2]!)]
      const hits = state.data
        .filter((f) => repos.length === 0 || repos.includes(`acme/${f.repo}`))
        .filter((f) => f.mergedAt >= from && f.mergedAt <= to)
        .filter((f) => !q.includes('author:@me') || f.author === 'me')
        .sort((a, b) => b.mergedAt - a.mergedAt)
      const offset = Number(args.find((a) => a.startsWith('after='))?.slice(6) ?? 0)
      const more = offset + 100 < Math.min(hits.length, 1000)
      const nodes = hits.slice(offset, Math.min(offset + 100, 1000)).map((f) => ({
        number: f.number,
        title: `Change ${f.number}`,
        url: `https://github.com/acme/${f.repo}/pull/${f.number}`,
        mergedAt: new Date(f.mergedAt).toISOString(),
        headRefName: 'feat/x',
        baseRefName: 'main',
        author: { login: f.author ?? 'ana' },
        repository: { name: f.repo, owner: { login: 'acme' } }
      }))
      return ok(JSON.stringify({ data: { search: { issueCount: hits.length, pageInfo: { hasNextPage: more, endCursor: more ? String(offset + 100) : null }, nodes } } }))
    }
    return ok('')
  }
  const searches = () => calls.filter((c) => c.includes('graphql')).map((c) => c.find((a) => a.startsWith('q='))!.slice(2))
  return { run, calls, state, searches }
}

function setup(pullRequests?: { owners?: string[]; repos?: string[]; excludeRepos?: string[] }, scope = '', data: Fake[] = [{ repo: 'api', number: 1, mergedAt: SINCE + DAY }]) {
  const gh = fakeGh(data)
  const config = {
    ...emptyConfig(),
    activeProfileId: 'work',
    profiles: [{ id: 'work', name: 'Work', connections: { codeHost: 'gh' }, pullRequests }],
    connections: [{ id: 'gh', provider: 'github', settings: scope ? { scope } : {} }]
  } as unknown as WorkhubConfig
  const service = new CodeHostService(async () => config, { demo: false, run: gh.run })
  return { gh, service }
}

afterEach(() => vi.restoreAllMocks())

describe('CodeHostService.merged: scope', () => {
  it('reads the repositories allowlist, says so in the result and sends no author qualifier for everyone', async () => {
    const { service, gh } = setup({ repos: ['acme/api', 'acme/web', 'acme/docs'] })
    const result = await service.merged('work', REQUEST)
    expect(result).toMatchObject({ ok: true, provider: 'github', truncated: false, scope: { kind: 'repos', values: ['acme/api', 'acme/web', 'acme/docs'] } })
    expect(result.ok && result.items.map((i) => i.number)).toEqual([1])
    expect(gh.searches()).toEqual(['is:pr is:merged archived:false merged:2026-10-01T00:00:00Z..2026-10-30T23:59:59Z repo:acme/api repo:acme/web repo:acme/docs'])
  })

  it('splits many repositories into batches sized for the longer query and merges the answers', async () => {
    const repos = Array.from({ length: 12 }, (_, i) => `acme/service-number-${i}`)
    const { service, gh } = setup({ repos }, '', repos.map((r, i) => ({ repo: r.slice(5), number: i + 1, mergedAt: SINCE + (i + 1) * DAY })))
    const result = await service.merged('work', REQUEST)
    expect(gh.searches().length).toBeGreaterThan(1)
    for (const q of gh.searches()) expect(q.length).toBeLessThanOrEqual(256)
    expect(result.ok && result.items.map((i) => i.number)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
  })

  it('reads owners, the connection scope and says which', async () => {
    const owners = setup({ owners: ['acme', 'ana'] })
    expect(await owners.service.merged('work', REQUEST)).toMatchObject({ ok: true, scope: { kind: 'owners', values: ['acme', 'ana'] } })
    expect(owners.gh.searches()[0]).toContain('user:acme user:ana')
    const conn = setup(undefined, 'org:acme')
    expect(await conn.service.merged('work', REQUEST)).toMatchObject({ ok: true, scope: { kind: 'connection', values: ['org:acme'] } })
    expect(conn.gh.searches()[0]).toMatch(/org:acme$/)
  })

  it('never sends a search with exclusions alone when owners come with many hidden repositories', async () => {
    const hidden = Array.from({ length: 12 }, (_, i) => `acme/legacy-service-number-${i}`)
    const { service, gh } = setup({ owners: ['acme'], excludeRepos: hidden })
    expect((await service.merged('work', REQUEST)).ok).toBe(true)
    for (const q of gh.searches()) expect(q).toMatch(/user:acme/)
  })

  it('answers noScope for everyone when the owners are only GitLab-style group paths on GitHub', async () => {
    const { service, gh } = setup({ owners: ['acme/team'] })
    expect(await service.merged('work', REQUEST)).toMatchObject({ ok: false, state: 'noScope' })
    expect(gh.searches()).toEqual([])
  })

  it('answers noScope for everyone when the profile limits nothing, and reads only the own merges for mine', async () => {
    const { service, gh } = setup()
    expect(await service.merged('work', REQUEST)).toMatchObject({ ok: false, state: 'noScope' })
    expect(gh.searches()).toHaveLength(0)
    const mine = await service.merged('work', { ...REQUEST, mine: true })
    expect(mine).toMatchObject({ ok: true, scope: { kind: 'none', values: [] } })
    expect(gh.searches()[0]).toMatch(/archived:false merged:\S+ author:@me$/)
  })

  it('applies the profile filter: a hidden repository wins, and is not even searched when it is in the allowlist', async () => {
    const data = [
      { repo: 'api', number: 1, mergedAt: SINCE + DAY },
      { repo: 'web', number: 2, mergedAt: SINCE + 2 * DAY }
    ]
    const { service, gh } = setup({ repos: ['acme/api', 'acme/web'], excludeRepos: ['acme/web'] }, '', data)
    const result = await service.merged('work', REQUEST)
    expect(result.ok && result.items.map((i) => i.repo)).toEqual(['api'])
    expect(gh.searches()[0]).not.toContain('acme/web')
    // With owners the search is wider, so the filter does the hiding.
    const owners = setup({ owners: ['acme'], excludeRepos: ['acme/web'] }, '', data)
    const wide = await owners.service.merged('work', REQUEST)
    expect(wide.ok && wide.items.map((i) => i.repo)).toEqual(['api'])
  })

  it('keeps the newest 3,000 after merging the batches and says truncated', async () => {
    const data: Fake[] = Array.from({ length: 4000 }, (_, i) => ({ repo: i % 2 ? 'api' : 'web', number: i + 1, mergedAt: SINCE + Math.floor(((UNTIL - SINCE) * (i + 0.5)) / 4000 / 1000) * 1000 }))
    const { service } = setup({ repos: ['acme/api', 'acme/web'] }, '', data)
    const result = await service.merged('work', REQUEST)
    expect(result.ok && result.truncated).toBe(true)
    expect(result.ok && result.items).toHaveLength(3000)
    expect(result.ok && result.items[0]!.mergedAt).toBeGreaterThan(result.ok ? result.items[2999]!.mergedAt : 0)
  })
})

describe('CodeHostService.merged: states', () => {
  it('reports signed out, a missing CLI and a failed status like the lists', async () => {
    const out = setup({ repos: ['acme/api'] })
    out.gh.state.signedOut = true
    expect(await out.service.merged('work', REQUEST)).toMatchObject({ ok: false, state: 'signedOut' })
    const missing = setup({ repos: ['acme/api'] })
    missing.gh.state.missing = true
    expect(await missing.service.merged('work', REQUEST)).toMatchObject({ ok: false, state: 'missingCli' })
  })

  it('reports a search that fails as an error with the host text, and does not keep it', async () => {
    const { service, gh } = setup({ repos: ['acme/api'] })
    gh.state.searchError = 'HTTP 502: Bad Gateway'
    expect(await service.merged('work', REQUEST)).toMatchObject({ ok: false, state: 'error', error: expect.stringContaining('502') })
    gh.state.searchError = null
    expect(await service.merged('work', REQUEST)).toMatchObject({ ok: true })
  })

  it('reports a search that says the login is gone as signed out', async () => {
    const { service, gh } = setup({ repos: ['acme/api'] })
    gh.state.searchError = 'HTTP 401: Bad credentials'
    expect(await service.merged('work', REQUEST)).toMatchObject({ ok: false, state: 'signedOut' })
  })

  it('has no code host connected', async () => {
    const config = { ...emptyConfig() } as unknown as WorkhubConfig
    const service = new CodeHostService(async () => config, { demo: false, run: fakeGh().run })
    expect(await service.merged(null, REQUEST)).toMatchObject({ ok: false, state: 'notConnected' })
  })

  it('answers unsupported when the host cannot list merges', async () => {
    const { service } = setup({ repos: ['acme/api'] })
    const host = { provider: 'acme-host', parseUrl: () => null, status: async () => ({ state: 'ready', login: 'me' }) }
    vi.spyOn(service as unknown as { hostFor: () => unknown }, 'hostFor').mockReturnValue({ host, cli: 'x' })
    expect(await service.merged('work', REQUEST)).toMatchObject({ ok: false, state: 'unsupported' })
  })

  it('reads the demo host and marks the result as demo, with a scope so Everyone works', async () => {
    const service = new CodeHostService(async () => emptyConfig() as WorkhubConfig, { demo: true })
    const now = Date.now()
    const result = await service.merged(null, { since: now - 30 * DAY, until: now + DAY, mine: false })
    expect(result).toMatchObject({ ok: true, demo: true, scope: { kind: 'owners' } })
    expect(result.ok && result.items.length).toBeGreaterThan(10)
  })
})

describe('CodeHostService.merged: cache', () => {
  const setupRepos = () => setup({ repos: ['acme/api'] })

  it('serves the same request from the cache, and another request reads again', async () => {
    const { service, gh } = setupRepos()
    const first = await service.merged('work', REQUEST)
    expect(await service.merged('work', REQUEST)).toBe(first)
    expect(gh.searches()).toHaveLength(1)
    await service.merged('work', { ...REQUEST, mine: true })
    await service.merged('work', { ...REQUEST, since: SINCE - DAY })
    expect(gh.searches()).toHaveLength(3)
  })

  it('reads again when forced, and after ten minutes', async () => {
    const { service, gh } = setupRepos()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    await service.merged('work', REQUEST)
    await service.merged('work', REQUEST, true)
    expect(gh.searches()).toHaveLength(2)
    now.mockReturnValue(1_000_000 + 9 * 60_000)
    await service.merged('work', REQUEST)
    expect(gh.searches()).toHaveLength(2)
    now.mockReturnValue(1_000_000 + 11 * 60_000)
    await service.merged('work', REQUEST)
    expect(gh.searches()).toHaveLength(3)
  })

  it('keeps at most 20 reads', async () => {
    const { service, gh } = setupRepos()
    for (let i = 0; i < 21; i++) await service.merged('work', { ...REQUEST, since: SINCE - i * DAY })
    expect(gh.searches()).toHaveLength(21)
    await service.merged('work', { ...REQUEST, since: SINCE - 20 * DAY })
    expect(gh.searches()).toHaveLength(21)
    await service.merged('work', REQUEST)
    expect(gh.searches()).toHaveLength(22)
  })

  it('shares one read among callers that ask together; a forced one reads after it', async () => {
    const { service, gh } = setupRepos()
    let open!: () => void
    gh.state.gate = new Promise<void>((resolve) => (open = resolve))
    const a = service.merged('work', REQUEST)
    const b = service.merged('work', REQUEST)
    const forced = service.merged('work', REQUEST, true)
    await vi.waitFor(() => expect(gh.searches()).toHaveLength(1))
    open()
    const [ra, rb] = await Promise.all([a, b])
    expect(rb).toBe(ra)
    await forced
    expect(gh.searches()).toHaveLength(2)
  })

  it('drops the merged reads of the profile after a write', async () => {
    const { service, gh } = setupRepos()
    await service.merged('work', REQUEST)
    expect((await service.comment('work', 'https://github.com/acme/api/pull/1', 'hello')).ok).toBe(true)
    await service.merged('work', REQUEST)
    expect(gh.searches()).toHaveLength(2)
  })

  it('does not keep a read that was running when a write finished', async () => {
    const { service, gh } = setupRepos()
    let open!: () => void
    gh.state.gate = new Promise<void>((resolve) => (open = resolve))
    const reading = service.merged('work', REQUEST)
    await vi.waitFor(() => expect(gh.searches()).toHaveLength(1))
    gh.state.gate = null
    await service.comment('work', 'https://github.com/acme/api/pull/1', 'hello')
    open()
    await reading
    await service.merged('work', REQUEST)
    expect(gh.searches()).toHaveLength(2)
  })
})

describe('merged request validation', () => {
  it('accepts a period and rejects what is not one', () => {
    expect(validMergedRequest(REQUEST)).toEqual(REQUEST)
    expect(validMergedRequest({ since: SINCE, until: SINCE + 800 * DAY, mine: true })).not.toBeNull()
    for (const bad of [
      null,
      'x',
      {},
      { since: SINCE, until: UNTIL },
      { since: SINCE, until: UNTIL, mine: 'yes' },
      { since: '1', until: UNTIL, mine: false },
      { since: UNTIL, until: SINCE, mine: false },
      { since: SINCE, until: SINCE, mine: false },
      { since: NaN, until: UNTIL, mine: false },
      { since: SINCE, until: Infinity, mine: false },
      { since: -1, until: UNTIL, mine: false },
      { since: SINCE, until: SINCE + 801 * DAY, mine: false }
    ])
      expect(validMergedRequest(bad)).toBeNull()
  })

  it('the ipc handler refuses a bad request without reading, passes force only when true, and is not in the remote allowlist', async () => {
    const { service } = setup({ repos: ['acme/api'] })
    const merged = vi.spyOn(service, 'merged')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerCodeHostIpc({ handle: (c, l) => void handlers.set(c, (...a) => l({} as never, ...a)), on: () => undefined }, { service, openWindow: () => undefined, showInWorkhub: () => undefined, openExternal: async () => undefined })
    const handler = handlers.get('codeHost:merged')!
    expect('codeHost:merged' in REMOTE_INVOKES).toBe(false)
    expect(await handler('work', { since: 5, until: 1, mine: false })).toMatchObject({ ok: false, state: 'error' })
    expect(merged).not.toHaveBeenCalled()
    await handler('work', REQUEST, 'yes')
    expect(merged).toHaveBeenLastCalledWith('work', REQUEST, false)
    await handler('work', REQUEST, true)
    expect(merged).toHaveBeenLastCalledWith('work', REQUEST, true)
  })
})
