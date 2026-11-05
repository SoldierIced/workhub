import { describe, expect, it } from 'vitest'
import {
  automationLine,
  buildTrayMenu,
  buildTrayPopover,
  hasToday,
  meetingProvider,
  parseTrayAction,
  PAUSE_INDEFINITE_AT,
  popoverPlacement,
  popoverSize,
  stampSince,
  taskbarEdge,
  TRAY_POPOVER_NEEDS_YOU_LIMIT,
  TRAY_POPOVER_NOTIFICATION_LIMIT,
  TRAY_POPOVER_PLAN_LIMIT,
  TRAY_POPOVER_WORKING_LIMIT,
  usageTone,
  type Rect,
  type TraySession,
  type TrayState
} from '../src'

const NOW = Date.UTC(2026, 9, 27, 12)

const state = (s: Partial<TrayState> = {}): TrayState => ({
  appName: 'Workhub 2 Dev',
  sessions: [],
  usage: [],
  pullRequests: null,
  prEvents: [],
  health: null,
  slack: null,
  canCheckForUpdates: false,
  ...s
})

describe('tray popover view-model', () => {
  it('splits sessions into "needs you" (most urgent first) and "working" (longest first); idle ones only count', () => {
    const sessions: TraySession[] = [
      { id: 'idle', title: 'Codex · web', state: 'ready', agentId: 'codex' },
      { id: 'replied', title: 'Claude · api', state: 'ready', unseen: 'replied', agentId: 'claude' },
      { id: 'busy', title: 'Claude · ops', state: 'busy', since: NOW - 60_000 },
      { id: 'busy2', title: 'Claude · db', state: 'busy', since: NOW - 120_000 },
      { id: 'err', title: 'Kiro · infra', state: 'error' },
      { id: 'ask', title: 'Claude · docs', state: 'busy', awaitingAnswer: true, since: NOW - 60_000 }
    ]
    const view = buildTrayPopover(state({ sessions }), NOW)
    expect(view.summary).toEqual({ open: 6, running: 2, attention: 3 })
    expect(view.level).toBe('error')
    expect(view.verdict).toEqual({ kind: 'needsYou', count: 3, tone: 'danger' })
    expect(view.needsYou.map((s) => [s.id, s.level])).toEqual([
      ['err', 'error'],
      ['ask', 'needsAnswer'],
      ['replied', 'readyToReview']
    ])
    expect(view.needsYou[1]!.since).toBe(NOW - 60_000)
    expect(view.needsYou[2]!.agentId).toBe('claude')
    expect(view.working.map((s) => s.id)).toEqual(['busy2', 'busy'])
  })

  it('words the header verdict: needs you, else working, else caught up, else empty', () => {
    const v = (sessions: TraySession[]) => buildTrayPopover(state({ sessions }), NOW).verdict
    expect(v([{ id: 'a', title: 'A', state: 'busy', awaitingAnswer: true }])).toEqual({ kind: 'needsYou', count: 1, tone: 'warning' })
    expect(v([{ id: 'a', title: 'A', state: 'busy' }, { id: 'b', title: 'B', state: 'starting' }])).toMatchObject({ kind: 'working', tone: 'info' })
    expect(v([{ id: 'a', title: 'A', state: 'ready' }])).toEqual({ kind: 'caughtUp', count: 0, tone: 'success' })
    expect(v([])).toEqual({ kind: 'empty', count: 0, tone: 'neutral' })
  })

  it('caps the lists and counts what is left out', () => {
    const errors: TraySession[] = Array.from({ length: TRAY_POPOVER_NEEDS_YOU_LIMIT + 3 }, (_, i) => ({ id: `e${i}`, title: `E${i}`, state: 'error' as const }))
    const busy: TraySession[] = Array.from({ length: TRAY_POPOVER_WORKING_LIMIT + 2 }, (_, i) => ({ id: `b${i}`, title: `B${i}`, state: 'busy' as const }))
    const notifications = Array.from({ length: TRAY_POPOVER_NOTIFICATION_LIMIT + 5 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, at: NOW - i }))
    const view = buildTrayPopover(state({ sessions: [...errors, ...busy], notifications }), NOW)
    expect([view.needsYou.length, view.needsYouMore]).toEqual([TRAY_POPOVER_NEEDS_YOU_LIMIT, 3])
    expect([view.working.length, view.workingMore]).toEqual([TRAY_POPOVER_WORKING_LIMIT, 2])
    expect([view.notifications.length, view.notificationsMore]).toEqual([TRAY_POPOVER_NOTIFICATION_LIMIT, 5])
    expect(view.notifications[0]!.id).toBe('n0')
  })

  it('lists one usage row per account with a reading: its most spent window, rounded and colored, with a future reset only', () => {
    const view = buildTrayPopover(
      state({
        usage: [
          { name: 'Codex', windows: [], error: true },
          {
            name: 'Work',
            agentId: 'claude',
            windows: [
              { window: '5h', percent: 12.6, resetsAt: NOW - 1 },
              { window: 'weekly', percent: 76.4, resetsAt: NOW + 3_600_000 }
            ]
          },
          { name: 'New', windows: [] },
          { name: 'Side', windows: [{ window: '5h', percent: 31.2 }] }
        ]
      }),
      NOW
    )
    expect(view.usage).toEqual([
      { name: 'Work', agentId: 'claude', window: { window: 'weekly', percent: 76, tone: 'warning', resetsAt: NOW + 3_600_000 } },
      { name: 'Side', window: { window: '5h', percent: 31, tone: 'success' } }
    ])
    expect(buildTrayPopover(state({ usage: [{ name: 'Big', windows: [{ window: 'opus', percent: 140 }] }] }), NOW).usage[0]?.window).toEqual({ window: 'opus', percent: 100, tone: 'danger' })
    expect(buildTrayPopover(state({ usage: [{ name: 'Tie', windows: [{ window: 'weekly', percent: 40 }, { window: '5h', percent: 40 }] }] }), NOW).usage[0]?.window.window).toBe('5h')
    expect(buildTrayPopover(state(), NOW).usage).toEqual([])
  })

  it('uses the Home bars thresholds for usage colors', () => {
    expect([0, 74, 75, 89, 90, 100].map(usageTone)).toEqual(['success', 'success', 'warning', 'warning', 'danger', 'danger'])
  })

  it('shows Health only while it is degraded or unreachable, Slack only while the watcher fails, and the pause while it lasts', () => {
    const view = buildTrayPopover(
      state({
        health: { state: 'degraded', degraded: ['prod'] },
        slack: { health: 'failing', open: 2, unread: 1, error: 'expired' },
        pausedUntil: NOW + 1000
      }),
      NOW
    )
    expect(view.today.health).toEqual({ state: 'degraded', degraded: ['prod'], tone: 'warning' })
    expect(view.today.slack).toEqual({ error: 'expired', tone: 'danger' })
    expect([view.pausedUntil, view.pausedIndefinitely]).toEqual([NOW + 1000, false])
    expect(buildTrayPopover(state({ health: { state: 'unreachable', degraded: [] } }), NOW).today.health?.tone).toBe('danger')
    for (const quiet of ['healthy', 'blind', null] as const) expect(buildTrayPopover(state({ health: { state: quiet, degraded: [] } }), NOW).today.health).toBeNull()
    expect(buildTrayPopover(state({ slack: { health: 'watching', open: 3, unread: 1 } }), NOW).today.slack).toBeNull()
    expect(buildTrayPopover(state({ pausedUntil: NOW - 1 }), NOW)).toMatchObject({ pausedUntil: null, pausedIndefinitely: false })
    expect(buildTrayPopover(state({ pausedUntil: PAUSE_INDEFINITE_AT }), NOW)).toMatchObject({ pausedUntil: PAUSE_INDEFINITE_AT, pausedIndefinitely: true })
  })
})

