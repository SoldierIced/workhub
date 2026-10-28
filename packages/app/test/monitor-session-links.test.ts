import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  type PullRequestItem,
  type WorkhubConfig
} from '@workhub/core'
import { ClaudeTranscriptParser } from '@workhub/adapters/transcript-claude'
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
  const jira = keyProviders({ state: 'ready', provider: 'jira', projectKeys: ['PAY', 'WT'] })

  it('come from the branches it worked on, the name the user gave it and its prompts, with the tracker key patterns', () => {
    const work = sessionWork({
      items: [],
      repos: [
        { name: '.wt-loan-fix', root: '/w/.wt-loan-fix', branch: 'feat/pay-3619-membership-savings' },
        { name: 'wm-api', root: '/w/wm-api', branch: 'develop' },
        // Touched, but on a branch the session never committed to or pushed.
        { name: 'ms-pix', root: '/w/ms-pix', branch: 'hotfix_WT-8571_same-holder' }
      ],
      branches: [{ folder: '/w/.wt-loan-fix', pushed: true }, { folder: '/w/wm-api' }],
      titles: ['PAY-3797: saga stuck in pending reconciliation', undefined, 'OPS-9 not this profile'],
      mentionedTickets: ['PAY-1648', 'UTF-8'],
      providers: jira
    })
    expect(work.ticketKeys).toEqual(['PAY-3797', 'PAY-1648', 'PAY-3619'])
  })

  it('put the ticket the session created or changed first, then the typed ones, the main project before another team\'s', () => {
    // A real case: the session worked on another team's WT-8571, created PAY-3806 for it and linked them.
    const work = sessionWork({
      items: [],
      branches: [{ name: 'feat/WT-8571-block-same-holder-pix', pushed: true }],
      mentionedTickets: ['PAY-1648', 'WT-7828', 'PAY-3806', 'WT-8571'],
      linkedTickets: ['PAY-3806', 'WT-8571'],
      providers: jira
    })
    expect(work.ticketKeys).toEqual(['PAY-3806', 'WT-8571', 'PAY-1648', 'WT-7828'])
    // Without a link, the profile's first project (the tracker's key order) outranks a WT key typed later.
    const unlinked = sessionWork({ items: [], mentionedTickets: ['PAY-3806', 'WT-8571'], providers: jira })
    expect(unlinked.ticketKeys).toEqual(['PAY-3806', 'WT-8571'])
  })

  it('fall back to upper-case keys of any project without a tracker', () => {
    const work = sessionWork({ items: [], branches: [{ name: 'feature/ABC-12-login' }], titles: ['Fix UTF-8 in DEF-3'], providers: keyProviders(undefined) })
    expect(work.ticketKeys).toEqual(['DEF-3', 'ABC-12'])
  })
})

describe("the monitor's tickets and PRs of a real-shaped session", () => {
  // The synthetic transcript of the adapters' tests: 10 listed PRs, 20 searched tickets, one edited,
  // one branch committed and pushed, one PR created, in a folder whose branch is someone else's.
  const parser = new ClaudeTranscriptParser({ ticketPrefixes: ['ABC'], home: '/Users/ana' })
  for (const line of readFileSync(join(import.meta.dirname, '..', '..', 'adapters', 'test', 'fixtures', 'claude-scope', 'session.jsonl'), 'utf8').split('\n')) parser.ingest(line)
  const m = parser.snapshot()
  const pr = (repo: string, number: number, branch: string) =>
    ({ pr: { provider: 'github', owner: 'acme', repo, number, url: `https://github.com/acme/${repo}/pull/${number}`, branch, title: `ABC-${200 + number}`, state: 'open' }, ticketKeys: [], status: 'waiting', stale: false }) as unknown as PullRequestItem
  // The code host's lists: the 10 open PRs the session listed, the one it created, and one on the touched api's branch.
  const items = [...Array.from({ length: 10 }, (_, i) => pr('web', i + 1, `feat/ABC-${201 + i}-x`)), pr('web', 11, 'feat/ABC-101-login'), pr('api', 20, 'feat/ABC-900-other-work')]
  const repos = [
    { name: 'web', root: '/work/acme/web', branch: 'feat/ABC-101-login', slug: 'acme/web' },
    { name: 'api', root: '/work/acme/api', branch: 'feat/ABC-900-other-work', slug: 'acme/api' }
  ]
  const work = sessionWork({ items, links: m.pullRequestLinks, repos, mentionedTickets: m.ticketKeys, replyTickets: m.replyTicketKeys, linkedTickets: m.linkedTicketKeys, branches: m.branches, providers: keyProviders({ state: 'ready', provider: 'jira', projectKeys: ['ABC'] } as never) })

  it('show only the PR it created, not the 10 a listing printed or the open PR of a touched repository', () => {
    expect(work.prs.map((i) => i.pr.number)).toEqual([11])
  })

  it('show only the ticket it edited and the ones it worked on, not the 20 a search printed or a branch it never committed to', () => {
    expect(work.ticketKeys).toEqual(['ABC-305', 'ABC-101'])
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
