import { app, BrowserWindow, screen, type BrowserWindowConstructorOptions, type Rectangle, type WebContents } from 'electron'
import { popoverPlacement, type TrayPopoverView } from '@workhub/core'

export const POPOVER_WIDTH = 360
/** One fixed height, also with nothing to show: the window never changes size while it is open. */
export const POPOVER_HEIGHT = 520
/** Room kept free on a work area too short for the full height. */
export const POPOVER_SCREEN_MARGIN = 16
/** The solid page colour of the window where it has no native material (Windows, Linux). */
export const POPOVER_BACKGROUND = { dark: '#171a20', light: '#f3f4f6' } as const
/** A click on the icon right after a blur closed the popover is the same click: don't reopen it. */
const REOPEN_GUARD_MS = 300

export function popoverBackground(dark: boolean): string {
  return dark ? POPOVER_BACKGROUND.dark : POPOVER_BACKGROUND.light
}

/**
 * The popover window: frameless, a fixed 360x520 (DIP), never in the Dock, the taskbar or the app
 * switcher, with the same isolation as every other window (sandboxed preload, no Node).
 * macOS draws it on the native popover material behind a transparent page. Windows and Linux get
 * an opaque window with a solid colour by theme and the system shadow: a transparent window there
 * shows an empty rectangle and flickers while it is shown.
 */
export function popoverWindowOptions(platform: NodeJS.Platform, preload: string, dark = true): BrowserWindowConstructorOptions {
  const mac = platform === 'darwin'
  return {
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    show: false,
    frame: false,
    transparent: mac,
    backgroundColor: mac ? '#00000000' : popoverBackground(dark),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    title: 'Workhub',
    // Not a 'panel': a non-activating panel never becomes key, so it never blurs and stays open.
    ...(mac ? { vibrancy: 'popover', visualEffectState: 'active', roundedCorners: true, hiddenInMissionControl: true } : {}),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  }
}

/** The window's height on a work area `workAreaHeight` tall: the fixed height, or less on a short screen. */
export function popoverHeightFor(workAreaHeight: number): number {
  if (!Number.isFinite(workAreaHeight) || workAreaHeight >= POPOVER_HEIGHT + POPOVER_SCREEN_MARGIN) return POPOVER_HEIGHT
  return Math.max(1, Math.floor(workAreaHeight - POPOVER_SCREEN_MARGIN))
}

export interface TrayPopoverDeps {
  platform: NodeJS.Platform
  preload: string
  /** Loads the renderer's popover route into the window. */
  load: (win: BrowserWindow) => void
  /** Asked on every show, so the view is fresh. */
  refresh: () => void
  /** WORKHUB_TRAY_POPOVER_PIN: stays open on blur (screenshots, smoke runs). */
  pinned?: boolean
  /** Whether the app looks dark now (nativeTheme), for the solid background on Windows and Linux. */
  dark?: () => boolean
}

/** The window that opens from the menu bar / notification area icon. */
export class TrayPopover {
  private win: BrowserWindow | null = null
  private view: TrayPopoverView | null = null
  private anchor: Rectangle | null = null
  private hiddenAt = 0

  constructor(private readonly deps: TrayPopoverDeps) {
    // Switching to another app (or a Space showing one) closes it even if the window missed its blur.
    if (deps.platform === 'darwin' && !deps.pinned) app.on('did-resign-active', () => this.hide())
  }

  /** Creates the (hidden) window ahead of time, so the first click opens it at once. */
  prepare(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow(popoverWindowOptions(this.deps.platform, this.deps.preload, this.dark()))
    this.win = win
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.on('blur', () => {
      if (!this.deps.pinned) this.hide()
    })
    // Escape belongs to the page: it leaves a sub-view first and closes the popover from the main view.
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    this.deps.load(win)
    return win
  }

  isVisible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible())
  }

  /** Whether `contents` is the popover's page (its own IPC: hide). */
  owns(contents: WebContents): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.webContents === contents)
  }

  isWindow(win: BrowserWindow): boolean {
    return this.win === win
  }

  toggle(trayBounds: Rectangle): void {
    if (this.isVisible()) return this.hide()
    if (Date.now() - this.hiddenAt < REOPEN_GUARD_MS) return
    this.show(trayBounds)
  }

  show(trayBounds: Rectangle): void {
    const win = this.prepare()
    this.anchor = trayBounds
    this.deps.refresh()
    this.syncTheme()
    this.place()
    // Open on the current Space (also over a full-screen app), then pin it there: switching Spaces
    // leaves it behind and the blur that follows closes it.
    const mac = this.deps.platform === 'darwin'
    if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.show()
    win.focus()
    if (mac) win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true })
    win.webContents.send('trayPopover:shown')
  }

  hide(): void {
    if (!this.isVisible()) return
    this.hiddenAt = Date.now()
    this.win!.hide()
  }

  setView(view: TrayPopoverView): void {
    this.view = view
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('trayPopover:view', view)
  }

  currentView(): TrayPopoverView | null {
    return this.view
  }

  /** Windows and Linux: the solid background follows the light or dark look (nativeTheme `updated`). */
  syncTheme(): void {
    if (this.deps.platform === 'darwin' || !this.win || this.win.isDestroyed()) return
    this.win.setBackgroundColor(popoverBackground(this.dark()))
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  private dark(): boolean {
    return this.deps.dark?.() ?? true
  }

  /**
   * Places the window for the display under the icon (or the cursor), in DIP: Electron scales per
   * monitor, so the size stays 360x520 on every display. Only at show, never while it is open.
   */
  private place(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const anchor = this.anchor && (this.anchor.width > 0 || this.anchor.height > 0) ? this.anchor : null
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getDisplayNearestPoint(cursor)
    const p = popoverPlacement({
      tray: anchor ?? { x: 0, y: 0, width: 0, height: 0 },
      workArea: display.workArea,
      display: display.bounds,
      width: POPOVER_WIDTH,
      height: popoverHeightFor(display.workArea.height),
      fallback: cursor
    })
    win.setBounds({ x: p.x, y: p.y, width: p.width, height: p.height })
  }
}
