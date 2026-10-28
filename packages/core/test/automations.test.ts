import { describe, expect, it } from 'vitest'
import {
  AutomationEngine,
  chatMessage,
  chatTriggers,
  createGroup,
  EMPTY_CHAT_STATE,
  EMPTY_SESSION_GROUPS,
  evaluatePendingGate,
  fillFromPreset,
  groupOf,
  ingestRecord,
  limitWait,
  listeningThreadsOf,
  moveToGroup,
  newAutomation,
  prReviewsPreset,
  reconcileTop,
  replaceSessionIdentity,
  transferThreads,
  usageDelta,
  usageOfSnapshot,
  windowReason,
  type AutomationDefinition,
  type AutomationHost,
  type AutomationNotice,
  type AutomationsState,
  type ChatWatcherState,
  type DrivenSession,
  type SessionGroups
} from '../src'

// A Tuesday, 10:00 local time: inside the default window.
const T0 = new Date(2026, 9, 27, 10, 0, 0).getTime()

class FakeWorld implements AutomationHost {
  time = T0
  ids = 0
  defs: AutomationDefinition[] = []
  live: DrivenSession[] = []
  delivered: { sessionId: string; text: string }[] = []
  stopped: string[] = []
  forgotten: string[] = []
  notices: AutomationNotice[] = []
  saved: AutomationsState | null = null
  groups: SessionGroups = EMPTY_SESSION_GROUPS
  chat: ChatWatcherState = EMPTY_CHAT_STATE
  inactiveProfiles = new Set<string>()
  usage: number | null = null
  budget: { window: string; resetsAt?: number } | null = null
  gate: unknown = undefined
  clears = true

  now = () => this.time
  newId = () => `id${++this.ids}`
  definitions = () => this.defs
  isActive = (a: AutomationDefinition) => !a.profileId || !this.inactiveProfiles.has(a.profileId)
  usagePercent = () => this.usage
  budgetPaused = () => this.budget
  clearsContext = () => this.clears
  readGate = async () => this.gate
  replaceIdentity = async (oldKey: string, newKey: string) => {
    this.groups = replaceSessionIdentity(this.groups, oldKey, newKey)
  }
  transferThreads = (oldKey: string, newKey: string, agentKey: string) => {
    const r = transferThreads(this.chat.threads, oldKey, newKey, agentKey)
    this.chat = { ...this.chat, threads: r.threads }
    return r.moved
  }
  listeningThreads = (identity: string) => listeningThreadsOf(this.chat.threads, identity).length
  notify = (n: AutomationNotice) => void this.notices.push(n)
  persist = (s: AutomationsState) => void (this.saved = s)
  sessions = {
    list: () => this.live,
    start: async (_a: AutomationDefinition, previous?: string) => {
      const n = ++this.ids
      const s: DrivenSession = { id: `ui-${n}`, identity: previous ?? `s${n}`, state: 'ready', turnsEnded: 0 }
      this.live.push(s)
      return s
    },
    deliver: async (sessionId: string, text: string) => {
      const s = this.live.find((x) => x.id === sessionId)!
      this.delivered.push({ sessionId, text })
      s.state = 'busy'
      return 'delivered' as const
    },
    interrupt: async () => undefined,
    stop: async (sessionId: string) => {
      this.stopped.push(sessionId)
      const s = this.live.find((x) => x.id === sessionId)
      if (s) s.state = 'stopped'
    },
    forget: async (sessionId: string) => {
      this.forgotten.push(sessionId)
      this.live = this.live.filter((x) => x.id !== sessionId)
    }
  }

  /** The agent finishes its turn in every busy session. */
  endTurns(): void {
    for (const s of this.live) if (s.state === 'busy') Object.assign(s, { state: 'ready', turnsEnded: s.turnsEnded + 1 })
  }
}

const prMessage = (ts: string, channelId = 'C01', user = 'ana') => chatMessage({ channelId, ts, user, text: `please review https://github.com/acme/web/pull/${ts.split('.')[0]}` })

function setup(fields: Partial<AutomationDefinition> = {}) {
  const world = new FakeWorld()
  world.defs = [newAutomation('a1', { name: 'Reviews', prompt: '/review', agentKey: 'shell', triggers: { chatChannelIds: ['C01'], prOwner: '', intervalMinutes: null }, ...fields })]
  const engine = new AutomationEngine(world)
  return { world, engine }
}

