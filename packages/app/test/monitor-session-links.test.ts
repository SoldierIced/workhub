import { describe, expect, it } from 'vitest'
import {
  EMPTY_CHAT_STATE,
  chatMessage,
  emptyConfig,
  sessionSlackMessages,
  sessionWork,
  type ChatReadRequest,
  type ChatReadResult,
  type ChatWatcherState,
  type WorkhubConfig
} from '@workhub/core'
import { SlackWatcherService, type SlackWatcherDeps } from '../src/main/slack-watcher'
import { slackSetupHint } from '../src/renderer/lib/slackLinks'
import { keyProviders, trackerHint } from '../src/renderer/lib/tickets'

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)
const PR = 'https://github.com/acme/wallet/pull/66'
const ts = (minutesAgo: number) => `${Math.floor((NOW - minutesAgo * 60_000) / 1000)}.000100`

/** A watcher over a fake, read-only chat source that answers one digest and records what it was asked. */
function watcher(answer: ChatReadResult) {
  const requests: ChatReadRequest[] = []
  let state: ChatWatcherState = EMPTY_CHAT_STATE
  const config = {
    ...emptyConfig(),
    chatWatcher: { enabled: true, accountId: null, model: 'haiku', intervalMinutes: 10, startHour: 0, endHour: 24, weekdays: [0, 1, 2, 3, 4, 5, 6], usageThreshold: 85, channels: [{ id: 'C01', name: 'reviews', purpose: '' }] }
  } as unknown as WorkhubConfig
  // The port has one method, `read`: the fake would throw on anything else.
  const source = { provider: 'slack', read: async (r: ChatReadRequest) => (requests.push(r), answer) }
  const deps = {
    configuration: { current: async () => config },
    source,
    hook: { drain: async () => [] },
    demo: null,
    state: { load: () => state, save: (s: ChatWatcherState) => void (state = s), flush: () => undefined },
    driver: { views: () => [], deliver: async () => 'waiting' as const },
    startSession: async () => {
      throw new Error('no session starts here')
    },
    home: '/tmp',
    usage: () => [],
    myPullRequests: async () => new Set<string>(),
    prState: async () => undefined,
    emit: () => undefined,
    notice: () => undefined,
    now: () => NOW
  } as unknown as SlackWatcherDeps
  return { service: new SlackWatcherService(deps), requests }
}

describe("the monitor's Slack messages of a session", () => {
  it('keeps the read messages that link its PRs or name its tickets, newest first, from a mocked source', async () => {
    const messages = [
      chatMessage({ channelId: 'C01', ts: ts(50), user: 'ana', text: `please review <${PR}|wallet#66>` }),
      chatMessage({ channelId: 'C01', ts: ts(40), user: 'luis', text: 'PAY-3797 is blocked on QA' }),
      // Lower case, as a branch name pasted in a message: the generic stored pattern misses it.
      chatMessage({ channelId: 'C01', ts: ts(30), user: 'marta', text: 'merged feat/pay-3797-late-refund' }),
      chatMessage({ channelId: 'C01', ts: ts(20), user: 'pedro', text: 'PAY-1 is unrelated' }),
      chatMessage({ channelId: 'C01', ts: ts(10), user: 'pedro', text: 'lunch?' })
    ]
    const { service, requests } = watcher({ ok: true, digest: { channels: [{ id: 'C01', messages }], threads: [], me: 'me' }, deniedTools: [] })
    await service.runNow()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.channels.map((c) => c.id)).toEqual(['C01'])

    const snap = await service.snapshot()
    const found = sessionSlackMessages(snap.messages, [`${PR}/files`], ['PAY-3797'])
    expect(found.map((m) => m.user)).toEqual(['marta', 'luis', 'ana'])
    // Nothing to look for, nothing found; the limit keeps the latest.
    expect(sessionSlackMessages(snap.messages, [], [])).toEqual([])
    expect(sessionSlackMessages(snap.messages, [PR], ['PAY-3797', 'PAY-1'], 2).map((m) => m.user)).toEqual(['pedro', 'marta'])
  })

  it('shows nothing when the source could not read', async () => {
    const { service } = watcher({ ok: false, failure: 'noConnector', error: 'no Slack connector', deniedTools: [] })
    await service.runNow()
    expect(sessionSlackMessages((await service.snapshot()).messages, [PR], ['PAY-3797'])).toEqual([])
  })
})

