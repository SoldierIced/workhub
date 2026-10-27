import { describe, expect, it } from 'vitest'
import {
  applyDigest,
  autoCloseReason,
  buildPermalink,
  chatEventKey,
  chatMessage,
  claimEvent,
  closeFinished,
  EMPTY_CHAT_STATE,
  ingestRecord,
  isListening,
  listeningThreadsOf,
  newThread,
  parseDigest,
  parsePermalink,
  planWake,
  plainText,
  pruneLedger,
  pullRequestsIn,
  threadRows,
  threadTitle,
  trackPermalink,
  transferThreads,
  wakeText,
  watchPrompt,
  type ChatWatcherState,
  type TrackedThread
} from '../src'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
let n = 0
const newId = () => `t${++n}`

function thread(fields: Partial<TrackedThread> = {}): TrackedThread {
  return newThread({ id: 'th1', channelId: 'C01', ts: '1761566400.000100', permalink: 'https://acme.slack.com/archives/C01/p1761566400000100', title: 'Review please', source: 'hook', createdAt: NOW, ...fields })
}

describe('chat links', () => {
  it('reads a permalink, with and without a thread', () => {
    expect(parsePermalink('see https://acme.slack.com/archives/C0ABC/p1761566400000100 now')).toEqual({ host: 'acme.slack.com', channelId: 'C0ABC', ts: '1761566400.000100', rootTs: '1761566400.000100' })
    const reply = parsePermalink('https://acme.slack.com/archives/C0ABC/p1761566500000200?thread_ts=1761566400.000100&cid=C0ABC')
    expect(reply?.ts).toBe('1761566500.000200')
    expect(reply?.rootTs).toBe('1761566400.000100')
    expect(parsePermalink('https://example.com/x')).toBeNull()
    expect(buildPermalink('acme.slack.com', 'C0ABC', '1761566500.000200', '1761566400.000100')).toBe(
      'https://acme.slack.com/archives/C0ABC/p1761566500000200?thread_ts=1761566400.000100&cid=C0ABC'
    )
  })

  it('finds PR links inside Slack markup and words people and channels', () => {
    expect(pullRequestsIn('PR <https://github.com/Acme/web/pull/12|#12> and https://github.com/acme/web/pull/12/files')).toEqual(['https://github.com/acme/web/pull/12'])
    expect(plainText('<@U1|ana> in <#C2|reviews>: a &amp; b')).toBe('@ana in #reviews: a & b')
  })

  it('cuts long titles at a word boundary', () => {
    const title = threadTitle('word '.repeat(30))
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(81)
  })
})

describe('digest and prompt', () => {
  it('reads a lenient JSON answer with fences, prose and numbers', () => {
    const d = parseDigest('Here:\n```json\n{"channels":[{"id":"C01","messages":[{"ts":1761566400.0001,"user":"ana","text":"<https://github.com/acme/web/pull/3|PR> ABC-12","replyCount":"2"}]}],"threads":[],"me":"bob"}\n```')
    expect(d?.me).toBe('bob')
    expect(d?.channels[0]?.messages[0]).toMatchObject({ channelId: 'C01', user: 'ana', prUrls: ['https://github.com/acme/web/pull/3'], tickets: ['ABC-12'], replyCount: 2 })
    expect(parseDigest('no json')).toBeNull()
    expect(parseDigest('{"other":1}')).toBeNull()
  })

  it('asks for each channel after its cursor and each thread after its last reply, read-only', () => {
    const prompt = watchPrompt([{ id: 'C01', name: 'reviews', purpose: 'PR reviews' }], { C01: '1761566400.000100' }, [{ channelId: 'C01', ts: '1761566400.000100', lastSeenReplyTs: '1761566401.000000' }], NOW)
    expect(prompt).toContain('Use ONLY Slack read tools')
    expect(prompt).toContain('- C01 #reviews (PR reviews): after 1761566400.000100')
    expect(prompt).toContain('thread 1761566400.000100: after 1761566401.000000')
  })
})

