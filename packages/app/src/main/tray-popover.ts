import { BrowserWindow, screen, type BrowserWindowConstructorOptions, type Rectangle, type WebContents } from 'electron'
import { popoverPlacement, type TrayPopoverView } from '@workhub/core'

export const POPOVER_WIDTH = 360
export const POPOVER_MIN_HEIGHT = 160
export const POPOVER_MAX_HEIGHT = 560
const FIRST_HEIGHT = 520
/** A click on the icon right after a blur closed the popover is the same click: don't reopen it. */
const REOPEN_GUARD_MS = 300

/**
 * The popover window: frameless, transparent and rounded, never in the Dock, the taskbar or the
 * app switcher, with the same isolation as every other window (sandboxed preload, no Node).
 * macOS draws it on the native popover material; elsewhere the page paints its own card.
 */
export function popoverWindowOptions(platform: NodeJS.Platform, preload: string): BrowserWindowConstructorOptions {
  const mac = platform === 'darwin'
  return {
    width: POPOVER_WIDTH,
    height: FIRST_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    title: 'Workhub',
    ...(mac ? { type: 'panel', vibrancy: 'popover', visualEffectState: 'active', roundedCorners: true, hiddenInMissionControl: true } : {}),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  }
}

/** The height the window takes for content of `natural` px. */
export function popoverHeight(natural: number): number {
  if (!Number.isFinite(natural)) return FIRST_HEIGHT
  return Math.round(Math.min(POPOVER_MAX_HEIGHT, Math.max(POPOVER_MIN_HEIGHT, natural)))
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
}

/** The window that opens from the menu bar / notification area icon. */
export class TrayPopover {
  private win: BrowserWindow | null = null
  private view: TrayPopoverView | null = null
  private anchor: Rectangle | null = null
  private height = FIRST_HEIGHT
  private hiddenAt = 0

  constructor(private readonly deps: TrayPopoverDeps) {}

  /** Creates the (hidden) window ahead of time, so the first click opens it at once. */
  prepare(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow(popoverWindowOptions(this.deps.platform, this.deps.preload))
    this.win = win
    if (this.deps.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.on('blur', () => {
      if (!this.deps.pinned) this.hide()
    })
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        this.hide()
      }
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    this.deps.load(win)
    return win
  }

  isVisible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible())
  }

  /** Whether `contents` is the popover's page (its own IPC: resize, hide). */
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
    this.place()
    win.show()
    win.focus()
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

  /** The content's natural height; the window follows it within the screen. */
  resize(natural: number): void {
    const height = popoverHeight(natural)
    if (height === this.height) return
    this.height = height
    if (this.isVisible()) this.place()
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

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
      height: this.height,
      fallback: cursor
    })
    win.setBounds({ x: p.x, y: p.y, width: p.width, height: p.height })
  }
}
