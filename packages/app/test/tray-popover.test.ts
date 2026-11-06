import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TrayPopoverUsage, TrayPopoverView } from '@workhub/core'

const electron = vi.hoisted(() => {
  const display = { workArea: { x: 0, y: 24, width: 1440, height: 876 }, bounds: { x: 0, y: 0, width: 1440, height: 900 } }
  class FakeWindow {
    static last: FakeWindow | null = null
    bounds: { x: number; y: number; width: number; height: number } | null = null
    background: string | null = null
    visible = false
    webContents = { send: () => undefined, on: () => undefined }
    constructor(readonly options: Record<string, unknown>) {
      FakeWindow.last = this
    }
    setAlwaysOnTop() {}
    on() {}
    isDestroyed() {
      return false
    }
    isVisible() {
      return this.visible
    }
    show() {
      this.visible = true
    }
    hide() {
      this.visible = false
    }
    focus() {}
    setVisibleOnAllWorkspaces() {}
    setBounds(b: { x: number; y: number; width: number; height: number }) {
      this.bounds = b
    }
    setBackgroundColor(c: string) {
      this.background = c
    }
  }
  return { display, FakeWindow }
})

vi.mock('electron', () => ({
  app: { on: () => undefined },
  BrowserWindow: electron.FakeWindow,
  screen: { getCursorScreenPoint: () => ({ x: 1200, y: 10 }), getDisplayMatching: () => electron.display, getDisplayNearestPoint: () => electron.display },
  Menu: {},
  nativeImage: {},
  Tray: class {}
}))

import { POPOVER_BACKGROUND, POPOVER_HEIGHT, POPOVER_SCREEN_MARGIN, POPOVER_WIDTH, popoverHeightFor, popoverWindowOptions, TrayPopover } from '../src/main/tray-popover'
import { trayClickBehavior } from '../src/main/tray'
import { countdown, elapsed, nextFocus, overflowRow, popoverMenuItems, quietHoursValue, recentExpanded, sessionChip, usageBlock } from '../src/renderer/lib/trayPopover'
import { DEFAULT_PREFS, parsePrefs } from '../src/renderer/lib/prefs'
import { trayPopoverEn } from '../src/renderer/i18n/trayPopover.en'
import { trayPopoverEs } from '../src/renderer/i18n/trayPopover.es'
import { placeholders } from '../src/renderer/i18n/translate'

const tray = { x: 1200, y: 0, width: 24, height: 24 }
const open = (platform: NodeJS.Platform, dark = true) => {
  const popover = new TrayPopover({ platform, preload: '/p.js', load: () => undefined, refresh: () => undefined, pinned: true, dark: () => dark })
  popover.show(tray)
  return { popover, win: electron.FakeWindow.last! }
}

describe('tray popover window', () => {
  it('is a fixed 360x520 on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const o = popoverWindowOptions(platform, '/p.js')
      expect([o.width, o.height, o.resizable]).toEqual([POPOVER_WIDTH, POPOVER_HEIGHT, false])
    }
    expect([POPOVER_WIDTH, POPOVER_HEIGHT]).toEqual([360, 520])
    electron.display.workArea.height = 876
    const { win } = open('darwin')
    expect(win.bounds).toMatchObject({ width: 360, height: 520 })
  })

  it('takes the work area minus 16 px on a screen shorter than 520 + 16, and only when it is shown', () => {
    expect(popoverHeightFor(POPOVER_HEIGHT + POPOVER_SCREEN_MARGIN)).toBe(POPOVER_HEIGHT)
    expect(popoverHeightFor(500)).toBe(484)
    expect(popoverHeightFor(Number.NaN)).toBe(POPOVER_HEIGHT)
    electron.display.workArea.height = 450
    const { popover, win } = open('win32')
    expect(win.bounds?.height).toBe(434)
    // While it is open nothing moves it: the next size is computed at the next show.
    electron.display.workArea.height = 876
    popover.setView({} as TrayPopoverView)
    expect(win.bounds?.height).toBe(434)
    popover.hide()
    popover.show(tray)
    expect(win.bounds?.height).toBe(520)
  })

  it('has no resize channel any more: the page cannot change the window size', () => {
    const src = (...p: string[]) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf8')
    for (const file of [src('main', 'index.ts'), src('preload', 'index.ts'), src('shared', 'tray-api.ts'), src('renderer', 'screens', 'TrayPopover.tsx')]) {
      expect(file).not.toContain('trayPopover:resize')
      expect(file).not.toMatch(/popover\.resize\b/)
    }
    expect(src('renderer', 'screens', 'TrayPopover.tsx')).not.toContain('ResizeObserver')
    expect(TrayPopover.prototype).not.toHaveProperty('resize')
  })

  it('is isolated; native material and transparency only on macOS, a solid opaque window by theme elsewhere', () => {
    const mac = popoverWindowOptions('darwin', '/p.js')
    expect(mac).toMatchObject({ vibrancy: 'popover', transparent: true, hasShadow: true })
    expect(mac.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    for (const platform of ['win32', 'linux'] as const) {
      const dark = popoverWindowOptions(platform, '/p.js', true)
      expect(dark).toMatchObject({ transparent: false, backgroundColor: POPOVER_BACKGROUND.dark, hasShadow: true, skipTaskbar: true })
      expect(dark.vibrancy).toBeUndefined()
      expect(dark.roundedCorners).toBeUndefined()
      expect(popoverWindowOptions(platform, '/p.js', false).backgroundColor).toBe(POPOVER_BACKGROUND.light)
    }
    expect(POPOVER_BACKGROUND).toEqual({ dark: '#171a20', light: '#f3f4f6' })
  })

  it('repaints its solid background when the theme changes, on Windows only', () => {
    let dark = true
    const popover = new TrayPopover({ platform: 'win32', preload: '/p.js', load: () => undefined, refresh: () => undefined, pinned: true, dark: () => dark })
    popover.prepare()
    const win = electron.FakeWindow.last!
    dark = false
    popover.syncTheme()
    expect(win.background).toBe(POPOVER_BACKGROUND.light)
    const { popover: macPopover, win: macWin } = open('darwin')
    macPopover.syncTheme()
    expect(macWin.background).toBeNull()
  })

  it('opens the popover on macOS (no native menu) and Windows, and keeps the native menu on Windows right click and Linux', () => {
    expect(trayClickBehavior('darwin', true)).toEqual({ click: 'popover', menu: 'none' })
    expect(trayClickBehavior('darwin', false)).toEqual({ click: 'menu', menu: 'attached' })
    expect(trayClickBehavior('win32', true).click).toBe('popover')
    expect(trayClickBehavior('win32', false).click).toBe('activate')
    expect(trayClickBehavior('win32', true).menu).toBe('attached')
    expect(trayClickBehavior('linux', true)).toEqual({ click: 'menu', menu: 'attached' })
  })
})