describe('applying a read', () => {
  const msg = (ts: string, text = 'https://github.com/acme/web/pull/1', user = 'ana') => chatMessage({ channelId: 'C01', ts, user, text })

  it('learns on the first read without firing, then stores only what is newer than the cursor', () => {
    const first = applyDigest(EMPTY_CHAT_STATE, { channels: [{ id: 'C01', messages: [msg('100.000001')] }], threads: [], me: '' }, { channelIds: ['C01'] })
    expect(first.fresh).toEqual([])
    expect(first.state.seeded).toBe(true)
    expect(first.state.cursors['C01']).toBe('100.000001')
    const second = applyDigest(first.state, { channels: [{ id: 'C01', messages: [msg('100.000001'), msg('101.000001')] }], threads: [], me: '' }, { channelIds: ['C01'] })
    expect(second.fresh.map((m) => m.ts)).toEqual(['101.000001'])
    expect(second.state.messages['C01']?.map((m) => m.ts)).toEqual(['101.000001', '100.000001'])
  })

  it('ignores channels that are not watched and notifies about my PRs', () => {
    const seeded: ChatWatcherState = { ...EMPTY_CHAT_STATE, seeded: true }
    const r = applyDigest(seeded, { channels: [{ id: 'C09', messages: [msg('5.000001')] }, { id: 'C01', messages: [msg('6.000001')] }], threads: [], me: '' }, { channelIds: ['C01'], myPullRequests: new Set(['https://github.com/acme/web/pull/1']) })
    expect(r.fresh.map((m) => m.channelId)).toEqual(['C01'])
    expect(r.notices).toEqual([expect.objectContaining({ kind: 'myPullRequest', prUrl: 'https://github.com/acme/web/pull/1' })])
  })

  it('queues new replies of a listening thread for its owner, never the owner\'s own messages', () => {
    const t = thread({ owner: 's-old', wake: true, seeded: true, lastSeenReplyTs: '1761566400.000100', sentTs: ['1761566400.000200'] })
    const state: ChatWatcherState = { ...EMPTY_CHAT_STATE, seeded: true, threads: [t] }
    const r = applyDigest(state, { channels: [], threads: [{ channelId: 'C01', ts: t.ts, replies: [{ ts: '1761566400.000200', user: 'me-bot', text: 'own' }, { ts: '1761566400.000300', user: 'ana', text: 'looks good' }] }], me: '' }, { channelIds: [] })
    expect(r.replies).toBe(1)
    expect(r.state.threads[0]?.pendingWake.map((x) => x.text)).toEqual(['looks good'])
    // The same reply read again (a restart that lost nothing) is not queued twice.
    const again = applyDigest(r.state, { channels: [], threads: [{ channelId: 'C01', ts: t.ts, replies: [{ ts: '1761566400.000300', user: 'ana', text: 'looks good' }] }], me: '' }, { channelIds: [] })
    expect(again.replies).toBe(0)
    expect(again.state.threads[0]?.pendingWake).toHaveLength(1)
  })
})

describe('threads sessions start (the hook)', () => {
  it('follows the thread, owned by the sender, and keeps the first owner when another session writes in it', () => {
    const first = ingestRecord(EMPTY_CHAT_STATE, { sessionId: 'AAA', channelId: 'C01', ts: '200.000001', text: 'Please review https://github.com/acme/web/pull/7', cwd: '/tmp/sent-from', configDir: '/tmp/claude-a' }, { now: NOW, newId })
    const t = first.state.threads[0]!
    expect(t).toMatchObject({ owner: 'aaa', wake: true, prUrl: 'https://github.com/acme/web/pull/7', sentFromCwd: '/tmp/sent-from', source: 'hook' })
    expect(first.notice?.kind).toBe('tracking')
    const second = ingestRecord(first.state, { sessionId: 'BBB', channelId: 'C01', ts: '201.000001', threadTs: '200.000001', text: 'answer' }, { now: NOW, newId })
    expect(second.state.threads).toHaveLength(1)
    expect(second.state.threads[0]?.owner).toBe('aaa')
    expect(second.state.threads[0]?.sentTs).toEqual(['200.000001', '201.000001'])
  })

  it('leaves the threads of an automation that takes no replies unfollowed', () => {
    const r = ingestRecord(EMPTY_CHAT_STATE, { sessionId: 'auto-1', channelId: 'C01', ts: '1.000001' }, { now: NOW, newId, ignored: (id) => id === 'auto-1' })
    expect(r.state.threads).toEqual([])
  })

  it('tracks a pasted permalink once', () => {
    const r = trackPermalink(EMPTY_CHAT_STATE, { permalink: 'https://acme.slack.com/archives/C01/p1761566400000100', owner: 'x', wake: true }, NOW, newId)
    expect(r.thread).toMatchObject({ ts: '1761566400.000100', wake: true, seeded: true })
    expect(trackPermalink(r.state, { permalink: 'https://acme.slack.com/archives/C01/p1761566400000100' }, NOW, newId).error).toBe('alreadyTracked')
    expect(trackPermalink(r.state, { permalink: 'nope' }, NOW, newId).error).toBe('notAPermalink')
  })
})

