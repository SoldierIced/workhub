import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {}, Menu: {}, nativeImage: {}, Tray: class {} }))

import { POPOVER_MAX_HEIGHT, POPOVER_MIN_HEIGHT, popoverHeight, popoverWindowOptions } from '../src/main/tray-popover'
import { trayClickBehavior } from '../src/main/tray'
import { countdown, elapsed, nextFocus, popoverMenuItems, sessionChip } from '../src/renderer/lib/trayPopover'
import { trayPopoverEn } from '../src/renderer/i18n/trayPopover.en'
import { trayPopoverEs } from '../src/renderer/i18n/trayPopover.es'
import { placeholders } from '../src/renderer/i18n/translate'

describe('tray popover window', () => {
  it('follows the content height within bounds', () => {
    expect(popoverHeight(10)).toBe(POPOVER_MIN_HEIGHT)
    expect(popoverHeight(5000)).toBe(POPOVER_MAX_HEIGHT)
    expect(popoverHeight(300.4)).toBe(300)
    expect(popoverHeight(Number.NaN)).toBeGreaterThanOrEqual(POPOVER_MIN_HEIGHT)
  })

  it('is isolated, and native-material only on macOS', () => {
    const mac = popoverWindowOptions('darwin', '/p.js')
    expect(mac.vibrancy).toBe('popover')
    expect(mac.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    const win = popoverWindowOptions('win32', '/p.js')
    expect(win.vibrancy).toBeUndefined()
    expect(win.skipTaskbar).toBe(true)
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

describe('tray popover renderer helpers', () => {
  it('splits the footer menus: the bell offers the pauses and the settings (Resume first while paused), "⋯" offers updates (when the build can) and quit', () => {
    const ids = (menu: 'notifications' | 'more', canCheckForUpdates: boolean, pausedUntil: number | null = null) => popoverMenuItems(menu, { canCheckForUpdates, pausedUntil }).map((i) => i.id)
    expect(ids('notifications', true)).toEqual(['pauseHour', 'pauseTomorrow', 'pauseIndefinite', 'adjustNotifications'])
    expect(ids('notifications', true, 123)).toEqual(['resume', 'pauseHour', 'pauseTomorrow', 'pauseIndefinite', 'adjustNotifications'])
    expect(ids('more', true)).toEqual(['checkForUpdates', 'quit'])
    expect(ids('more', false)).toEqual(['quit'])
    const bell = popoverMenuItems('notifications', { canCheckForUpdates: false, pausedUntil: null })
    expect(bell.map((i) => i.action)).toEqual([
      { kind: 'pause', preset: 'hour' },
      { kind: 'pause', preset: 'tomorrow' },
      { kind: 'pause', preset: 'indefinite' },
      { kind: 'openSettings', section: 'notifications' }
    ])
    expect(bell.at(-1)?.separated).toBe(true)
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
