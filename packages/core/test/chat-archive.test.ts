import { describe, expect, it } from 'vitest'
import {
  applyDigest,
  archivedThreadIds,
  DEFAULT_THREAD_ARCHIVE_MINUTES,
  EMPTY_CHAT_STATE,
  isListening,
  migrateConfig,
  msToTs,
  newThread,
  parseConfig,
  threadArchiveMinutes,
  type ChatWatcherState,
  type TrackedThread
} from '../src'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const MIN = 60_000

/** A thread of `owner` whose last activity was `quietFor` ms ago. */
function thread(id: string, owner: string | undefined, quietFor: number): TrackedThread {
  const at = NOW - quietFor
  const ts = msToTs(at)
  return newThread({ id, channelId: 'C01', ts, permalink: `https://acme.slack.com/archives/C01/p${ts.replace('.', '')}`, title: id, source: 'hook', createdAt: at, wake: true, seeded: true, ...(owner ? { owner } : {}) })
}

describe('archived Slack threads', () => {
  it('archives the quiet threads of a session past the threshold, never its most recent one', () => {
    const threads = [thread('old', 's1', 40 * MIN), thread('recent', 's1', 20 * MIN), thread('fresh', 's1', 5 * MIN)]
    expect([...archivedThreadIds(threads, NOW, 15)].sort()).toEqual(['old', 'recent'])
    // Under a longer threshold only the quietest goes.
    expect([...archivedThreadIds(threads, NOW, 30)]).toEqual(['old'])
  })

  it('keeps the most recent thread even when every thread of the session is quiet', () => {
    const threads = [thread('a', 's1', 90 * MIN), thread('b', 's1', 60 * MIN)]
    expect([...archivedThreadIds(threads, NOW, 15)]).toEqual(['a'])
  })

  it('never archives the only thread of a session, nor threads without a session', () => {
    const threads = [thread('alone', 's1', 300 * MIN), thread('x', undefined, 300 * MIN), thread('y', undefined, 300 * MIN), thread('other', 's2', 1 * MIN)]
    expect(archivedThreadIds(threads, NOW, 15).size).toBe(0)
  })

  it('a new reply un-archives the thread at once, and an archived thread is still watched and woken', () => {
    const state: ChatWatcherState = { ...EMPTY_CHAT_STATE, seeded: true, threads: [thread('old', 's1', 40 * MIN), thread('fresh', 's1', 5 * MIN)] }
    expect(archivedThreadIds(state.threads, NOW, 15).has('old')).toBe(true)
    // Archived is a view state: the thread still listens and goes in the next read.
    expect(isListening(state.threads[0]!)).toBe(true)
    const old = state.threads[0]!
    const r = applyDigest(state, { channels: [], threads: [{ channelId: 'C01', ts: old.ts, replies: [{ ts: msToTs(NOW - 1_000), user: 'ana', text: 'looks good' }] }], me: 'me' }, { channelIds: ['C01'], myPullRequests: new Set() })
    const after = r.state.threads.find((t) => t.id === 'old')!
    expect(after.pendingWake).toHaveLength(1)
    expect(archivedThreadIds(r.state.threads, NOW, 15).has('old')).toBe(false)
    // Now the other one is the quieter: still not archived because it is within the threshold.
    expect(archivedThreadIds(r.state.threads, NOW, 15).size).toBe(0)
  })

  it('counts a message the session sent as activity', () => {
    const old = { ...thread('old', 's1', 40 * MIN), sentTs: [msToTs(NOW - 2 * MIN)] }
    expect(archivedThreadIds([old, thread('fresh', 's1', 5 * MIN)], NOW, 15).size).toBe(0)
  })

  it('reads the per-profile threshold: 15 by default, at least 1, kept through the version 5 migration', () => {
    expect(DEFAULT_THREAD_ARCHIVE_MINUTES).toBe(15)
    expect(threadArchiveMinutes(undefined)).toBe(15)
    expect(threadArchiveMinutes({})).toBe(15)
    expect(threadArchiveMinutes({ slackArchiveMinutes: 0 })).toBe(1)
    expect(threadArchiveMinutes({ slackArchiveMinutes: 45 })).toBe(45)
    expect(migrateConfig({ version: 4, profiles: [{ id: 'p', name: 'P' }] })).toEqual({ version: 5, profiles: [{ id: 'p', name: 'P' }] })
    const parsed = parseConfig({ version: 4, profiles: [{ id: 'p', name: 'P' }, { id: 'q', name: 'Q', slackArchiveMinutes: 30 }] })
    expect(threadArchiveMinutes(parsed.profiles[0])).toBe(15)
    expect(parsed.profiles[1]?.slackArchiveMinutes).toBe(30)
    expect(() => parseConfig({ version: 5, profiles: [{ id: 'p', name: 'P', slackArchiveMinutes: 0 }] })).toThrow()
  })
})
