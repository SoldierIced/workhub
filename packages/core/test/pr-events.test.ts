import { describe, expect, it } from 'vitest'
import { appOptions, detectPrEvents, parseConfig, SEEN_LIMIT, MISS_LIMIT, snapshotOf, DEFAULT_PR_EVENT_TOGGLES, type PrProfileState, type PullRequest } from '../src'

const pr = (n: number, over: Partial<PullRequest> = {}): PullRequest => ({
  provider: 'github',
  owner: 'Acme',
  repo: 'api',
  number: n,
  url: `https://github.com/acme/api/pull/${n}`,
  title: `Change ${n}`,
  author: 'me',
  branch: 'feat',
  base: 'main',
  state: 'open',
  isDraft: false,
  reviewDecision: 'reviewRequired',
  ci: 'pending',
  mergeable: 'mergeable',
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  updatedAt: 1000,
  headSha: 'aaa111',
  commentCount: 2,
  ...over
})

const seeded = (mine: PullRequest[], requested: PullRequest[] = [], seen: string[] = []): PrProfileState => ({
  mine: Object.fromEntries(mine.map((p) => [p.url, snapshotOf(p)])),
  requested: requested.map((p) => p.url),
  seen
})

const sync = (previous: PrProfileState | undefined, mine?: PullRequest[], toReview?: PullRequest[], left: Record<string, PullRequest> = {}) =>
  detectPrEvents({ previous, mine, toReview, left, now: 5000 })

const kinds = (events: { kind: string }[]) => events.map((e) => e.kind).sort()

describe('detectPrEvents: seeding', () => {
  it('reports nothing on the first sync, however much is going on, and remembers the state', () => {
    const r = sync(undefined, [pr(1, { reviewDecision: 'approved', ci: 'failure', mergeable: 'conflicting' })], [pr(9, { author: 'sam' })])
    expect(r.events).toEqual([])
    expect(Object.keys(r.state.mine)).toEqual([pr(1).url])
    expect(r.state.requested).toEqual([pr(9).url])
  })

  it('does not report a request that was already waiting when the memory started', () => {
    const first = sync(undefined, [], [pr(9)])
    expect(sync(first.state, [], [pr(9)]).events).toEqual([])
  })

  it('still seeds the review queue silently when the first sync could not read it', () => {
    const first = sync(undefined, [pr(1)], undefined)
    expect(first.state.requested).toBeUndefined()
    const second = sync(first.state, [pr(1)], [pr(9), pr(10)])
    expect(second.events).toEqual([])
    expect(sync(second.state, [pr(1)], [pr(9), pr(10), pr(11)]).events.map((e) => e.kind)).toEqual(['reviewRequested'])
  })

  it('treats a PR first seen on a later sync as seed, not as an event', () => {
    const r = sync(seeded([pr(1)]), [pr(1), pr(2, { ci: 'failure', reviewDecision: 'approved' })], [])
    expect(r.events).toEqual([])
    expect(r.state.mine[pr(2).url]?.ci).toBe('failure')
  })
})

describe('detectPrEvents: each kind', () => {
  const base = pr(1)
  const prev = () => seeded([base], [])

  it('review requested: a PR newly waiting for my review, once', () => {
    const r = sync(prev(), [base], [pr(9, { author: 'sam' })])
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ kind: 'reviewRequested', actor: 'sam', name: 'api#9', url: pr(9).url })
    expect(sync(r.state, [base], [pr(9)]).events).toEqual([])
  })

  it('approved and changes requested follow the review decision', () => {
    expect(sync(prev(), [pr(1, { reviewDecision: 'approved' })], []).events[0]?.kind).toBe('approved')
    expect(sync(prev(), [pr(1, { reviewDecision: 'changesRequested' })], []).events[0]?.kind).toBe('changesRequested')
  })

  it('does not report a decision that went back to review required or none', () => {
    const approved = seeded([pr(1, { reviewDecision: 'approved' })])
    expect(sync(approved, [pr(1, { reviewDecision: 'reviewRequired' })], []).events).toEqual([])
    expect(sync(approved, [pr(1, { reviewDecision: 'none' })], []).events).toEqual([])
  })

  it('CI failed, and passed only when it was failing', () => {
    expect(sync(prev(), [pr(1, { ci: 'failure' })], []).events[0]?.kind).toBe('ciFailed')
    const failing = seeded([pr(1, { ci: 'failure' })])
    expect(sync(failing, [pr(1, { ci: 'success' })], []).events[0]?.kind).toBe('ciPassed')
    expect(sync(prev(), [pr(1, { ci: 'success' })], []).events).toEqual([])
  })

  it('conflicts appear once when the PR turns conflicting', () => {
    const r = sync(prev(), [pr(1, { mergeable: 'conflicting' })], [])
    expect(r.events.map((e) => e.kind)).toEqual(['conflicts'])
    expect(sync(r.state, [pr(1, { mergeable: 'conflicting' })], []).events).toEqual([])
  })

  it('new comments carry how many were added', () => {
    const r = sync(prev(), [pr(1, { commentCount: 5 })], [])
    expect(r.events[0]).toMatchObject({ kind: 'newComments', count: 3 })
    expect(sync(prev(), [pr(1, { commentCount: 1 })], []).events).toEqual([])
  })

  it('merged and closed come from the state read after the PR left the open list', () => {
    const merged = sync(prev(), [], [], { [base.url]: pr(1, { state: 'merged' }) })
    expect(merged.events.map((e) => e.kind)).toEqual(['merged'])
    expect(merged.state.mine[base.url]).toBeUndefined()
    const closed = sync(prev(), [], [], { [base.url]: pr(1, { state: 'closed' }) })
    expect(closed.events.map((e) => e.kind)).toEqual(['closed'])
  })

  it('reports several changes of one PR in one sync', () => {
    const r = sync(prev(), [pr(1, { reviewDecision: 'approved', ci: 'success', headSha: 'bbb222', commentCount: 3 })], [])
    expect(kinds(r.events)).toEqual(['approved', 'newCommits', 'newComments'].sort())
  })
})