async function runOnce(world: FakeWorld, engine: AutomationEngine): Promise<void> {
  await engine.tick()
  world.endTurns()
  world.time += 2_000
  await engine.tick()
}

describe('rules', () => {
  it('knows the window, the sliding and daily limits and the preset', () => {
    const w = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 19 }
    expect(windowReason(w, T0)).toBeNull()
    expect(windowReason(w, new Date(2026, 9, 27, 20).getTime())).toBe('hours')
    expect(windowReason(w, new Date(2026, 9, 25, 10).getTime())).toBe('days')
    const starts = [T0 - 4 * 60_000, T0 - 60_000]
    expect(limitWait(starts, { maxRuns: 2, perMinutes: 5, maxPerDay: null }, T0)).toEqual({ reason: 'window', until: T0 + 60_000 })
    expect(limitWait(starts, { maxRuns: 9, perMinutes: 5, maxPerDay: 2 }, T0)?.reason).toBe('day')
    const preset = prReviewsPreset('p', { profileId: null, agentKey: 'claude', folder: '~/w', channels: [{ id: 'C1', name: 'general', purpose: '' }, { id: 'C2', name: 'pr-reviews', purpose: '' }], scope: 'org:acme' })
    expect(preset.triggers).toMatchObject({ chatChannelIds: ['C2'], prOwner: 'acme' })
    expect(preset.sessionPolicy).toBe('newEachRun')
  })

  it('reads the pending-work gate without a model call', () => {
    expect(evaluatePendingGate(undefined, T0).reason).toBe('missing')
    expect(evaluatePendingGate({ requests: { a: { status: 'done' } } }, T0).actionable).toBe(false)
    expect(evaluatePendingGate({ pendingRequests: [{ reason: 'head-moved' }] }, T0)).toMatchObject({ actionable: true, queued: 1 })
    expect(evaluatePendingGate({ requests: { a: { status: 'claimed', claimedAt: new Date(T0 - 2 * 3_600_000).toISOString() } } }, T0).staleClaims).toBe(1)
  })

  it('fires only on top-level PR messages from others, of the owner when set', () => {
    const defs = [newAutomation('a', { triggers: { chatChannelIds: ['C01'], prOwner: 'acme', intervalMinutes: null } })]
    const msgs = [prMessage('1.000001'), { ...prMessage('2.000001'), threadTs: '1.000001' }, prMessage('3.000001', 'C01', 'me'), chatMessage({ channelId: 'C01', ts: '4.000001', user: 'ana', text: 'https://github.com/other/x/pull/4' })]
    expect(chatTriggers(defs, msgs, {}, { me: 'me', now: T0 }).triggers.map((t) => t.eventKey)).toEqual(['C01:1.000001'])
  })
})

