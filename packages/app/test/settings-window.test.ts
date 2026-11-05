import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { ConfigStore, WorkhubConfig } from '@workhub/core'
import { broadcastingConfigStore } from '../src/main/config-broadcast'
import type { WindowBounds } from '../src/main/session-windows'
import { SETTINGS_WINDOW_SIZE, SettingsWindow, settingsSectionArg, settingsWindowHash, type SavedSettingsWindow } from '../src/main/settings-window'
import { parseSettingsHash, reportDirty } from '../src/renderer/screens/SettingsWindow'
import { createUnsavedChanges } from '../src/renderer/lib/unsavedChanges'

describe('Settings window route', () => {
  it('reads the section from the hash, mapping old tab ids', () => {
    expect(parseSettingsHash('#settings')).toEqual({ section: 'general' })
    expect(parseSettingsHash('#settings?section=usage')).toEqual({ section: 'usage' })
    expect(parseSettingsHash('#settings?section=trackers')).toEqual({ section: 'tickets' })
    expect(parseSettingsHash('#settings?section=nonsense')).toEqual({ section: 'general' })
    expect(parseSettingsHash(settingsWindowHash('aiReview'))).toEqual({ section: 'aiReview' })
    expect(parseSettingsHash(settingsWindowHash())).toEqual({ section: 'general' })
    expect(parseSettingsHash(settingsWindowHash('general#updates'))).toEqual({ section: 'general', group: 'updates' })
    expect(parseSettingsHash(settingsWindowHash('trackers#x'))).toEqual({ section: 'tickets', group: 'x' })
  })

  it('leaves every other window hash alone', () => {
    expect(parseSettingsHash('')).toBeNull()
    expect(parseSettingsHash('#session?id=a')).toBeNull()
    expect(parseSettingsHash('#settingsx')).toBeNull()
    expect(parseSettingsHash('#/ticket?profile=p&key=ACME-1')).toBeNull()
  })

  it('accepts only plain section ids from a renderer', () => {
    expect(settingsSectionArg('flowMaps')).toBe('flowMaps')
    expect(settingsSectionArg('general#updates')).toBe('general#updates')
    expect(settingsSectionArg('general#')).toBeUndefined()
    expect(settingsSectionArg('general#a#b')).toBeUndefined()
    expect(settingsSectionArg(undefined)).toBeUndefined()
    expect(settingsSectionArg('')).toBeUndefined()
    expect(settingsSectionArg('../x')).toBeUndefined()
    expect(settingsSectionArg(42)).toBeUndefined()
    expect(settingsSectionArg('a'.repeat(41))).toBeUndefined()
  })
})

describe('reportDirty', () => {
  it('tells main only when the drafts turn dirty or clean', () => {
    const unsaved = createUnsavedChanges()
    const reports: boolean[] = []
    const off = reportDirty(unsaved, (d) => reports.push(d))
    const form = { dirty: false, save: async () => ({ ok: true as const }), discard: () => (form.dirty = false) }
    unsaved.register('a', form)
    form.dirty = true
    unsaved.refresh()
    unsaved.refresh()
    unsaved.discardAll()
    off()
    form.dirty = true
    unsaved.refresh()
    expect(reports).toEqual([true, false])
  })
})

class FakeWindow extends EventEmitter {
  destroyed = false
  focused = 0
  closes = 0
  readonly sent: [string, ...unknown[]][] = []
  readonly webContents = { id: Math.floor(Math.random() * 1e9), send: (channel: string, ...args: unknown[]) => void this.sent.push([channel, ...args]) }
  constructor(
    readonly hash: string,
    public bounds: WindowBounds
  ) {
    super()
  }
  isDestroyed() {
    return this.destroyed
  }
  getBounds() {
    return this.bounds
  }
  isMinimized() {
    return false
  }
  restore() {}
  show() {}
  focus() {
    this.focused++
  }
  /** Like Electron: 'close' can be prevented; otherwise the window goes and 'closed' fires. */
  close() {
    this.closes++
    let prevented = false
    this.emit('close', { preventDefault: () => (prevented = true) })
    if (prevented) return
    this.destroyed = true
    this.emit('closed')
  }
}

function harness(saved: SavedSettingsWindow = {}) {
  let stored = saved
  let quitting = false
  const created: { hash: string; bounds?: WindowBounds; win: FakeWindow }[] = []
  const settings = new SettingsWindow({
    create: (hash, size, bounds) => {
      const win = new FakeWindow(hash, bounds ?? { x: 0, y: 0, width: size.width, height: size.height })
      created.push({ hash, bounds, win })
      return win as unknown as BrowserWindow
    },
    screens: () => [{ x: 0, y: 0, width: 1920, height: 1080 }],
    quitting: () => quitting,
    store: { load: (fallback) => ({ ...fallback, ...stored }), save: (v) => (stored = v), flush: () => undefined }
  })
  return { settings, created, stored: () => stored, quit: () => (quitting = true) }
}