describe("the session's ticket keys", () => {
  const jira = keyProviders({ state: 'ready', provider: 'jira', projectKeys: ['PAY', 'TEAM'] })

  it('come from the branches of every repo it worked in, its titles and its prompts, with the tracker key patterns', () => {
    const work = sessionWork({
      items: [],
      repos: [
        { name: '.wt-loan-fix', branch: 'feat/pay-3619-membership-savings' },
        { name: 'wm-api', branch: 'develop' },
        { name: 'ms-payments', branch: 'hotfix_TEAM-8571_same-holder' }
      ],
      titles: ['PAY-3797: saga stuck in pending reconciliation', undefined, 'OPS-9 not this profile'],
      mentionedTickets: ['PAY-1648', 'UTF-8'],
      providers: jira
    })
    // The main project's keys come first; WT is the tracker's second project.
    expect(work.ticketKeys).toEqual(['PAY-3619', 'PAY-3797', 'PAY-1648', 'TEAM-8571'])
  })

  it('put the ticket the session created or changed first, then the main project before another team\'s', () => {
    // A real case: the session worked on another team's TEAM-8571, created PAY-3806 for it and linked them.
    const work = sessionWork({
      items: [],
      repos: [{ name: 'ms-payments', branch: 'feat/TEAM-8571-block-same-holder-pix' }],
      mentionedTickets: ['PAY-1648', 'TEAM-7828', 'PAY-3806', 'TEAM-8571'],
      linkedTickets: ['PAY-3806', 'TEAM-8571'],
      providers: jira
    })
    expect(work.ticketKeys).toEqual(['PAY-3806', 'TEAM-8571', 'PAY-1648', 'TEAM-7828'])
    // Without a link, the profile's first project (the tracker's key order) outranks a WT branch.
    const unlinked = sessionWork({ items: [], repos: [{ name: 'ms-payments', branch: 'feat/TEAM-8571-block-same-holder-pix' }], mentionedTickets: ['PAY-3806'], providers: jira })
    expect(unlinked.ticketKeys).toEqual(['PAY-3806', 'TEAM-8571'])
  })

  it('fall back to upper-case keys of any project without a tracker', () => {
    const work = sessionWork({ items: [], repos: [{ name: 'api', branch: 'feature/ABC-12-login' }], titles: ['Fix UTF-8 in DEF-3'], providers: keyProviders(undefined) })
    expect(work.ticketKeys).toEqual(['ABC-12', 'DEF-3'])
  })
})

describe('the monitor hints', () => {
  it('say what to set up when the tracker cannot be read', () => {
    expect(trackerHint(undefined)).toBeNull()
    expect(trackerHint({ state: 'ready' })).toBeNull()
    expect(trackerHint({ state: 'demo' })).toBeNull()
    expect(trackerHint({ state: 'noConnection' })).toBe('connect')
    expect(trackerHint({ state: 'incomplete' })).toBe('complete')
    expect(trackerHint({ state: 'unsupported' })).toBe('unsupported')
  })

  it('say what to turn on when the Slack watcher cannot read, the profile first', () => {
    const on = { modules: { flows: false, health: false, chatWatcher: true, automations: false } }
    const off = { modules: { ...on.modules, chatWatcher: false } }
    const channels = [{ id: 'C01', name: 'reviews', purpose: '' }]
    expect(slackSetupHint(off, { enabled: true, channels })).toBe('module')
    expect(slackSetupHint(on, { enabled: false, channels })).toBe('watcher')
    expect(slackSetupHint(on, { enabled: true, channels: [] })).toBe('channels')
    expect(slackSetupHint(on, { enabled: true, channels })).toBeNull()
    expect(slackSetupHint(undefined, { enabled: true, channels })).toBeNull()
  })
})