const usage = (name: string, percent: number): TrayPopoverUsage => ({ name, window: { window: '5h', percent, tone: 'success' } })
const session = (id: string): TrayPopoverView['working'][number] => ({ id, title: id, state: 'starting', level: 'working' })

describe('tray popover panel rules', () => {
  it('folds "Usage" into one row with more than 3 accounts, the most spent first when unfolded', () => {
    const three = [usage('a', 10), usage('b', 80), usage('c', 30)]
    expect(usageBlock(three, false)).toEqual({ summary: null, rows: three })
    const five = [...three, usage('d', 95), usage('e', 4)]
    const folded = usageBlock(five, false)
    expect(folded.summary).toEqual({ count: 5, top: usage('d', 95) })
    expect(folded.rows).toEqual([])
    expect(usageBlock(five, true).rows.map((u) => u.name)).toEqual(['d', 'b', 'c', 'a', 'e'])
  })

  it('folds "Recent" by default while sessions need the user or work, unfolds it when none do, and remembers the choice per case', () => {
    const busy = { needsYou: [session('s1')], working: [] }
    const working = { needsYou: [], working: [session('s2')] }
    const quiet = { needsYou: [], working: [] }
    expect(recentExpanded(busy, {})).toBe(false)
    expect(recentExpanded(working, {})).toBe(false)
    expect(recentExpanded(quiet, {})).toBe(true)
    expect(recentExpanded(busy, { busy: true })).toBe(true)
    expect(recentExpanded(quiet, { busy: true })).toBe(true)
    expect(recentExpanded(quiet, { quiet: false })).toBe(false)
  })

  it('counts what is left past each quota as one "N more in the app" row that opens the matching list', () => {
    const view = { planMore: 2, needsYouMore: 3, workingMore: 0, notificationsMore: 1 }
    expect(overflowRow(view, 'plan')).toEqual({ count: 2, action: { kind: 'navigate', route: 'plan' } })
    expect(overflowRow(view, 'needsYou')).toEqual({ count: 3, action: { kind: 'navigate', route: 'sessions' } })
    expect(overflowRow(view, 'working')).toBeNull()
    expect(overflowRow(view, 'recent')).toEqual({ count: 1, action: { kind: 'open' } })
  })

  it('remembers the expanders in the renderer prefs, and drops anything malformed', () => {
    expect(DEFAULT_PREFS).toMatchObject({ trayPopoverUsageExpanded: false, trayPopoverRecent: {} })
    expect(parsePrefs(JSON.stringify({ trayPopoverUsageExpanded: true, trayPopoverRecent: { busy: true, quiet: 'x' } }))).toMatchObject({ trayPopoverUsageExpanded: true, trayPopoverRecent: { busy: true } })
    expect(parsePrefs(JSON.stringify({ trayPopoverRecent: [1] })).trayPopoverRecent).toEqual({})
  })

  it('words the quiet hours of the bell sub-view', () => {
    expect(quietHoursValue(null)).toEqual({ key: 'trayPopover.quietHours.off' })
    expect(quietHoursValue({ startHour: 22, endHour: 8 })).toEqual({ key: 'trayPopover.quietHours.range', params: { start: '22:00', end: '08:00' } })
  })
})