describe('detectPrEvents: new commits', () => {
  const prev = () => seeded([pr(1, { headSha: 'aaa111' })])
  it('reports a moved head', () => {
    const r = sync(prev(), [pr(1, { headSha: 'bbb222' })], [])
    expect(r.events).toMatchObject([{ kind: 'newCommits', headSha: 'bbb222' }])
  })
  it('reports nothing for the same head', () => {
    expect(sync(prev(), [pr(1, { headSha: 'aaa111' })], []).events).toEqual([])
  })
  it('reports nothing when the head is missing now or was missing before, and seeds it', () => {
    expect(sync(prev(), [pr(1, { headSha: undefined })], []).events).toEqual([])
    const noHead = seeded([pr(1, { headSha: undefined })])
    const r = sync(noHead, [pr(1, { headSha: 'bbb222' })], [])
    expect(r.events).toEqual([])
    expect(r.state.mine[pr(1).url]?.headSha).toBe('bbb222')
  })
  it('seeds a comment count an older memory did not have instead of reading it as new comments', () => {
    const old = seeded([pr(1)])
    delete old.mine[pr(1).url]!.commentCount
    const r = sync(old, [pr(1, { commentCount: 40 })], [])
    expect(r.events).toEqual([])
    expect(r.state.mine[pr(1).url]?.commentCount).toBe(40)
  })
})

describe('detectPrEvents: memory', () => {
  it('handles an event once per profile: a replay with the same data reports nothing', () => {
    const prev = seeded([pr(1)])
    const first = sync(prev, [pr(1, { ci: 'failure' })], [])
    expect(first.events).toHaveLength(1)
    // The memory was lost between the notification and the save: the same change shows up again.
    const replay = sync({ ...prev, seen: first.state.seen }, [pr(1, { ci: 'failure' })], [])
    expect(replay.events).toEqual([])
  })

  it('gives the same event a different id for another head, so a later failure is reported', () => {
    const a = sync(seeded([pr(1, { headSha: 'a1' })]), [pr(1, { headSha: 'a1', ci: 'failure' })], [])
    const b = sync(seeded([pr(1, { headSha: 'b2' })], [], a.state.seen), [pr(1, { headSha: 'b2', ci: 'failure' })], [])
    expect(a.events[0]?.id).not.toBe(b.events[0]?.id)
    expect(b.events).toHaveLength(1)
  })

  it('keeps the memory of a list that could not be read', () => {
    const prev = seeded([pr(1)], [pr(9)])
    const r = sync(prev, undefined, undefined)
    expect(r.events).toEqual([])
    expect(r.state.mine).toEqual(prev.mine)
    expect(r.state.requested).toEqual(prev.requested)
  })

  it('keeps a vanished PR whose state could not be read, then forgets it', () => {
    let state = seeded([pr(1)])
    for (let i = 1; i < MISS_LIMIT; i++) {
      const r = sync(state, [], [])
      expect(r.events).toEqual([])
      expect(r.state.mine[pr(1).url]?.misses).toBe(i)
      state = r.state
    }
    expect(sync(state, [], []).state.mine[pr(1).url]).toBeUndefined()
  })

  it('does not forget a PR the host still says is open', () => {
    const r = sync(seeded([pr(1)]), [], [], { [pr(1).url]: pr(1) })
    expect(r.state.mine[pr(1).url]).toBeUndefined()
    expect(r.events).toEqual([])
  })

  it('caps the remembered ids, newest kept', () => {
    const seen = Array.from({ length: SEEN_LIMIT }, (_, i) => `old-${i}`)
    const r = sync(seeded([pr(1)], [], seen), [pr(1, { ci: 'failure' })], [])
    expect(r.state.seen).toHaveLength(SEEN_LIMIT)
    expect(r.state.seen.at(-1)).toBe(r.events[0]?.id)
    expect(r.state.seen[0]).toBe('old-1')
  })
})

describe('notification options', () => {
  it('defaults every kind, with CI passes and new commits off', () => {
    const options = appOptions({ options: undefined })
    expect(options.notifyPrEvents).toEqual(DEFAULT_PR_EVENT_TOGGLES)
    expect(options.notifyPrEvents.ciPassed).toBe(false)
    expect(options.notifyPrEvents.newCommits).toBe(false)
    expect(options.notifyPrEvents.approved).toBe(true)
  })
  it('fills the switches of a config saved before they existed', () => {
    const parsed = parseConfig({ version: 3, options: { claudePlanUsage: true, notifyReplied: false } })
    expect(parsed.options?.notifyReplied).toBe(false)
    expect(parsed.options?.notifyPrEvents).toEqual(DEFAULT_PR_EVENT_TOGGLES)
  })
  it('keeps a switch the user turned off', () => {
    const parsed = parseConfig({ options: { notifyPrEvents: { merged: false } } })
    expect(parsed.options?.notifyPrEvents.merged).toBe(false)
    expect(parsed.options?.notifyPrEvents.approved).toBe(true)
  })
})
