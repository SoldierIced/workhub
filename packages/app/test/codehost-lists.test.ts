import { describe, expect, it, vi } from 'vitest'
import type { GitRunner } from '@workhub/adapters/git-review'
import type { CodeHost, CodeHostStatus, PullRequest, WorkhubConfig } from '@workhub/core'
import { CodeHostService } from '../src/main/codehost'

const pr: PullRequest = {
  provider: 'github',
  owner: 'acme',
  repo: 'api',
  number: 1,
  url: 'https://github.com/acme/api/pull/1',
  title: 'Change',
  author: 'me',
  branch: 'feat',
  base: 'main',
  state: 'open',
  isDraft: false,
  reviewDecision: 'reviewRequired',
  ci: 'success',
  mergeable: 'mergeable',
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  updatedAt: Date.now()
}

const config = {
  activeProfileId: 'work',
  profiles: [{ id: 'work', name: 'Work', connections: { codeHost: 'gh' } }],
  connections: [{ id: 'gh', provider: 'github', settings: {} }]
} as unknown as WorkhubConfig

function setup(initial: CodeHostStatus) {
  const state = { status: initial }
  const host = {
    provider: 'github',
    capabilities: {},
    status: async () => state.status,
    listAuthored: async () => [pr],
    listReviewRequested: async () => []
  } as unknown as CodeHost
  const service = new CodeHostService(async () => config, { demo: false })
  ;(service as unknown as { hostFor: () => unknown }).hostFor = () => ({ host, cli: 'gh' })
  return { service, state }
}

describe('CodeHostService.lists on a transient status failure', () => {
  it('keeps the last good lists next to the error', async () => {
    const { service, state } = setup({ state: 'ready', login: 'me' })
    const good = await service.lists('work', true)
    expect(good.mine).toHaveLength(1)
    state.status = { state: 'error', message: 'network unreachable' }
    const bad = await service.lists('work', true)
    expect(bad).toMatchObject({ state: 'error', message: 'network unreachable', login: 'me', updatedAt: good.updatedAt })
    expect(bad.mine).toHaveLength(1)
    // The error is not cached: the next call asks again and recovers.
    state.status = { state: 'ready', login: 'me' }
    expect((await service.lists('work')).state).toBe('ready')
  })

  it('has nothing to keep before the first good read', async () => {
    const { service } = setup({ state: 'error', message: 'network unreachable' })
    expect(await service.lists('work', true)).toMatchObject({ state: 'error', mine: [], toReview: [] })
  })

  it('still empties the lists when signed out', async () => {
    const { service, state } = setup({ state: 'ready', login: 'me' })
    await service.lists('work', true)
    state.status = { state: 'signedOut', cli: 'gh' }
    expect(await service.lists('work', true)).toMatchObject({ state: 'signedOut', mine: [], toReview: [] })
  })
})

describe("CodeHostService scope from the profile's folders", () => {
  it("reads the folders' remotes on the host the profile runs on", async () => {
    const withFolders = {
      activeProfileId: 'work',
      profiles: [{ id: 'work', name: 'Work', connections: { codeHost: 'gh' }, folders: ['/w/acme/api'] }],
      connections: [{ id: 'gh', provider: 'github', settings: {} }]
    } as unknown as WorkhubConfig
    const git: GitRunner = vi.fn(async () => ({ ok: true, stdout: 'git@github.com:acme/api.git\n', stderr: '' }))
    const targets: unknown[] = []
    const scopes: string[] = []
    const host = {
      provider: 'github',
      capabilities: {},
      status: async () => ({ state: 'ready', login: 'me' }),
      listAuthored: async (q: { scope: string }) => (scopes.push(q.scope), []),
      listReviewRequested: async () => []
    } as unknown as CodeHost
    const service = new CodeHostService(async () => withFolders, { demo: false, hostFor: (t) => (targets.push(t), { git }) })
    ;(service as unknown as { hostFor: () => unknown }).hostFor = () => ({ host, cli: 'gh' })
    await service.lists('work', true)
    expect(targets).toEqual([{ profileId: 'work' }])
    expect(git).toHaveBeenCalledWith('/w/acme/api', ['remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
    expect(scopes[0]).toContain('acme/api')
  })
})