describe('tray popover "Today"', () => {
  const MIN = 60_000
  const calendar = [
    { id: 'later', title: 'Sprint review', startsAt: NOW + 160 * MIN, endsAt: NOW + 220 * MIN, location: 'Room 2' },
    { id: 'soon', title: '1:1', startsAt: NOW + 12 * MIN, endsAt: NOW + 42 * MIN, joinUrl: 'https://meet.google.com/abc-defg-hij' },
    { id: 'last', title: 'Retro', startsAt: NOW + 300 * MIN },
    { id: 'over', title: 'Stand-up', startsAt: NOW - 60 * MIN, endsAt: NOW - 45 * MIN }
  ]

  it('lists the next meetings soonest first, up to the chosen count, and marks the one about to start', () => {
    const view = buildTrayPopover(state({ calendar }), NOW)
    expect(view.today.meetings).toEqual([
      { id: 'soon', title: '1:1', startsAt: NOW + 12 * MIN, endsAt: NOW + 42 * MIN, provider: 'Meet', hasJoinUrl: true, ongoing: false, soon: true },
      { id: 'later', title: 'Sprint review', startsAt: NOW + 160 * MIN, endsAt: NOW + 220 * MIN, location: 'Room 2', hasJoinUrl: false, ongoing: false, soon: false }
    ])
    expect(buildTrayPopover(state({ calendar, popover: { ...defaults(), meetingCount: 3 } }), NOW).today.meetings.map((m) => m.id)).toEqual(['soon', 'later', 'last'])
    const ongoing = buildTrayPopover(state({ calendar: [{ id: 'on', title: 'Call', startsAt: NOW - 5 * MIN, endsAt: NOW + 25 * MIN }] }), NOW).today.meetings[0]
    expect(ongoing).toMatchObject({ ongoing: true, soon: true, hasJoinUrl: false })
  })

  it('lists Plan tasks due today, overdue first, at most two; and the pull requests while there is a code host', () => {
    const planDueToday = [
      { id: 't1', title: 'Answer the contract question' },
      { id: 't2', title: 'Old one', overdue: true },
      { id: 't3', title: 'Third' }
    ]
    const view = buildTrayPopover(state({ planDueToday, pullRequests: { toReview: 31, mine: 4 } }), NOW)
    expect(view.today.plan).toEqual([
      { id: 't2', title: 'Old one', overdue: true },
      { id: 't1', title: 'Answer the contract question', overdue: false }
    ])
    expect(view.today.plan).toHaveLength(TRAY_POPOVER_PLAN_LIMIT)
    expect(view.today.pullRequests).toEqual({ toReview: 31, mine: 4 })
    expect(hasToday(view.today)).toBe(true)
    const empty = buildTrayPopover(state(), NOW)
    expect(empty.today).toEqual({ meetings: [], plan: [], pullRequests: null, health: null, slack: null })
    expect(hasToday(empty.today)).toBe(false)
  })

  it('leaves out the blocks the user turned off', () => {
    const off = { meetings: false, meetingCount: 2 as const, plan: false, pullRequests: false, health: false, usage: false, recent: false }
    const view = buildTrayPopover(
      state({
        calendar,
        planDueToday: [{ id: 't', title: 'T' }],
        pullRequests: { toReview: 1, mine: 0 },
        health: { state: 'degraded', degraded: ['dev'] },
        slack: { health: 'failing', open: 0, unread: 0 },
        usage: [{ name: 'Work', windows: [{ window: '5h', percent: 10 }] }],
        notifications: [{ id: 'n1', title: 'Hi' }],
        popover: off
      }),
      NOW
    )
    expect(view.today).toEqual({ meetings: [], plan: [], pullRequests: null, health: null, slack: { tone: 'danger' } })
    expect([view.usage, view.notifications, view.notificationsMore]).toEqual([[], [], 0])
  })

  it('names the call service of a link', () => {
    expect(meetingProvider('https://meet.google.com/abc')).toBe('Meet')
    expect(meetingProvider('https://acme.zoom.us/j/1')).toBe('Zoom')
    expect(meetingProvider('https://teams.microsoft.com/l/meetup-join/1')).toBe('Teams')
    expect(meetingProvider('https://example.com/zoom.us')).toBeUndefined()
    expect(meetingProvider('not a link')).toBeUndefined()
    expect(meetingProvider(undefined)).toBeUndefined()
  })
})

