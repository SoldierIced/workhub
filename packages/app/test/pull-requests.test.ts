import { describe, expect, it } from 'vitest'
import type { PullRequestItem } from '@workhub/core'
import { defaultFilter, findItem, initials, installUrl, loginCommand, parsePrWindowHash, prWindowHash, relativeTime, STATUS_META } from '../src/renderer/lib/pullRequests'
import { translate } from '../src/renderer/i18n/translate'

const item = (url: string): PullRequestItem => ({
  pr: { provider: 'github', owner: 'a', repo: 'b', number: 1, url, title: 't', author: 'x', branch: 'f', base: 'm', state: 'open', isDraft: false, reviewDecision: 'none', ci: 'none', mergeable: 'unknown', additions: 0, deletions: 0, changedFiles: 0 },
  status: 'waitingReview',
  stale: false,
  ticketKeys: []
})

describe('pull request window hash', () => {
  it('round-trips a profile and a URL with special characters', () => {
    const url = 'https://github.com/acme/api/pull/4?x=1&y=2'
    expect(parsePrWindowHash(prWindowHash('work profile', url))).toEqual({ profileId: 'work profile', url })
    expect(parsePrWindowHash(prWindowHash(null, url))).toEqual({ profileId: null, url })
  })
  it('ignores other hashes', () => {
    expect(parsePrWindowHash('')).toBeNull()
    expect(parsePrWindowHash('#settings')).toBeNull()
    expect(parsePrWindowHash('#pr?profile=x')).toBeNull()
  })
})

describe('list helpers', () => {
  it('starts on Mine only when nothing waits for review but something is mine', () => {
    expect(defaultFilter(undefined)).toBe('toReview')
    expect(defaultFilter({ mine: [item('a')], toReview: [] })).toBe('mine')
    expect(defaultFilter({ mine: [item('a')], toReview: [item('b')] })).toBe('toReview')
    expect(defaultFilter({ mine: [], toReview: [] })).toBe('toReview')
  })
  it('finds an item in either list', () => {
    const lists = { mine: [item('a')], toReview: [item('b')] }
    expect(findItem(lists, 'b')?.pr.url).toBe('b')
    expect(findItem(lists, 'zzz')).toBeUndefined()
  })
  it('gives CLI hints per host', () => {
    expect(loginCommand('glab')).toBe('glab auth login')
    expect(loginCommand('gh')).toBe('gh auth login')
    expect(installUrl('glab')).toContain('gitlab')
  })
  it('makes initials', () => {
    expect(initials('mira-kline')).toBe('MI')
    expect(initials('---')).toBe('?')
  })
  it('formats relative time in both languages', () => {
    const now = Date.UTC(2026, 9, 27, 12)
    expect(relativeTime(now - 3 * 3_600_000, now, 'en')).toBe('3 hours ago')
    expect(relativeTime(now - 3 * 3_600_000, now, 'es')).toBe('hace 3 horas')
    expect(relativeTime(now - 40 * 86_400_000, now, 'en')).toBe('last month')
    expect(relativeTime(now, now, 'en')).toBe('this minute')
  })
})

describe('status copy', () => {
  it('has English and Spanish text for every status', () => {
    for (const meta of Object.values(STATUS_META)) {
      expect(translate('en', meta.label)).not.toBe(meta.label)
      expect(translate('es', meta.label)).not.toBe(meta.label)
    }
  })
})