describe('the engine', () => {
  it('runs the prompt in a dedicated session on a chat trigger and logs it', async () => {
    const { world, engine } = setup()
    expect(engine.onChatMessages([prMessage('10.000001')], '')).toBe(1)
    await runOnce(world, engine)
    expect(world.delivered.map((d) => d.text)).toEqual(['/review'])
    expect(engine.snapshot().runs[0]).toMatchObject({ outcome: 'ok', trigger: 'chat' })
  })

  it('coalesces a burst into one pending run', async () => {
    const { world, engine } = setup()
    world.usage = 99 // the usage guard holds the run so the burst arrives while it waits
    engine.onChatMessages([prMessage('10.000001'), prMessage('11.000001'), prMessage('12.000001')], '')
    await engine.tick()
    expect(engine.runState('a1').waitReason).toBe('usage')
    world.usage = 10
    await runOnce(world, engine)
    expect(world.delivered).toHaveLength(1)
    expect(engine.snapshot().runs.find((r) => r.outcome === 'coalesced')?.merged).toBe(2)
  })

  it('waits while the account is past its usage ceiling, and "Run now" overrides it once', async () => {
    const { world, engine } = setup()
    world.budget = { window: 'weekly', resetsAt: T0 + 3_600_000 }
    engine.onChatMessages([prMessage('15.000001')], '')
    await engine.tick()
    expect(engine.runState('a1')).toMatchObject({ waitReason: 'budget.weekly', waitUntil: T0 + 3_600_000 })
    expect(world.delivered).toHaveLength(0)
    engine.runNow('a1')
    await runOnce(world, engine)
    expect(world.delivered.map((d) => d.text)).toEqual(['/review'])
    world.budget = null
    engine.onChatMessages([prMessage('16.000001')], '')
    world.time += 3_600_000
    await runOnce(world, engine)
    expect(world.delivered).toHaveLength(2)
  })

  it('skips outside the window, waits at the limits, and pauses after a failure', async () => {
    const { world, engine } = setup({ limits: { maxRuns: 1, perMinutes: 60, maxPerDay: null } })
    world.time = new Date(2026, 9, 27, 22).getTime()
    engine.onChatMessages([prMessage('20.000001')], '')
    await engine.tick()
    expect(engine.snapshot().runs[0]).toMatchObject({ outcome: 'skipped', detail: 'window.hours' })
    world.time = T0
    engine.onChatMessages([prMessage('21.000001')], '')
    await runOnce(world, engine)
    engine.onChatMessages([prMessage('22.000001')], '')
    await engine.tick()
    expect(engine.runState('a1').waitReason).toBe('limit.window')
    // A session that fails mid-run is an error: one notice, then a backoff.
    engine.runNow('a1')
    await engine.tick()
    world.live.at(-1)!.state = 'error'
    world.live.at(-1)!.error = 'boom'
    await engine.tick()
    expect(world.notices).toEqual([expect.objectContaining({ kind: 'failed', detail: 'boom' })])
    expect(engine.health(world.defs[0]!)).toBe('failing')
  })

  it('bug 4: one chat event fires at most one run, across restarts and across profiles and accounts', async () => {
    const { world, engine } = setup({ profileId: 'work' })
    // A second profile (another account) has its own automation on the same channel.
    world.defs.push(newAutomation('a2', { name: 'Reviews (personal)', prompt: '/review', agentKey: 'claude:personal', profileId: 'home', triggers: { chatChannelIds: ['C01'], prOwner: '', intervalMinutes: null } }))
    const event = prMessage('30.000001')
    expect(engine.onChatMessages([event], '')).toBe(1)
    // The same event offered again (a second read, the other profile's watcher) fires nothing.
    expect(engine.onChatMessages([event, { ...event }], '')).toBe(0)
    await runOnce(world, engine)
    // After a restart the ledger comes back from disk: still nothing.
    const restarted = new AutomationEngine(world, world.saved!)
    expect(restarted.onChatMessages([event], '')).toBe(0)
    await restarted.tick()
    expect(world.delivered).toHaveLength(1)
    expect(Object.keys(world.saved!.ledger)).toEqual(['C01:30.000001'])
  })

  it('reuses its dedicated session, resuming it when it was closed', async () => {
    const { world, engine } = setup()
    engine.runNow('a1')
    await runOnce(world, engine)
    const first = world.live[0]!
    engine.runNow('a1')
    await runOnce(world, engine)
    expect(world.live).toHaveLength(1)
    first.state = 'stopped'
    engine.runNow('a1')
    await runOnce(world, engine)
    expect(world.live).toHaveLength(2)
    expect(world.live[1]?.identity).toBe(first.identity)
  })

  it('follows a session that gets its real identity after starting', async () => {
    const { world, engine } = setup()
    engine.runNow('a1')
    await runOnce(world, engine)
    const first = world.live[0]!
    engine.identityChanged(first.identity, 'acp-real-id')
    first.identity = 'acp-real-id'
    expect(engine.automationOf('acp-real-id')?.id).toBe('a1')
    expect(engine.snapshot().sessions['a1']).toBe('acp-real-id')
    expect(engine.snapshot().runs.every((r) => !r.session || r.session === 'acp-real-id')).toBe(true)
    engine.runNow('a1')
    await runOnce(world, engine)
    expect(world.live).toHaveLength(1)
  })
})

