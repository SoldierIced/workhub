import type { BrowserWindow } from 'electron'
import { boundsOnScreen, isBounds, type SessionWindowSize, type WindowBounds } from './session-windows'

/** Settings in a window of its own (`#settings?section=…`): one at a time, kept open next to the sessions. */
export const SETTINGS_WINDOW_SIZE: SessionWindowSize = { width: 1180, height: 800, minWidth: 900, minHeight: 600 }

/** What the Settings window follows besides `config:changed` (sent to every window): the usage and update cards. */
export const SETTINGS_CHANNELS: ReadonlySet<string> = new Set(['usage:changed', 'usage:sessionBudgetsChanged', 'updates:changed'])

const SECTION = /^[A-Za-z][A-Za-z0-9]{0,39}$/

/** A section (or old tab) id from a renderer, or undefined when it is anything else; the renderer maps it to a section. */
export function settingsSectionArg(section: unknown): string | undefined {
  return typeof section === 'string' && SECTION.test(section) ? section : undefined
}

export function settingsWindowHash(section?: string): string {
  return section ? `#settings?section=${encodeURIComponent(section)}` : '#settings'
}

/** Where the window was when it last closed, across launches. */
export interface SavedSettingsWindow {
  bounds?: WindowBounds
}

export interface SettingsWindowDeps {
  /** `bounds`: the remembered place (already checked to be on a screen), else the default one. */
  create: (hash: string, size: SessionWindowSize, bounds?: WindowBounds) => BrowserWindow
  /** The work areas of the screens now. */
  screens: () => WindowBounds[]
  /** The app is quitting (or installing an update): closing never waits for the drafts then. */
  quitting: () => boolean
  store?: { load: (fallback: SavedSettingsWindow) => SavedSettingsWindow; save: (value: SavedSettingsWindow) => void; flush: () => void }
}

export class SettingsWindow {
  private win: BrowserWindow | null = null
  /** The window's forms hold unsaved drafts (the renderer says so): its close button asks first. */
  private dirty = false
  /** The renderer answered the drafts prompt: the next close goes through. */
  private closing = false
  private bounds: WindowBounds | undefined

  constructor(private readonly deps: SettingsWindowDeps) {
    const saved = deps.store?.load({}).bounds
    this.bounds = isBounds(saved) ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : undefined
  }

  /** Opens the window on `section`; an open one comes to the front and moves there (its drafts asked about first). */
  open(section?: string): void {
    const open = this.current()
    if (open) {
      if (open.isMinimized()) open.restore()
      open.show()
      open.focus()
      if (section) open.webContents.send('settings:navigate', section)
      return
    }
    const w = this.deps.create(settingsWindowHash(section), SETTINGS_WINDOW_SIZE, boundsOnScreen(this.bounds, this.deps.screens(), SETTINGS_WINDOW_SIZE))
    this.win = w
    this.dirty = false
    this.closing = false
    w.on('close', (event) => {
      if (this.dirty && !this.closing && !this.deps.quitting()) {
        event.preventDefault()
        w.webContents.send('settings:closeRequest')
        return
      }
      this.remember(w)
    })
    w.on('closed', () => {
      if (this.win === w) this.win = null
    })
  }

  /** The renderer of the Settings window reports whether its forms hold drafts. */
  setDirty(senderId: number, dirty: boolean): void {
    if (this.isSender(senderId)) this.dirty = dirty
  }

  /** The renderer closes its window once its drafts are saved or discarded. */
  close(senderId: number): void {
    const w = this.current()
    if (!w || !this.isSender(senderId)) return
    this.closing = true
    w.close()
  }

  /** Sends a channel the window follows (see SETTINGS_CHANNELS). */
  send(channel: string, args: unknown[]): void {
    const w = this.current()
    if (w && SETTINGS_CHANNELS.has(channel)) w.webContents.send(channel, ...args)
  }

  isWindow(w: BrowserWindow | null | undefined): boolean {
    return Boolean(w && w === this.current())
  }

  flush(): void {
    const w = this.current()
    if (w) this.remember(w)
    this.deps.store?.flush()
  }

  private current(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  private isSender(senderId: number): boolean {
    const w = this.current()
    return Boolean(w && w.webContents.id === senderId)
  }

  private remember(w: BrowserWindow): void {
    if (w.isDestroyed()) return
    const b = w.getBounds()
    if (!isBounds(b)) return
    this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
    this.deps.store?.save({ bounds: this.bounds })
  }
}