describe('closing and grouping threads', () => {
  it('closes on a merged PR unless reopened or a reply waits, and after 7 idle days', () => {
    const t = thread({ prUrl: 'https://github.com/acme/web/pull/1', lastSeenReplyTs: String(NOW / 1000) })
    expect(autoCloseReason(t, 'merged', NOW)).toBe('prMerged')
    expect(autoCloseReason({ ...t, reopenedAt: NOW }, 'merged', NOW)).toBeNull()
    expect(autoCloseReason({ ...t, pendingWake: [{ ts: '1.1', user: 'a', text: 'b' }] }, 'merged', NOW)).toBeNull()
    expect(autoCloseReason(t, undefined, NOW + 8 * 86_400_000)).toBe('idle')
    const closed = closeFinished({ ...EMPTY_CHAT_STATE, threads: [t] }, new Map([['https://github.com/acme/web/pull/1', 'closed']]), NOW)
    expect(closed.threads[0]).toMatchObject({ closed: true, closedReason: 'prClosed' })
  })

  it('shows the threads of one PR as one row', () => {
    const pr = 'https://github.com/acme/web/pull/1'
    const rows = threadRows([thread({ id: 'a', prUrl: pr }), thread({ id: 'b' }), thread({ id: 'c', prUrl: `${pr}/files` })])
    expect(rows.map((r) => r.kind)).toEqual(['pullRequest', 'single'])
  })
})

describe('event ledger', () => {
  it('keys replies by their thread and claims an event once', () => {
    expect(chatEventKey('C01', '2.0', '1.0')).toBe('C01:1.0:2.0')
    expect(chatEventKey('C01', '1.0', '1.0')).toBe('C01:1.0')
    const a = claimEvent({}, 'C01:1.0', 'auto-a', NOW)
    expect(a.claimed).toBe(true)
    expect(claimEvent(a.ledger, 'C01:1.0', 'auto-b', NOW).claimed).toBe(false)
    expect(pruneLedger(a.ledger, NOW + 31 * 86_400_000)).toEqual({})
  })
})

describe('thread ownership and waking (Workhub 1 bugs)', () => {
  const sessions = [
    { id: 'ui-old', identity: 'old', state: 'stopped' as const, startedAt: 1 },
    { id: 'ui-new', identity: 'new', state: 'ready' as const, startedAt: 2 }
  ]

  it('bug 1: a reply after an automation replaced its session reaches exactly one session, the new one', () => {
    const threads = [thread({ id: 'a', owner: 'old', wake: true }), thread({ id: 'b', owner: 'other', wake: true }), thread({ id: 'c', owner: 'old', wake: true, closed: true })]
    const { threads: moved, moved: count } = transferThreads(threads, 'old', 'new', 'claude:work')
    expect(count).toBe(1)
    expect(listeningThreadsOf(moved, 'old')).toEqual([])
    expect(listeningThreadsOf(moved, 'new').map((t) => t.id)).toEqual(['a'])
    expect(moved.find((t) => t.id === 'c')?.owner).toBe('old')
    const plan = planWake(moved.find((t) => t.id === 'a')!, { sessions, now: NOW, transcriptCwd: '/tmp/project' })
    expect(plan).toEqual({ kind: 'deliver', sessionId: 'ui-new' })
  })

  it('bug 1: a second wake while the owner is opening waits instead of opening another copy', () => {
    const t = thread({ owner: 'old', wake: true })
    expect(planWake(t, { sessions, now: NOW, openingSince: NOW - 5_000, transcriptCwd: '/tmp/project' })).toEqual({ kind: 'wait', reason: 'opening' })
    expect(planWake(t, { sessions: [{ id: 'ui-x', identity: 'old', state: 'busy', startedAt: 3 }], now: NOW, transcriptCwd: '/tmp/project' })).toEqual({ kind: 'wait', reason: 'busy' })
  })

  it('bug 3: a wake reopens the owner in its transcript folder, never the folder the message was sent from', () => {
    const t = thread({ owner: 'gone', ownerAgentKey: 'claude', wake: true, sentFromCwd: '/tmp/somewhere-else' })
    expect(planWake(t, { sessions, now: NOW, transcriptCwd: '/tmp/acme-web' })).toEqual({ kind: 'reopen', identity: 'gone', cwd: '/tmp/acme-web', agentKey: 'claude' })
    // Without a transcript there is nothing to resume: the folder the message came from is not a fallback.
    expect(planWake(t, { sessions, now: NOW, transcriptCwd: null })).toEqual({ kind: 'missing' })
  })

  it('does not wake a blocked owner or one open elsewhere, and words the replies for the agent', () => {
    const t = thread({ owner: 'gone', wake: true })
    expect(planWake(t, { sessions, now: NOW, blocked: 'automationOff', transcriptCwd: '/x' })).toEqual({ kind: 'notifyOnly', reason: 'automationOff' })
    expect(planWake(t, { sessions, now: NOW, openElsewhere: 'transcriptRecent', transcriptCwd: '/x' })).toEqual({ kind: 'notifyOnly', reason: 'transcriptRecent' })
    expect(isListening(t)).toBe(true)
    expect(wakeText(t, [{ ts: '1.0', user: 'ana', text: '<@U1|bob> ok' }])).toContain('ana: @bob ok')
  })
})
