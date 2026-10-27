import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_CHAT_STATE, emptyConfig, newThread, type ChatWatcherState, type WorkhubConfig } from '@workhub/core'
import { SlackWatcherService, type SlackWatcherDeps } from '../src/main/slack-watcher'
import type { SessionView, StartSessionInput } from '../src/shared/api'
import type { ChatNoticeEvent } from '../src/shared/chat-api'

const OWNER = '0b6f5c1e-1111-4222-8333-944455556666'
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)

function view(fields: Partial<SessionView>): SessionView {
  return { id: 'ui-1', identity: OWNER, agentSessionId: OWNER, agentId: 'claude', accountId: 'main', profileId: 'acme', cwd: '/tmp/acme', state: 'starting', startedAt: NOW, agentName: 'Claude Code', adapter: 'native', ...fields } as SessionView
}

/** A watcher whose owner's transcript lives in a temporary Claude folder, with fake sessions. */
function setup(home: string) {
  const configDir = join(home, 'claude')
  mkdirSync(join(configDir, 'projects', '-tmp-acme'), { recursive: true })
  const transcript = join(configDir, 'projects', '-tmp-acme', `${OWNER}.jsonl`)
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: '/tmp/acme' })}\n`)
  // Written long ago: not "open in another terminal".
  utimesSync(transcript, new Date(NOW - 3_600_000), new Date(NOW - 3_600_000))
  const config = {
    ...emptyConfig(),
    activeProfileId: 'other',
    accounts: [{ id: 'main', agentId: 'claude', name: 'Main', configDir }]
  } as unknown as WorkhubConfig
  const state: ChatWatcherState = {
    ...EMPTY_CHAT_STATE,
    threads: [
      newThread({
        id: 'th1',
        channelId: 'C01',
        ts: '1761566400.000100',
        permalink: 'https://acme.slack.com/archives/C01/p1761566400000100',
        title: 'Review please',
        source: 'hook',
        createdAt: NOW,
        owner: OWNER,
        ownerAgentKey: 'claude:main',
        wake: true,
        seeded: true,
        pendingWake: [{ ts: '1761566500.000100', user: 'ana', text: 'done, have a look' }]
      })
    ]
  }
  const views: SessionView[] = []
  const starts: StartSessionInput[] = []
  const notices: ChatNoticeEvent[] = []
  let now = NOW
  const deps = {
    configuration: { current: async () => config },
    source: {},
    hook: { drain: async () => [] },
    demo: null,
    state: { load: () => state, save: () => undefined, flush: () => undefined },
    driver: { views: () => views, deliver: async () => 'waiting' as const },
    startSession: async (input: StartSessionInput) => {
      starts.push(input)
      // Starting takes a moment: a second caller arrives meanwhile.
      await new Promise((r) => setTimeout(r, 10))
      const v = view({ id: `ui-${starts.length}`, startedAt: now, profileId: input.profileId })
      views.push(v)
      return v
    },
    home,
    usage: () => [],
    myPullRequests: async () => new Set<string>(),
    prState: async () => undefined,
    emit: () => undefined,
    notice: (n: ChatNoticeEvent) => void notices.push(n),
    now: () => now
  } as unknown as SlackWatcherDeps
  return { watcher: new SlackWatcherService(deps), views, starts, notices, tick: (ms: number) => (now += ms) }
}

describe('waking a Slack thread owner', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'workhub-wake-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('opens one session when a wake and a click on "Open" reach the closed owner at once', async () => {
    const { watcher, starts } = setup(home)
    const [opened] = await Promise.all([watcher.openOwner('th1'), watcher.deliverPendingWakes(), watcher.openOwner('th1')])
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ resumeAgentSessionId: OWNER, cwd: '/tmp/acme', agentKey: 'claude:main' })
    expect(opened).toBe('ui-1')
  })

  it('reopens the owner in the profile it last ran in, so it keeps its sidebar place', async () => {
    const { watcher, views, starts } = setup(home)
    views.push(view({ id: 'ui-0', state: 'stopped', startedAt: NOW - 10_000, profileId: 'acme' }))
    await watcher.deliverPendingWakes()
    expect(starts).toHaveLength(1)
    expect(starts[0]?.profileId).toBe('acme')
  })

  it('does not open another chat on every pass when the session it opened failed', async () => {
    const { watcher, views, starts, notices, tick } = setup(home)
    await watcher.deliverPendingWakes()
    expect(starts).toHaveLength(1)
    // The resumed session errors out.
    views[0] = { ...views[0]!, state: 'error' }
    for (let i = 0; i < 5; i++) {
      tick(180_000)
      await watcher.deliverPendingWakes()
    }
    expect(starts).toHaveLength(1)
    expect(notices.filter((n) => n.kind === 'notWoken').map((n) => (n.kind === 'notWoken' ? n.reason : ''))).toEqual(['openFailed'])
  })
})