const defaults = () => ({ meetings: true, meetingCount: 2 as const, plan: true, pullRequests: true, health: true, usage: true, recent: true })

describe('stampSince', () => {
  it('keeps the time while the state holds and restamps when it changes', () => {
    const first = stampSince(new Map(), [{ id: 'a', title: 'A', state: 'busy' }], 100)
    expect(first.sessions[0]!.since).toBe(100)
    const same = stampSince(first.since, [{ id: 'a', title: 'A', state: 'busy' }], 200)
    expect(same.sessions[0]!.since).toBe(100)
    const replied = stampSince(same.since, [{ id: 'a', title: 'A', state: 'ready', unseen: 'replied' }], 300)
    expect(replied.sessions[0]!.since).toBe(300)
    expect(stampSince(replied.since, [], 400).since.size).toBe(0)
  })
})

describe('parseTrayAction', () => {
  it('accepts every well-formed action', () => {
    for (const a of [
      { kind: 'open' },
      { kind: 'newSession' },
      { kind: 'resume' },
      { kind: 'checkForUpdates' },
      { kind: 'quit' },
      { kind: 'openSession', id: 's1' },
      { kind: 'openNotification', id: 'n1' },
      { kind: 'navigate', route: 'settings' },
      { kind: 'openPullRequest', profileId: '', url: 'https://github.com/o/r/pull/1' },
      { kind: 'navigate', route: 'plan' },
      { kind: 'openMeeting', id: 'uid-1|1700000000000' },
      { kind: 'openSettings', section: 'usage' },
      { kind: 'openSettings', section: 'notifications' },
      { kind: 'pause', preset: 'tomorrow' },
      { kind: 'pause', preset: 'indefinite' }
    ]) {
      expect(parseTrayAction(a), a.kind).toEqual(a)
    }
  })

  it('refuses anything else and drops extra fields', () => {
    for (const bad of [
      null,
      'quit',
      {},
      { kind: 'exec' },
      { kind: 'openSession' },
      { kind: 'openSession', id: 7 },
      { kind: 'navigate', route: 'secrets' },
      { kind: 'openPullRequest', profileId: 'p', url: 'file:///etc/passwd' },
      { kind: 'pause', preset: 'forever' },
      { kind: 'openMeeting' },
      { kind: 'openSettings', section: 'secrets' }
    ]) {
      expect(parseTrayAction(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(parseTrayAction({ kind: 'quit', extra: 1 })).toEqual({ kind: 'quit' })
  })
})

describe('popover placement', () => {
  // A 1512x982 MacBook screen: 25 px menu bar, a 70 px Dock at the bottom.
  const mac = { display: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 887 } }
  // A 1920x1080 Windows screen with a 48 px taskbar at the bottom.
  const win = { display: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }

  it('hangs under a menu bar icon, centered on it, even with the Dock at the bottom', () => {
    const tray: Rect = { x: 1000, y: 0, width: 30, height: 24 }
    expect(taskbarEdge(tray, mac.workArea, mac.display)).toBe('top')
    expect(popoverPlacement({ tray, ...mac, width: 360, height: 520 })).toEqual({ x: 835, y: 31, width: 360, height: 520, edge: 'top' })
  })

  it('stays inside the work area for an icon near the right edge', () => {
    const tray: Rect = { x: 1490, y: 0, width: 22, height: 24 }
    expect(popoverPlacement({ tray, ...mac, width: 360, height: 520 }).x).toBe(1512 - 360 - 6)
  })

  it('opens above a bottom taskbar on Windows', () => {
    const tray: Rect = { x: 1700, y: 1040, width: 24, height: 32 }
    expect(popoverPlacement({ tray, ...win, width: 360, height: 520 })).toEqual({ x: 1532, y: 1032 - 520 - 6, width: 360, height: 520, edge: 'bottom' })
  })

  it('opens beside a vertical taskbar', () => {
    const left = { display: win.display, workArea: { x: 60, y: 0, width: 1860, height: 1080 } }
    const atLeft = popoverPlacement({ tray: { x: 18, y: 1000, width: 24, height: 24 }, ...left, width: 360, height: 520 })
    expect(atLeft).toEqual({ x: 66, y: 1080 - 520 - 6, width: 360, height: 520, edge: 'left' })
    const right = { display: win.display, workArea: { x: 0, y: 0, width: 1860, height: 1080 } }
    expect(popoverPlacement({ tray: { x: 1878, y: 500, width: 24, height: 24 }, ...right, width: 360, height: 520 })).toMatchObject({ x: 1860 - 360 - 6, edge: 'right' })
  })

  it('shrinks to a small work area and works on a secondary display with negative coordinates', () => {
    expect(popoverSize(360, 900, { x: 0, y: 25, width: 1280, height: 700 })).toEqual({ width: 360, height: 688 })
    const second = { display: { x: -1440, y: -900, width: 1440, height: 900 }, workArea: { x: -1440, y: -875, width: 1440, height: 875 } }
    const p = popoverPlacement({ tray: { x: -100, y: -900, width: 24, height: 24 }, ...second, width: 360, height: 520 })
    expect(p).toEqual({ x: -366, y: -869, width: 360, height: 520, edge: 'top' })
  })

  it('anchors at the cursor when the platform gives no tray bounds', () => {
    const p = popoverPlacement({ tray: { x: 0, y: 0, width: 0, height: 0 }, ...win, fallback: { x: 1800, y: 1060 }, width: 360, height: 400 })
    expect(p).toMatchObject({ edge: 'bottom', x: 1920 - 360 - 6, y: 1032 - 400 - 6 })
  })
})

describe('tray popover automations and notifications', () => {
  it('does not repeat under "Recent" a session already under "Needs you" or "Working"', () => {
    const sessions: TraySession[] = [
      { id: 'ask', title: 'A', state: 'busy', awaitingAnswer: true },
      { id: 'busy', title: 'B', state: 'busy' },
      { id: 'idle', title: 'C', state: 'ready' }
    ]
    const notifications = [
      { id: 'n1', title: 'A asks', sessionId: 'ask' },
      { id: 'n2', title: 'B replied', sessionId: 'busy' },
      { id: 'n3', title: 'C replied', sessionId: 'idle' },
      { id: 'n4', title: 'PR approved' }
    ]
    const view = buildTrayPopover(state({ sessions, notifications }), NOW)
    expect(view.notifications.map((n) => n.id)).toEqual(['n3', 'n4'])
    expect(view.notificationsMore).toBe(0)
  })

  it('words each automation like Workhub 1 and accepts "Clear all"', () => {
    const t = (key: string, p?: Record<string, string | number>) => `${key}${p ? JSON.stringify(p) : ''}`
    expect(automationLine({ id: 'a', name: 'x', health: 'running', startedToday: 3 }, t)).toBe('tray.automation.running{"count":3}')
    expect(automationLine({ id: 'a', name: 'x', health: 'waiting', startedToday: 0 }, t)).toBe('tray.automation.queued')
    expect(automationLine({ id: 'a', name: 'x', health: 'failing', startedToday: 0, lastError: 'boom' }, t)).toBe('tray.automation.failing{"error":"boom"}')
    expect(parseTrayAction({ kind: 'clearNotifications' })).toEqual({ kind: 'clearNotifications' })
  })

  it('puts the automations and a "Clear all" item in the native menu', () => {
    const text = { t: (k: string) => k, tn: (b: string) => b, time: () => '', windowLabel: (w: string) => w }
    const items = buildTrayMenu(
      state({ automations: [{ id: 'a', name: 'PR reviews', health: 'idle', startedToday: 1 }], notifications: [{ id: 'n1', title: 'Hi' }] }),
      text,
      NOW
    )
    expect(items.some((i) => i.type === 'label' && i.label === 'tray.section.automations')).toBe(true)
    const notifications = items.find((i) => i.type === 'submenu' && i.label === 'tray.section.notifications')
    expect(notifications?.type === 'submenu' && notifications.items.at(-1)).toEqual({ type: 'action', label: 'tray.notifications.clear', action: { kind: 'clearNotifications' } })
  })
})
