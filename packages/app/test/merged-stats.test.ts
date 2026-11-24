// The Merged view's date logic runs in a zone with a DST change (US Eastern: clocks went forward on
// Sunday 2026-03-08, a 23-hour day). Set before anything reads a Date.
process.env.TZ = 'America/New_York'

import { describe, expect, it } from 'vitest'
import type { MergedPullRequest } from '@workhub/core'
import {
  addDays,
  averagePer,
  bucketItems,
  bucketRange,
  bucketStarts,
  byBranch,
  byRepo,
  countDays,
  coverage,
  customPeriod,
  dayStart,
  defaultGranularity,
  deltaVsPrevious,
  groupByDay,
  groupOf,
  keepSelection,
  leadDays,
  localDateValue,
  medianOf,
  mergedSeed,
  mondayOf,
  presentGroups,
  presetPeriod,
  previousSince,
  splitPeriods,
  totalsOf
} from '../src/renderer/lib/mergedStats'

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const HOUR = 3_600_000

function pr(n: number, mergedAt: number, extra: Partial<MergedPullRequest> = {}): MergedPullRequest {
  return { provider: 'github', owner: 'acme', repo: 'api', number: n, url: `https://github.com/acme/api/pull/${n}`, title: `PR ${n}`, author: 'ana', branch: 'feat', base: 'main', mergedAt, additions: 10, deletions: 2, changedFiles: 3, ...extra }
}

describe('the test zone', () => {
  it('really has the DST change the other tests rely on', () => {
    expect(new Date(2026, 2, 7, 12).getTimezoneOffset()).toBe(300)
    expect(new Date(2026, 2, 9, 12).getTimezoneOffset()).toBe(240)
    expect(local(2026, 3, 9) - local(2026, 3, 8)).toBe(23 * HOUR)
  })
})

describe('groupOf', () => {
  it('maps the base branch to its group', () => {
    expect(groupOf('main')).toBe('main')
    expect(groupOf('master')).toBe('master')
    for (const b of ['develop', 'dev', 'development']) expect(groupOf(b)).toBe('develop')
    for (const b of ['release/2.4', 'release/x/y', 'release-2.4']) expect(groupOf(b)).toBe('release')
    for (const b of ['releases', 'hotfix/a', 'feature/main', 'Main', 'release']) expect(groupOf(b)).toBe('other')
  })
})

describe('local days across the DST change', () => {
  it('adds calendar days, not 24 hours', () => {
    expect(addDays(local(2026, 3, 7), 1)).toBe(local(2026, 3, 8))
    expect(addDays(local(2026, 3, 8), 1)).toBe(local(2026, 3, 9))
    expect(dayStart(local(2026, 3, 8, 23, 59))).toBe(local(2026, 3, 8))
  })

  it('counts the 23-hour day as one day', () => {
    expect(countDays(local(2026, 3, 1), local(2026, 3, 15))).toBe(14)
    expect(countDays(local(2026, 3, 8), local(2026, 3, 9))).toBe(1)
  })

  it('takes the previous period as the same number of calendar days before, not the same milliseconds', () => {
    const p = { since: local(2026, 3, 9), until: local(2026, 3, 16) }
    expect(previousSince(p)).toBe(local(2026, 3, 2))
    // 7 x 24h before would land on Mar 1 23:00 (Mar 8 lost an hour): the bug this guards against.
    expect(p.since - 7 * 24 * HOUR).toBe(local(2026, 3, 1, 23))
  })

  it('presets are the last N local days, today included', () => {
    const now = local(2026, 3, 9, 10, 30)
    const p = presetPeriod(7, now)
    expect(p.since).toBe(local(2026, 3, 3))
    expect(p.until).toBe(local(2026, 3, 10))
    expect(countDays(p.since, p.until)).toBe(7)
  })

  it('puts a merge at 23:30 and one at 00:30 in different day buckets, and keeps the DST day whole', () => {
    const p = { since: local(2026, 3, 6), until: local(2026, 3, 11) }
    const items = [pr(1, local(2026, 3, 7, 23, 30)), pr(2, local(2026, 3, 8, 0, 30)), pr(3, local(2026, 3, 8, 23, 30)), pr(4, local(2026, 3, 9, 0, 5))]
    const b = bucketItems(items, ['main'], p, 'day')
    expect(b.map((x) => x.total)).toEqual([0, 1, 2, 1, 0])
    expect(b.map((x) => x.start)).toEqual([6, 7, 8, 9, 10].map((d) => local(2026, 3, d)))
  })

  it('splits the current and the previous period across the change', () => {
    const p = { since: local(2026, 3, 8), until: local(2026, 3, 15) }
    const items = [pr(1, local(2026, 3, 1)), pr(2, local(2026, 3, 8) - 1), pr(3, local(2026, 3, 8)), pr(4, local(2026, 3, 15) - 1), pr(5, local(2026, 3, 15)), pr(6, local(2026, 2, 28, 23, 59))]
    const { current, previous } = splitPeriods(items, p)
    expect(current.map((i) => i.number)).toEqual([3, 4])
    expect(previous.map((i) => i.number)).toEqual([1, 2])
  })
})