describe('SettingsWindow', () => {
  it('keeps one window: opening again focuses it and moves it to the section', () => {
    const { settings, created } = harness()
    settings.open('usage')
    expect(created.map((c) => c.hash)).toEqual(['#settings?section=usage'])
    const win = created[0]!.win
    settings.open('slack')
    settings.open()
    expect(created).toHaveLength(1)
    expect(win.focused).toBe(2)
    expect(win.sent).toEqual([['settings:navigate', 'slack']])
    expect(settings.isWindow(win as unknown as BrowserWindow)).toBe(true)
  })

  it('opens a new window once the previous one closed, where it was', () => {
    const { settings, created, stored } = harness()
    settings.open()
    const first = created[0]!.win
    first.bounds = { x: 100, y: 120, width: 1000, height: 700 }
    first.close()
    expect(stored()).toEqual({ bounds: { x: 100, y: 120, width: 1000, height: 700 } })
    settings.open('general')
    expect(created).toHaveLength(2)
    expect(created[1]!.bounds).toEqual({ x: 100, y: 120, width: 1000, height: 700 })
  })

  it('starts from remembered bounds that still fit a screen, else the default place', () => {
    const fits = harness({ bounds: { x: 10, y: 20, width: 1200, height: 820 } })
    fits.settings.open()
    expect(fits.created[0]!.bounds).toEqual({ x: 10, y: 20, width: 1200, height: 820 })
    const off = harness({ bounds: { x: 9000, y: 9000, width: 1200, height: 820 } })
    off.settings.open()
    expect(off.created[0]!.bounds).toBeUndefined()
    expect(off.created[0]!.win.bounds.width).toBe(SETTINGS_WINDOW_SIZE.width)
  })

  it('asks the renderer about unsaved drafts before its close button closes it', () => {
    const { settings, created } = harness()
    settings.open()
    const win = created[0]!.win
    settings.setDirty(win.webContents.id, true)
    win.close()
    expect(win.destroyed).toBe(false)
    expect(win.sent).toEqual([['settings:closeRequest']])
    // Another window cannot close it or change what it reported.
    settings.close(win.webContents.id + 1)
    settings.setDirty(win.webContents.id + 1, false)
    expect(win.destroyed).toBe(false)
    // The drafts were saved or discarded: the renderer closes it.
    settings.close(win.webContents.id)
    expect(win.destroyed).toBe(true)
  })

  it('closes at once when nothing is unsaved, or when the app quits', () => {
    const clean = harness()
    clean.settings.open()
    clean.created[0]!.win.close()
    expect(clean.created[0]!.win.destroyed).toBe(true)

    const quitting = harness()
    quitting.settings.open()
    const win = quitting.created[0]!.win
    quitting.settings.setDirty(win.webContents.id, true)
    quitting.quit()
    win.close()
    expect(win.destroyed).toBe(true)
  })

  it('forwards only the channels its cards follow', () => {
    const { settings, created } = harness()
    settings.send('usage:changed', [[]])
    settings.open()
    const win = created[0]!.win
    settings.send('usage:changed', [[1]])
    settings.send('session:event', ['a'])
    expect(win.sent).toEqual([['usage:changed', [1]]])
  })
})

describe('broadcastingConfigStore', () => {
  afterEach(() => vi.useRealTimers())

  it('tells every window once after writes land', async () => {
    vi.useFakeTimers()
    const saved: unknown[] = []
    const inner: ConfigStore = { load: async () => ({}) as WorkhubConfig, save: async (c) => void saved.push(c) }
    const changed = vi.fn()
    const store = broadcastingConfigStore(inner, changed)
    await store.save({ a: 1 } as unknown as WorkhubConfig)
    await store.save({ a: 2 } as unknown as WorkhubConfig)
    expect(saved).toHaveLength(2)
    expect(changed).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(changed).toHaveBeenCalledTimes(1)
    await store.save({ a: 3 } as unknown as WorkhubConfig)
    await vi.runAllTimersAsync()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('tells nobody when the write fails', async () => {
    vi.useFakeTimers()
    const changed = vi.fn()
    const store = broadcastingConfigStore({ load: async () => ({}) as WorkhubConfig, save: async () => Promise.reject(new Error('disk full')) }, changed)
    await expect(store.save({} as WorkhubConfig)).rejects.toThrow('disk full')
    await vi.runAllTimersAsync()
    expect(changed).not.toHaveBeenCalled()
  })
})
