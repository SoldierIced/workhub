import { describe, expect, it } from 'vitest'
import {
  buildTrayPopover,
  parseTrayAction,
  popoverPlacement,
  popoverSize,
  stampSince,
  taskbarEdge,
  TRAY_POPOVER_LIST_LIMIT,
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
  it('splits sessions into "needs you" (most urgent first) and the rest (working first)', () => {
    const sessions: TraySession[] = [
      { id: 'idle', title: 'Codex · web', state: 'ready', agentId: 'codex' },
      { id: 'replied', title: 'Claude · api', state: 'ready', unseen: 'replied', agentId: 'claude' },
      { id: 'busy', title: 'Claude · ops', state: 'busy' },
      { id: 'err', title: 'Kiro · infra', state: 'error' },
      { id: 'ask', title: 'Claude · docs', state: 'busy', awaitingAnswer: true, since: NOW - 60_000 }
    ]
    const view = buildTrayPopover(state({ sessions }), NOW)
    expect(view.summary).toEqual({ open: 5, running: 1, attention: 3 })
    expect(view.level).toBe('error')
    expect(view.needsYou.map((s) => [s.id, s.level])).toEqual([
      ['err', 'error'],
      ['ask', 'needsAnswer'],
      ['replied', 'readyToReview']
    ])
    expect(view.needsYou[1]!.since).toBe(NOW - 60_000)
    expect(view.needsYou[2]!.agentId).toBe('claude')
    expect(view.sessions.map((s) => [s.id, s.level])).toEqual([
      ['busy', 'working'],
      ['idle', null]
    ])
  })

  it('caps the lists and counts what is left out', () => {
    const sessions: TraySession[] = Array.from({ length: TRAY_POPOVER_LIST_LIMIT + 3 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, state: 'error' as const }))
    const view = buildTrayPopover(state({ sessions }), NOW)
    expect(view.needsYou).toHaveLength(TRAY_POPOVER_LIST_LIMIT)
    expect(view.needsYouMore).toBe(3)
    expect(view.sessionsMore).toBe(0)
  })

  it('orders usage windows 5h then weekly, rounds and colors them, and keeps only future resets', () => {
    const view = buildTrayPopover(
      state({
        usage: [
          {
            name: 'Work',
            agentId: 'claude',
            windows: [
              { window: 'weekly', percent: 76.4, resetsAt: NOW + 3_600_000 },
              { window: '5h', percent: 12.6, resetsAt: NOW - 1 },
              { window: 'opus', percent: 140 }
            ]
          },
          { name: 'Codex', windows: [], error: true }
        ]
      }),
      NOW
    )
    expect(view.usage[0]).toEqual({
      name: 'Work',
      agentId: 'claude',
      error: false,
      windows: [
        { window: '5h', percent: 13, tone: 'success' },
        { window: 'weekly', percent: 76, tone: 'warning', resetsAt: NOW + 3_600_000 },
        { window: 'opus', percent: 100, tone: 'danger' }
      ]
    })
    expect(view.usage[1]).toEqual({ name: 'Codex', error: true, windows: [] })
  })

  it('uses the Home bars thresholds for usage colors', () => {
    expect([0, 74, 75, 89, 90, 100].map(usageTone)).toEqual(['success', 'success', 'warning', 'warning', 'danger', 'danger'])
  })

  it('colors Health and Slack by state and reports the pause only while it lasts', () => {
    const view = buildTrayPopover(
      state({
        health: { state: 'degraded', degraded: ['prod'] },
        slack: { health: 'failing', open: 2, unread: 1, error: 'expired' },
        pausedUntil: NOW + 1000,
        notifications: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, at: NOW - i }))
      }),
      NOW
    )
    expect(view.health).toEqual({ state: 'degraded', degraded: ['prod'], tone: 'warning' })
    expect(view.slack).toEqual({ health: 'failing', open: 2, unread: 1, error: 'expired', tone: 'danger' })
    expect(view.pausedUntil).toBe(NOW + 1000)
    expect(view.notifications).toHaveLength(5)
    expect(buildTrayPopover(state({ pausedUntil: NOW - 1, health: { state: null, degraded: [] } }), NOW)).toMatchObject({ pausedUntil: null, health: { tone: 'neutral' } })
  })
})

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
      { kind: 'pause', preset: 'tomorrow' }
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
      { kind: 'pause', preset: 'forever' }
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