describe('run cost', () => {
  const usd = (amount: number) => ({ amount, currency: 'USD' })

  it('reads usage from a monitor snapshot and subtracts what the session had before', () => {
    expect(usageOfSnapshot({})).toBeUndefined()
    expect(usageOfSnapshot({ tokens: { input: 10, output: 5, cacheRead: 100 } })).toEqual({ tokens: 115 })
    expect(usageOfSnapshot({ cost: usd(1.5), tokens: { total: 40, input: 1 } })).toEqual({ cost: usd(1.5), tokens: 40 })
    expect(usageDelta({ cost: usd(1), tokens: 10 }, { cost: usd(1.75), tokens: 30 })).toEqual({ cost: usd(0.75), tokens: 20 })
    expect(usageDelta({}, { tokens: 7 })).toEqual({ tokens: 7 })
    expect(usageDelta({ tokens: 10 }, undefined)).toEqual({})
    expect(usageDelta({ cost: usd(5) }, { cost: usd(1) })).toEqual({ cost: usd(0) })
  })

  it('logs the cost of a run in a new session, and only the delta in a reused one', async () => {
    const { world, engine } = setup()
    engine.runNow('a1')
    await engine.tick()
    world.live[0]!.usage = { cost: usd(0.4), tokens: 1000 }
    await runOnce(world, engine)
    expect(engine.snapshot().runs[0]).toMatchObject({ outcome: 'ok', cost: usd(0.4), tokens: 1000 })
    engine.runNow('a1')
    await engine.tick()
    world.live[0]!.usage = { cost: usd(1), tokens: 2500 }
    await runOnce(world, engine)
    expect(engine.snapshot().runs[0]).toMatchObject({ cost: usd(0.6), tokens: 1500 })
  })

  it('picks up usage the monitor reports a moment after the run ended, then stops watching', async () => {
    const { world, engine } = setup()
    engine.runNow('a1')
    await runOnce(world, engine)
    expect(engine.snapshot().runs[0]).not.toHaveProperty('cost')
    expect(engine.snapshot().runs[0]).not.toHaveProperty('tokens')
    world.live[0]!.usage = { tokens: 300 }
    world.time += 3_000
    await engine.tick()
    expect(engine.snapshot().runs[0]).toMatchObject({ tokens: 300 })
    world.time += 60_000
    world.live[0]!.usage = { tokens: 999 }
    await engine.tick()
    expect(engine.snapshot().runs[0]).toMatchObject({ tokens: 300 })
  })

  it('logs nothing for a reused session whose usage was unknown when the run began', async () => {
    const { world, engine } = setup()
    engine.runNow('a1')
    await runOnce(world, engine)
    engine.runNow('a1')
    await engine.tick()
    world.live[0]!.usage = { tokens: 5000 }
    await runOnce(world, engine)
    expect(engine.snapshot().runs[0]).not.toHaveProperty('tokens')
  })

  it('fills an existing automation from a preset but keeps its id', () => {
    const preset = prReviewsPreset('new', { profileId: null, agentKey: 'claude', folder: '~/w', channels: [{ id: 'C2', name: 'pr-reviews', purpose: '' }] })
    const filled = fillFromPreset({ id: 'mine' }, preset)
    expect(filled).toMatchObject({ id: 'mine', name: 'PR reviews', sessionPolicy: 'newEachRun', triggers: { chatChannelIds: ['C2'] } })
    filled.triggers.chatChannelIds.push('X')
    expect(preset.triggers.chatChannelIds).toEqual(['C2'])
  })
})