describe('weeks and month boundaries', () => {
  it('weeks start on Monday, including across the DST change', () => {
    expect(mondayOf(local(2026, 3, 8, 12))).toBe(local(2026, 3, 2)) // Sunday
    expect(mondayOf(local(2026, 3, 9, 0, 1))).toBe(local(2026, 3, 9)) // Monday
    expect(mondayOf(local(2026, 3, 15, 23, 59))).toBe(local(2026, 3, 9))
  })

  it('lists every week of a period over a month boundary, the first one starting on its Monday', () => {
    const p = { since: local(2026, 2, 25), until: local(2026, 3, 12) }
    expect(bucketStarts(p, 'week')).toEqual([local(2026, 2, 23), local(2026, 3, 2), local(2026, 3, 9)])
    expect(bucketStarts(p, 'day')).toHaveLength(15)
    expect(bucketStarts(p, 'day')[4]).toBe(local(2026, 3, 1))
  })

  it('clamps a week to the period for its label', () => {
    const p = { since: local(2026, 2, 25), until: local(2026, 3, 12) }
    expect(bucketRange(local(2026, 2, 23), 'week', p)).toEqual({ from: local(2026, 2, 25), to: local(2026, 3, 1) })
    expect(bucketRange(local(2026, 3, 9), 'week', p)).toEqual({ from: local(2026, 3, 9), to: local(2026, 3, 11) })
    expect(bucketRange(local(2026, 3, 1), 'day', p)).toEqual({ from: local(2026, 3, 1), to: local(2026, 3, 1) })
  })

  it('counts per week and group, and sums the lines that were reported', () => {
    const p = { since: local(2026, 3, 2), until: local(2026, 3, 16) }
    const items = [pr(1, local(2026, 3, 8, 22)), pr(2, local(2026, 3, 9, 1), { base: 'develop' }), pr(3, local(2026, 3, 10), { base: 'develop', additions: undefined, deletions: undefined })]
    const b = bucketItems(items, ['main', 'develop'], p, 'week')
    expect(b.map((x) => x.values)).toEqual([[1, 0], [0, 2]])
    expect(b.map((x) => [x.additions, x.deletions])).toEqual([[10, 2], [10, 2]])
  })

  it('starts in weeks over 45 days', () => {
    expect(defaultGranularity(30)).toBe('day')
    expect(defaultGranularity(45)).toBe('day')
    expect(defaultGranularity(46)).toBe('week')
    expect(defaultGranularity(90)).toBe('week')
  })

  it('keeps the groups present in their fixed order', () => {
    expect(presentGroups([pr(1, 1, { base: 'hotfix/x' }), pr(2, 1, { base: 'release/2.4' }), pr(3, 1, { base: 'main' })])).toEqual(['main', 'release', 'other'])
  })
})

describe('custom range', () => {
  it('includes the last day and allows at most 366 days', () => {
    const ok = customPeriod('2026-03-01', '2026-03-14')
    expect(ok).toEqual({ period: { since: local(2026, 3, 1), until: local(2026, 3, 15) } })
    expect('period' in customPeriod('2025-03-10', '2026-03-10')).toBe(true) // 366 days
    expect(customPeriod('2025-03-09', '2026-03-10')).toEqual({ error: 'tooLong' }) // 367
    expect(customPeriod('2026-03-14', '2026-03-01')).toEqual({ error: 'order' })
    expect(customPeriod('', '2026-03-01')).toEqual({ error: 'incomplete' })
    expect(customPeriod('2026-02-30', '2026-03-01')).toEqual({ error: 'incomplete' })
  })

  it('round-trips a local date', () => {
    expect(localDateValue(local(2026, 3, 8, 23, 59))).toBe('2026-03-08')
  })
})

