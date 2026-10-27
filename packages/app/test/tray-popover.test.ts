import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {}, Menu: {}, nativeImage: {}, Tray: class {} }))

import { POPOVER_MAX_HEIGHT, POPOVER_MIN_HEIGHT, popoverHeight, popoverWindowOptions } from '../src/main/tray-popover'
import { trayClickBehavior } from '../src/main/tray'
import { agentGlyph, elapsed, nextFocus, sessionChip } from '../src/renderer/lib/trayPopover'
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

  it('opens on click on macOS and Windows, and keeps the native menu on Linux', () => {
    expect(trayClickBehavior('darwin', true)).toEqual({ click: 'popover', menu: 'rightClick' })
    expect(trayClickBehavior('darwin', false)).toEqual({ click: 'menu', menu: 'attached' })
    expect(trayClickBehavior('win32', true).click).toBe('popover')
    expect(trayClickBehavior('win32', false).click).toBe('activate')
    expect(trayClickBehavior('linux', true)).toEqual({ click: 'menu', menu: 'attached' })
  })
})

describe('tray popover renderer helpers', () => {
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

  it('gives every agent a stable mark', () => {
    expect(agentGlyph('claude-code').letter).toBe('C')
    expect(agentGlyph(undefined).letter).toBe('?')
    expect(agentGlyph('zed')).toEqual(agentGlyph('zed'))
  })

  it('has Spanish for every English key with the same placeholders', () => {
    expect(Object.keys(trayPopoverEs).sort()).toEqual(Object.keys(trayPopoverEn).sort())
    for (const key of Object.keys(trayPopoverEn) as (keyof typeof trayPopoverEn)[]) {
      expect(placeholders(trayPopoverEs[key])).toEqual(placeholders(trayPopoverEn[key]))
    }
  })
})