describe('new session each run (Workhub 1 bugs)', () => {
  /**
   * A first run whose session sent a Slack message (the hook) and sits in group "Bots", second of
   * two; then the app restarts with that session still open, so the next run opens a new one.
   */
  async function firstRun() {
    const { world, engine: before } = setup({ sessionPolicy: 'newEachRun' })
    before.runNow('a1')
    await runOnce(world, before)
    const old = world.live[0]!
    world.groups = reconcileTop(moveToGroup(createGroup(EMPTY_SESSION_GROUPS, 'g1', 'Bots', { key: 'other', title: 'x', agentKey: 'shell', cwd: '/tmp' }), { key: old.identity, title: 'Reviews', agentKey: 'shell', cwd: '/tmp' }, 'g1'), [])
    world.chat = ingestRecord(world.chat, { sessionId: old.identity, channelId: 'C01', ts: '40.000001', text: 'review request' }, { now: T0, newId: world.newId }).state
    const engine = new AutomationEngine(world, before.snapshot())
    return { world, engine, old }
  }

  it('bug 2: the new session takes the old one\'s sidebar group and position', async () => {
    const { world, engine, old } = await firstRun()
    engine.runNow('a1')
    await runOnce(world, engine)
    const fresh = world.live.find((s) => s.id !== old.id)!
    expect(fresh.identity).not.toBe(old.identity)
    expect(groupOf(world.groups, fresh.identity)?.id).toBe('g1')
    expect(world.groups.groups[0]?.members.map((m) => m.key)).toEqual(['other', fresh.identity])
    expect(groupOf(world.groups, old.identity)).toBeUndefined()
  })

  it('bug 1: the listening threads move to the new session, and the old one is never stopped while a thread wakes it', async () => {
    const { world, engine, old } = await firstRun()
    // The old session is busy with a reply when the next run starts.
    old.state = 'busy'
    engine.runNow('a1')
    await engine.tick()
    const fresh = world.live[1]!
    expect(listeningThreadsOf(world.chat.threads, fresh.identity)).toHaveLength(1)
    expect(listeningThreadsOf(world.chat.threads, old.identity)).toHaveLength(0)
    expect(world.stopped).toEqual([])
    // Idle again and nothing wakes it: it is retired.
    world.endTurns()
    world.time += 2_000
    await engine.tick()
    expect(world.stopped).toEqual([old.id])
    // Stopped by the hand-over: it leaves the session list too.
    expect(world.forgotten).toEqual([old.id])
    expect(world.live.map((s) => s.id)).not.toContain(old.id)
  })

  it('bug 1: a replaced session that a thread still wakes stays open until nothing wakes it', async () => {
    const { world, engine, old } = await firstRun()
    // The hand-over could not move the thread (say the watcher was busy): it still wakes the old session.
    world.transferThreads = () => 0
    engine.runNow('a1')
    await runOnce(world, engine)
    await engine.tick()
    expect(engine.snapshot().retiring).toContain(old.identity)
    expect(world.stopped).toEqual([])
    // Once the thread closes, the old session is retired.
    world.chat = { ...world.chat, threads: world.chat.threads.map((t) => ({ ...t, closed: true })) }
    await engine.tick()
    expect(world.stopped).toEqual([old.id])
    expect(engine.snapshot().retiring).toEqual([])
  })

  it('blocks wakes of an automation that is off or takes no replies', async () => {
    const { world, engine, old } = await firstRun()
    world.defs[0] = { ...world.defs[0]!, enabled: false }
    expect(engine.wakeBlocked(old.identity)).toBe('automationOff')
    world.defs[0] = { ...world.defs[0]!, enabled: true, receivesChatReplies: false }
    expect(engine.wakeBlocked(old.identity)).toBe('noReplies')
    expect(engine.ignoresChat(old.identity)).toBe(true)
    expect(engine.wakeBlocked('someone-else')).toBeNull()
  })
})