describe('totals with lines and files not reported', () => {
  it('does not turn missing numbers into zeros (GitLab)', () => {
    const items = [pr(1, 1, { additions: undefined, deletions: undefined, changedFiles: undefined }), pr(2, 2, { additions: undefined, deletions: undefined, changedFiles: undefined })]
    const t = totalsOf(items)
    expect(t).toMatchObject({ count: 2, additions: 0, deletions: 0, withLines: 0, files: 0, withFiles: 0 })
    expect(coverage(t.count, t.withLines)).toBe('none')
    expect(averagePer(t.additions + t.deletions, t.withLines)).toBeNull()
  })

  it('sums the items that report them when only some do, and says how many do not', () => {
    const items = [pr(1, 1, { additions: 100, deletions: 20, changedFiles: 4 }), pr(2, 2, { additions: undefined, deletions: undefined, changedFiles: undefined }), pr(3, 3, { additions: 0, deletions: 0, changedFiles: 0 })]
    const t = totalsOf(items)
    expect(t).toMatchObject({ count: 3, additions: 100, deletions: 20, withLines: 2, files: 4, withFiles: 2 })
    expect(coverage(t.count, t.withLines)).toBe('partial')
    expect(averagePer(120, t.withLines)).toBe(60)
  })

  it('treats a real zero as reported', () => {
    expect(coverage(1, totalsOf([pr(1, 1, { additions: 0, deletions: 0 })]).withLines)).toBe('all')
  })

  it('computes the median and the slowest open → merged, ignoring PRs without a creation time', () => {
    const day = 86_400_000
    const items = [pr(1, 10 * day, { createdAt: 9 * day }), pr(2, 10 * day, { createdAt: 7 * day }), pr(3, 10 * day, { createdAt: 0 }), pr(4, 10 * day)]
    const t = totalsOf(items)
    expect(t.leadMedianDays).toBe(3) // 1, 3, 10
    expect(t.leadMaxDays).toBe(10)
    expect(leadDays(items[3]!)).toBeNull()
    expect(medianOf([])).toBeNull()
    expect(medianOf([1, 2, 3, 4])).toBe(2.5)
  })

  it('shows no delta when the search was cut', () => {
    expect(deltaVsPrevious(10, 4, false)).toBe(6)
    expect(deltaVsPrevious(3, 4, false)).toBe(-1)
    expect(deltaVsPrevious(10, 4, true)).toBeNull()
  })
})

describe('tables', () => {
  const items = [pr(1, 1, { base: 'release/2.4' }), pr(2, 2, { base: 'release/2.5' }), pr(3, 3, { base: 'release/2.5' }), pr(4, 4, { base: 'main', repo: 'web' }), pr(5, 5, { base: 'hotfix/x' })]

  it('lists a group per row in a fixed order, with each release branch under release/* when there are several', () => {
    expect(byBranch(items).map((r) => r.key)).toEqual(['main', 'release', 'release:release/2.5', 'release:release/2.4', 'other'])
    expect(byBranch(items.slice(0, 1)).map((r) => r.key)).toEqual(['release'])
    expect(byBranch(items).find((r) => r.key === 'release')!.count).toBe(3)
  })

  it('lists repositories as owner/repo, most merged first', () => {
    expect(byRepo(items).map((r) => [r.key, r.count])).toEqual([['acme/api', 4], ['acme/web', 1]])
  })
})

describe('list helpers', () => {
  it('groups consecutive items by local day', () => {
    const items = [pr(1, local(2026, 3, 9, 20)), pr(2, local(2026, 3, 9, 1)), pr(3, local(2026, 3, 8, 23))]
    expect(groupByDay(items).map((g) => [g.start, g.items.length])).toEqual([[local(2026, 3, 9), 2], [local(2026, 3, 8), 1]])
  })

  it('keeps a selection only while its PR is listed', () => {
    const a = pr(1, 1)
    expect(keepSelection(a.url, [a])).toBe(a.url)
    expect(keepSelection(a.url, [pr(2, 2)])).toBeNull()
    expect(keepSelection(null, [a])).toBeNull()
  })

  it('shows a merged PR as a merged pull request while its detail loads', () => {
    const s = mergedSeed(pr(1, 5, { additions: undefined, changedFiles: undefined }))
    expect(s).toMatchObject({ state: 'merged', additions: 0, changedFiles: 0, updatedAt: 5, base: 'main' })
  })
})
