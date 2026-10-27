import { describe, expect, it } from 'vitest'
import { emptyConfig, type PrEventState, type PrEventStore, type PullRequest, type PullRequestItem, type WorkhubConfig } from '@workhub/core'
import { PrEventService, type PrEventSource } from '../src/main/pr-events-service'
import type { CodeHostLists } from '../src/shared/codehost-api'
import type { PrEventBatch } from '../src/shared/pr-events-api'

const pr = (n: number, over: Partial<PullRequest> = {}): PullRequest => ({
  provider: 'github',
  owner: 'acme',
  repo: 'api',
  number: n,
  url: `https://github.com/acme/api/pull/${n}`,
  title: `Change ${n}`,
  author: 'me',
  branch: 'f',
  base: 'main',
  state: 'open',
  isDraft: false,
  reviewDecision: 'reviewRequired',
  ci: 'pending',
  mergeable: 'mergeable',
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  headSha: 'aaa',
  commentCount: 0,
  ...over
})
const item = (p: PullRequest): PullRequestItem => ({ pr: p, status: 'waitingReview', stale: false, ticketKeys: [] })

function setup(opts: { demo?: boolean; profiles?: WorkhubConfig['profiles'] } = {}) {
  let lists: CodeHostLists = { state: 'ready', mine: [], toReview: [] }
  const states: Record<string, PullRequest> = {}
  const saved: PrEventState[] = []
  const batches: PrEventBatch[] = []
  let memory: PrEventState = { version: 1, profiles: {} }
  const store: PrEventStore = { load: async () => memory, save: async (s) => void (saved.push(s), (memory = s)) }
  const source: PrEventSource = { lists: async () => lists, stateOf: async (_p, url) => states[url] ?? null }
  const config: WorkhubConfig = {
    ...emptyConfig(),
    profiles: opts.profiles ?? [{ id: 'work', name: 'Work', connections: { codeHost: 'gh' }, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false } }],
    activeProfileId: 'work'
  }
  let step = 0
  const service = new PrEventService({
    source,
    store,
    config: async () => config,
    emit: (b) => batches.push(b),
    now: () => 9000,
    demo: opts.demo ? { advance: () => ++step } : undefined
  })
  return {
    service,
    batches,
    saved,
    states,
    set: (next: Partial<CodeHostLists>) => void (lists = { ...lists, ...next }),
    memory: () => memory
  }
}

describe('PrEventService', () => {
  it('seeds on the first sync and reports a change on the next', async () => {
    const t = setup()
    t.service.rendererReady()
    t.set({ mine: [item(pr(1))] })
    await t.service.sync()
    expect(t.batches).toEqual([])
    expect(Object.keys(t.memory().profiles['work']!.mine)).toHaveLength(1)

    t.set({ mine: [item(pr(1, { ci: 'failure' }))] })
    await t.service.sync()
    expect(t.batches).toHaveLength(1)
    expect(t.batches[0]).toMatchObject({ profileId: 'work', events: [{ kind: 'ciFailed', name: 'api#1' }] })
  })

  it('keeps events until the renderer listens, then delivers them once', async () => {
    const t = setup()
    t.set({ mine: [item(pr(1))] })
    await t.service.sync()
    t.set({ mine: [item(pr(1, { reviewDecision: 'approved' }))] })
    await t.service.sync()
    expect(t.batches).toEqual([])
    t.service.rendererReady()
    expect(t.batches).toHaveLength(1)
    t.service.rendererReady()
    expect(t.batches).toHaveLength(1)
  })

  it('reports nothing on a first sync, whatever state the pull requests are in (an upgrade never replays it)', async () => {
    const t = setup()
    t.service.rendererReady()
    t.set({ mine: [item(pr(1, { ci: 'failure', reviewDecision: 'approved' }))], toReview: [item(pr(9))] })
    await t.service.sync()
    expect(t.batches).toEqual([])
    expect(t.saved).toHaveLength(1)
  })

  it('resumes from the stored memory of an earlier run', async () => {
    const t = setup()
    t.set({ mine: [item(pr(1))] })
    await t.service.sync()
    const stored = t.memory()
    // Same store contents, new service instance.
    const batches: PrEventBatch[] = []
    const service = new PrEventService({
      source: { lists: async () => ({ state: 'ready', mine: [item(pr(1, { reviewDecision: 'changesRequested' }))], toReview: [] }), stateOf: async () => null },
      store: { load: async () => stored, save: async () => {} },
      config: async () => ({ ...emptyConfig(), profiles: [{ id: 'work', name: 'Work', connections: { codeHost: 'gh' }, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false } }] }),
      emit: (b) => batches.push(b)
    })
    service.rendererReady()
    await service.sync()
    expect(batches[0]?.events.map((e) => e.kind)).toEqual(['changesRequested'])
  })

  it('reads a merged pull request by URL when it leaves the open list', async () => {
    const t = setup()
    t.service.rendererReady()
    t.set({ mine: [item(pr(1)), item(pr(2))] })
    await t.service.sync()
    t.states[pr(2).url] = pr(2, { state: 'merged' })
    t.set({ mine: [item(pr(1))] })
    await t.service.sync()
    expect(t.batches[0]?.events.map((e) => [e.kind, e.name])).toEqual([['merged', 'api#2']])
  })

  it('skips the sync when the host is not ready or a list failed, keeping the memory', async () => {
    const t = setup()
    t.service.rendererReady()
    t.set({ mine: [item(pr(1))] })
    await t.service.sync()
    const before = t.memory()
    t.set({ state: 'signedOut', mine: [] })
    await t.service.sync()
    t.set({ state: 'ready', mine: [], message: 'rate limited' })
    await t.service.sync()
    expect(t.memory()).toBe(before)
    expect(t.batches).toEqual([])
  })

  it('syncs only profiles with a code host, and the active one in demo mode', async () => {
    const profiles = [
      { id: 'work', name: 'Work', connections: { codeHost: 'gh' }, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false } },
      { id: 'home', name: 'Home', connections: {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false } }
    ]
    const t = setup({ profiles })
    t.set({ mine: [item(pr(1))] })
    await t.service.sync()
    expect(Object.keys(t.memory().profiles)).toEqual(['work'])
    const demo = setup({ profiles, demo: true })
    demo.set({ mine: [item(pr(1))] })
    await demo.service.sync()
    expect(Object.keys(demo.memory().profiles)).toEqual(['work'])
  })

  it('moves the demo one step on and syncs, only in demo mode', async () => {
    expect(await setup().service.demoAdvance()).toBeNull()
    const t = setup({ demo: true })
    expect(await t.service.demoAdvance()).toBe(1)
    expect(await t.service.demoAdvance()).toBe(2)
  })

  it('shares one sync between calls made while it runs', async () => {
    const t = setup()
    t.set({ mine: [item(pr(1))] })
    await Promise.all([t.service.sync(), t.service.sync(), t.service.sync()])
    expect(t.saved).toHaveLength(1)
  })
})