describe('one session per automation while the app runs', () => {
  /** What each run typed, and into which session (`0` the first one opened, `1` the next…). */
  const sessionTexts = (world: FakeWorld) => {
    const order = [...new Set(world.delivered.map((d) => d.sessionId))]
    return world.delivered.map((d) => `${order.indexOf(d.sessionId)}:${d.text}`)
  }

  it('sends every run into the session it opened while that one is open and idle', async () => {
    const { world, engine } = setup({ sessionPolicy: 'newEachRun' })
    for (let i = 0; i < 3; i++) {
      engine.runNow('a1')
      await runOnce(world, engine)
    }
    expect(world.live).toHaveLength(1)
    expect(sessionTexts(world)).toEqual(['0:/review', '0:/review', '0:/review'])
    expect(engine.snapshot().runs.filter((r) => r.outcome === 'ok')).toHaveLength(3)
    expect(new Set(engine.snapshot().runs.map((r) => r.session))).toEqual(new Set([world.live[0]!.identity]))
  })

  it('starts a new session once its session was closed, failed or left the list, and after a restart', async () => {
    const { world, engine } = setup({ sessionPolicy: 'newEachRun' })
    engine.runNow('a1')
    await runOnce(world, engine)
    world.live[0]!.state = 'stopped'
    engine.runNow('a1')
    await runOnce(world, engine)
    expect(world.live).toHaveLength(2)
    world.live[1]!.state = 'error'
    engine.runNow('a1')
    await runOnce(world, engine)
    expect(world.live).toHaveLength(3)
    // The third one left the session list (closed and dropped).
    world.live = world.live.slice(0, 2)
    engine.runNow('a1')
    await runOnce(world, engine)
    expect(world.live).toHaveLength(3)
    expect(new Set(world.delivered.map((d) => d.sessionId)).size).toBe(4)
    // After a restart the open session is not the automation's any more: the next run opens another.
    const restarted = new AutomationEngine(world, engine.snapshot())
    restarted.runNow('a1')
    await runOnce(world, restarted)
    expect(new Set(world.delivered.map((d) => d.sessionId)).size).toBe(5)
  })

  it('never opens a second session while its session is busy: the run waits and later triggers merge into it', async () => {
    const { world, engine } = setup({ sessionPolicy: 'newEachRun', triggers: { chatChannelIds: ['C01'], prOwner: '', intervalMinutes: null } })
    engine.runNow('a1')
    await runOnce(world, engine)
    const session = world.live[0]!
    // A Slack reply woke it, or the user is typing in it: it is busy (a permission prompt counts too).
    session.state = 'busy'
    engine.onChatMessages([prMessage('50.000001')], 'me')
    await engine.tick()
    engine.onChatMessages([prMessage('51.000001')], 'me')
    await engine.tick()
    expect(world.live).toHaveLength(1)
    expect(world.delivered).toHaveLength(1)
    expect(engine.runState('a1')).toMatchObject({ waitReason: 'sessionBusy', pending: { merged: 1 } })
    // Free again: the one waiting run goes into the same session.
    Object.assign(session, { state: 'ready', turnsEnded: session.turnsEnded + 1 })
    await runOnce(world, engine)
    expect(world.live).toHaveLength(1)
    expect(sessionTexts(world)).toEqual(['0:/review', '0:/review'])
    expect(engine.runState('a1').pending).toBeUndefined()
  })

  it('clears the context before a run in a session already used, when asked and when the agent can', async () => {
    const { world, engine } = setup({ sessionPolicy: 'newEachRun', clearContext: true })
    engine.runNow('a1')
    await runOnce(world, engine)
    // A fresh session has nothing to clear.
    expect(sessionTexts(world)).toEqual(['0:/review'])
    engine.runNow('a1')
    await engine.tick()
    expect(sessionTexts(world)).toEqual(['0:/review', '0:/clear'])
    expect(engine.runState('a1').active?.stage).toBe('clearing')
    // `/clear` ends its own turn, then the prompt goes in.
    world.endTurns()
    await engine.tick()
    await engine.tick()
    expect(sessionTexts(world)).toEqual(['0:/review', '0:/clear', '0:/review'])
    world.endTurns()
    await engine.tick()
    expect(engine.snapshot().runs.filter((r) => r.outcome === 'ok')).toHaveLength(2)
    // An agent that cannot clear, or the option off: the prompt goes straight in.
    world.clears = false
    engine.runNow('a1')
    await runOnce(world, engine)
    world.clears = true
    world.defs[0] = { ...world.defs[0]!, clearContext: false }
    engine.runNow('a1')
    await runOnce(world, engine)
    expect(world.delivered.slice(3).map((d) => d.text)).toEqual(['/review', '/review'])
  })

  it('keeps the old identity linked to the automation when the session moves to a new one', async () => {
    const { world, engine } = setup()
    engine.runNow('a1')
    await runOnce(world, engine)
    const before = world.live[0]!.identity
    engine.identityChanged(before, 'after-clear')
    expect(engine.snapshot().owned).toMatchObject({ [before]: 'a1', 'after-clear': 'a1' })
    expect(engine.snapshot().sessions['a1']).toBe('after-clear')
  })
})

describe('config version 5 (chat watcher and automations)', () => {
  it('migrates a version 4 document unchanged and fills the defaults', async () => {
    const { migrateConfig, parseConfig, chatWatcherSettings, saveAutomation, setChatWatcher, emptyConfig } = await import('../src')
    expect(migrateConfig({ version: 4, profiles: [] })).toEqual({ version: 7, profiles: [] })
    const parsed = parseConfig({ version: 7, chatWatcher: { enabled: true, channels: [{ id: 'C01', name: 'reviews' }] }, automations: [{ id: 'a', name: 'A', agentKey: 'shell' }] })
    expect(chatWatcherSettings(parsed)).toMatchObject({ enabled: true, model: 'haiku', intervalMinutes: 10, channels: [{ id: 'C01', name: 'reviews', purpose: '' }] })
    expect(parsed.automations?.[0]).toMatchObject({ sessionPolicy: 'reuse', receivesChatReplies: true, limits: { maxRuns: 6, perMinutes: 5, maxPerDay: 60 } })
    const base = emptyConfig()
    expect(setChatWatcher(base, { ...chatWatcherSettings(base), channels: [{ id: 'C1', name: 'a', purpose: '' }, { id: 'C1', name: 'b', purpose: '' }] }).ok).toBe(false)
    expect(saveAutomation(base, newAutomation('x', { profileId: 'missing' })).ok).toBe(false)
    expect(saveAutomation(base, newAutomation('x')).ok).toBe(true)
  })
})
