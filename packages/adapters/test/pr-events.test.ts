import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectPrEvents, loadMyPullRequests, loadReviewQueue, type PrProfileState, type PullRequest } from '@workhub/core'
import { createDemoRunner, GitHubCodeHost } from '../src/codehost-github'
import { mapSearchNode } from '../src/codehost-github/mapping'
import { JsonPrEventStore } from '../src/pr-events-json'

const NOW = Date.UTC(2026, 9, 27, 12)

describe('pull request comment counts', () => {
  const node = { number: 1, url: 'https://github.com/a/b/pull/1', repository: { name: 'b', owner: { login: 'a' } } }
  it('adds conversation comments and review threads', () => {
    expect(mapSearchNode({ ...node, comments: { totalCount: 3 }, reviewThreads: { totalCount: 2 } })?.commentCount).toBe(5)
    expect(mapSearchNode({ ...node, comments: { totalCount: 3 } })?.commentCount).toBe(3)
  })
  it('leaves the count undefined when the host reports neither', () => {
    expect(mapSearchNode(node)?.commentCount).toBeUndefined()
  })
})

/** Runs the real detector over the real GitHub adapter reading the demo `gh`, advancing the demo between syncs. */
describe('demo pull requests through the detector', () => {
  async function run() {
    let step = 0
    const host = new GitHubCodeHost({ run: createDemoRunner(NOW, () => step) })
    let state: PrProfileState | undefined
    return {
      advance: () => void step++,
      async sync() {
        const mine = (await loadMyPullRequests(host, {}, NOW)).map((i) => i.pr)
        const toReview = (await loadReviewQueue(host, {}, NOW)).map((i) => i.pr)
        const left: Record<string, PullRequest> = {}
        for (const url of Object.keys(state?.mine ?? {})) {
          if (mine.some((p) => p.url === url)) continue
          const ref = host.parseUrl(url)
          if (ref) left[url] = await host.detail(ref)
        }
        const result = detectPrEvents({ previous: state, mine, toReview, left, now: NOW })
        state = result.state
        return result.events
      }
    }
  }

  it('seeds on the first sync, then reports each demo step once', async () => {
    const demo = await run()
    expect(await demo.sync()).toEqual([])
    expect(await demo.sync()).toEqual([])

    demo.advance()
    const one = await demo.sync()
    expect(one.map((e) => [e.kind, e.name]).sort()).toEqual([
      ['approved', 'storefront#479'],
      ['ciFailed', 'storefront#482'],
      ['newCommits', 'storefront#482']
    ])
    expect(await demo.sync()).toEqual([])

    demo.advance()
    const two = await demo.sync()
    expect(two.map((e) => [e.kind, e.name]).sort()).toEqual([
      ['merged', 'billing-api#133'],
      ['reviewRequested', 'billing-api#490']
    ])
    expect(two.find((e) => e.kind === 'reviewRequested')?.actor).toBe('sam-okafor')

    demo.advance()
    const three = await demo.sync()
    expect(three.map((e) => [e.kind, e.name, e.count])).toEqual([['newComments', 'storefront#482', 2]])
    expect(await demo.sync()).toEqual([])
  })
})

describe('JsonPrEventStore', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })
  const tmp = async () => join((dir = await mkdtemp(join(tmpdir(), 'wh2-pr-events-'))), 'pr-events.json')

  it('loads an empty memory when there is no file', async () => {
    expect(await new JsonPrEventStore(await tmp()).load()).toEqual({ version: 1, profiles: {} })
  })

  it('round-trips the memory of several profiles', async () => {
    const store = new JsonPrEventStore(await tmp())
    const profile: PrProfileState = {
      mine: { u: { url: 'u', title: 't', name: 'r#1', decision: 'approved', ci: 'success', mergeable: 'mergeable', headSha: 'abc', commentCount: 2 } },
      requested: ['x'],
      seen: ['id1']
    }
    await store.save({ version: 1, profiles: { work: profile, home: { mine: {}, seen: [] } } })
    expect(await store.load()).toEqual({ version: 1, profiles: { work: profile, home: { mine: {}, seen: [] } } })
  })

  it('treats a corrupt, foreign or newer file as no memory, so the next sync only seeds', async () => {
    const path = await tmp()
    const store = new JsonPrEventStore(path)
    await writeFile(path, '{ not json')
    expect((await store.load()).profiles).toEqual({})
    await writeFile(path, JSON.stringify({ version: 2, profiles: { a: { mine: {}, seen: [] } } }))
    expect((await store.load()).profiles).toEqual({})
    await writeFile(path, JSON.stringify({ version: 1, profiles: { good: { mine: {}, seen: ['a', 3] }, bad: 'oops' } }))
    expect((await store.load()).profiles).toEqual({ good: { mine: {}, seen: ['a'] } })
  })

  it('writes the file atomically as JSON', async () => {
    const path = await tmp()
    await new JsonPrEventStore(path).save({ version: 1, profiles: {} })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, profiles: {} })
  })
})
