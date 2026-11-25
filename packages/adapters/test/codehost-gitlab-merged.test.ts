import { describe, expect, it } from 'vitest'
import { GitLabCodeHost } from '../src/codehost-gitlab'
import type { CliRunner } from '../src/shared/cli'

const DAY = 86_400_000
const SINCE = Date.UTC(2026, 9, 1)
const UNTIL = Date.UTC(2026, 9, 31)
const WEB = 'https://gitlab.com/acme-demo/team/shop/-/merge_requests'

const mr = (iid: number, mergedAt: number | null, over: Record<string, unknown> = {}) => ({
  iid,
  title: `Change ${iid}`,
  web_url: `${WEB}/${iid}`,
  state: 'merged',
  source_branch: `feat/c-${iid}`,
  target_branch: 'main',
  author: { username: 'ana' },
  created_at: new Date(SINCE).toISOString(),
  merged_at: mergedAt === null ? null : new Date(mergedAt).toISOString(),
  ...over
})

/** A fake `glab api`: pages of 100 over `all`, the user's login, and a record of every endpoint asked. */
function fakeGlab(all: unknown[]) {
  const calls: string[] = []
  const run = (async (_c: string, args: string[]) => {
    const endpoint = args.find((a) => /^(user|merge_requests|projects|groups)/.test(a)) ?? ''
    calls.push(endpoint)
    if (endpoint === 'user') return { code: 0, stdout: JSON.stringify({ username: 'me' }), stderr: '' }
    const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1)
    return { code: 0, stdout: JSON.stringify(all.slice((page - 1) * 100, page * 100)), stderr: '' }
  }) as CliRunner
  return { run, calls }
}

describe('GitLab listMerged', () => {
  it('maps merged requests without line or file counts, newest first, in the range only', async () => {
    const f = fakeGlab([mr(1, SINCE + DAY), mr(2, UNTIL + DAY), mr(3, SINCE + 5 * DAY), mr(4, SINCE - DAY), mr(5, null), mr(6, UNTIL - 1000)])
    const { items, truncated } = await new GitLabCodeHost({ run: f.run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(truncated).toBe(false)
    expect(items.map((i) => i.number)).toEqual([6, 3, 1])
    expect(items[2]).toMatchObject({ provider: 'gitlab', owner: 'acme-demo/team', title: 'Change 1', author: 'ana', branch: 'feat/c-1', base: 'main', mergedAt: SINCE + DAY, createdAt: SINCE })
    expect(items[2]!.additions).toBeUndefined()
    expect(items[2]!.deletions).toBeUndefined()
    expect(items[2]!.changedFiles).toBeUndefined()
  })

  it('asks for merged requests updated since the start, in the scope, with the login only when mine', async () => {
    const f = fakeGlab([])
    const host = new GitLabCodeHost({ run: f.run })
    await host.listMerged({ scope: 'project:acme-demo/team/shop', since: SINCE, until: UNTIL, mine: false })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toContain('projects/acme-demo%2Fteam%2Fshop/merge_requests?state=merged&scope=all&per_page=100')
    expect(f.calls[0]).toContain('updated_after=2026-10-01T00%3A00%3A00.000Z')
    expect(f.calls[0]).not.toContain('author_username')
    f.calls.length = 0
    await host.listMerged({ scope: 'group:acme-demo', since: SINCE, until: UNTIL, mine: true })
    expect(f.calls[0]).toBe('user')
    expect(f.calls[1]).toContain('groups/acme-demo/merge_requests?')
    expect(f.calls[1]).toContain('author_username=me')
  })

  it('pages 100 at a time and stops at 3,000 as truncated', async () => {
    const all = Array.from({ length: 3500 }, (_, i) => mr(i + 1, SINCE + DAY + i * 1000))
    const f = fakeGlab(all)
    const { items, truncated } = await new GitLabCodeHost({ run: f.run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(truncated).toBe(true)
    expect(items).toHaveLength(3000)
    expect(f.calls).toHaveLength(30)
  })

  it('stops on a short page and is not truncated', async () => {
    const f = fakeGlab(Array.from({ length: 250 }, (_, i) => mr(i + 1, SINCE + DAY + i * 1000)))
    const { items, truncated } = await new GitLabCodeHost({ run: f.run }).listMerged({ since: SINCE, until: UNTIL, mine: false })
    expect(items).toHaveLength(250)
    expect(truncated).toBe(false)
    expect(f.calls).toHaveLength(3)
  })

  it('reports a signed-out login', async () => {
    const run: CliRunner = async () => ({ code: 1, stdout: '', stderr: '401 Unauthorized' })
    await expect(new GitLabCodeHost({ run }).listMerged({ since: SINCE, until: UNTIL, mine: false })).rejects.toMatchObject({ kind: 'signedOut' })
  })
})