describe('tray popover renderer helpers', () => {
  it('splits the footer sub-views: the bell offers the pauses, quiet hours and the settings (Resume first while paused), "⋯" offers updates (when the build can) and quit', () => {
    const ids = (menu: 'notifications' | 'more', canCheckForUpdates: boolean, pausedUntil: number | null = null) => popoverMenuItems(menu, { canCheckForUpdates, pausedUntil }).map((i) => i.id)
    expect(ids('notifications', true)).toEqual(['pauseHour', 'pauseTomorrow', 'pauseIndefinite', 'quietHours', 'adjustNotifications'])
    expect(ids('notifications', true, 123)).toEqual(['resume', 'pauseHour', 'pauseTomorrow', 'pauseIndefinite', 'quietHours', 'adjustNotifications'])
    expect(ids('more', true)).toEqual(['checkForUpdates', 'quit'])
    expect(ids('more', false)).toEqual(['quit'])
    const bell = popoverMenuItems('notifications', { canCheckForUpdates: false, pausedUntil: null })
    expect(bell.map((i) => i.action)).toEqual([
      { kind: 'pause', preset: 'hour' },
      { kind: 'pause', preset: 'tomorrow' },
      { kind: 'pause', preset: 'indefinite' },
      { kind: 'openSettings', section: 'notifications' },
      { kind: 'openSettings', section: 'notifications' }
    ])
    expect(bell.map((i) => i.until ?? null)).toEqual(['hour', 'tomorrow', null, null, null])
    expect(bell.find((i) => i.id === 'quietHours')?.separated).toBe(true)
    expect(popoverMenuItems('notifications', { canCheckForUpdates: false, pausedUntil: 1 })[0]).toMatchObject({ action: { kind: 'resume' } })
    expect(popoverMenuItems('more', { canCheckForUpdates: true, pausedUntil: null }).at(-1)).toMatchObject({ action: { kind: 'quit' }, separated: true })
    expect(popoverMenuItems('more', { canCheckForUpdates: false, pausedUntil: null })[0]).toMatchObject({ separated: false })
    for (const menu of ['notifications', 'more'] as const)
      for (const item of popoverMenuItems(menu, { canCheckForUpdates: true, pausedUntil: 1 })) expect(trayPopoverEn[item.label as keyof typeof trayPopoverEn]).toBeDefined()
  })

  it('words a meeting countdown in minutes, then hours and minutes', () => {
    const now = 10_000_000_000
    expect(countdown(now + 12 * 60_000, now)).toEqual({ key: 'trayPopover.countdown.minutes', params: { minutes: 12 } })
    expect(countdown(now + 30_000, now)).toEqual({ key: 'trayPopover.countdown.minutes', params: { minutes: 1 } })
    expect(countdown(now + 160 * 60_000, now)).toEqual({ key: 'trayPopover.countdown.hoursMinutes', params: { hours: 2, minutes: 40 } })
    expect(countdown(now + 180 * 60_000, now)).toEqual({ key: 'trayPopover.countdown.hours', params: { hours: 3 } })
  })

  it('words elapsed time compactly', () => {
    const now = 10_000_000_000
    expect(elapsed(now - 30_000, now)).toBeNull()
    expect(elapsed(now - 5 * 60_000, now)).toBe('5m')
    expect(elapsed(now - 3 * 3_600_000, now)).toBe('3h')
    expect(elapsed(now - 2 * 86_400_000, now)).toBe('2d')
    expect(elapsed(now + 60_000, now)).toBeNull()
  })

  it('shows the attention level on the chip, else the plain state', () => {
    expect(sessionChip({ level: 'error', state: 'error' }).tone).toBe('danger')
    expect(sessionChip({ level: null, state: 'starting' }).key).toBe('trayPopover.state.starting')
    expect(sessionChip({ level: null, state: 'ready' }).key).toBe('trayPopover.state.idle')
  })

  it('moves focus with the arrow keys and wraps', () => {
    expect(nextFocus(-1, 3, 'ArrowDown')).toBe(0)
    expect(nextFocus(2, 3, 'ArrowDown')).toBe(0)
    expect(nextFocus(-1, 3, 'ArrowUp')).toBe(2)
    expect(nextFocus(0, 3, 'ArrowUp')).toBe(2)
    expect(nextFocus(1, 3, 'End')).toBe(2)
    expect(nextFocus(1, 0, 'ArrowDown')).toBeNull()
    expect(nextFocus(1, 3, 'a')).toBeNull()
  })

  it('has Spanish for every English key with the same placeholders', () => {
    expect(Object.keys(trayPopoverEs).sort()).toEqual(Object.keys(trayPopoverEn).sort())
    for (const key of Object.keys(trayPopoverEn) as (keyof typeof trayPopoverEn)[]) {
      expect(placeholders(trayPopoverEs[key])).toEqual(placeholders(trayPopoverEn[key]))
    }
  })
})
