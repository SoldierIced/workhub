import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { buildTrayMenu, trayBadge, type TrayAction, type TrayItem, type TrayState, type TrayText } from '@workhub/core'

export interface TrayIconFiles {
  normal: string
  /** Shown while something needs the user; macOS keeps the template and shows a count instead. */
  attention: string
}

/**
 * The icon files per platform, in the folder make-icons.mjs writes (packages/app/build/tray, shipped
 * as <resources>/tray). macOS: a template image (its @2x sibling is picked up by name), tinted by
 * the menu bar for light and dark. Windows: .ico files. Linux: PNGs (AppIndicator ignores templates).
 */
export function trayIconFiles(platform: NodeJS.Platform, dir: string): TrayIconFiles {
  if (platform === 'darwin') return { normal: join(dir, 'trayTemplate.png'), attention: join(dir, 'trayTemplate.png') }
  if (platform === 'win32') return { normal: join(dir, 'tray.ico'), attention: join(dir, 'tray-attention.ico') }
  return { normal: join(dir, 'tray.png'), attention: join(dir, 'tray-attention.png') }
}

/** The native menu template for the model; actions call `perform`. */
export function menuTemplate(items: readonly TrayItem[], perform: (action: TrayAction) => void): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    switch (item.type) {
      case 'separator':
        return { type: 'separator' }
      case 'label':
        return { label: item.label, enabled: false }
      case 'action':
        return { label: item.label, click: () => perform(item.action) }
      case 'submenu':
        return { label: item.label, submenu: menuTemplate(item.items, perform) }
    }
  })
}

export interface TrayServiceDeps {
  appName: string
  platform: NodeJS.Platform
  iconDir: string
  state: () => Promise<TrayState>
  text: () => TrayText
  perform: (action: TrayAction) => void
  /** A plain click on the icon (Windows; Linux and macOS open the menu instead). */
  activate: () => void
  /** WORKHUB_TRAY_LOG: a run can read back the menu, title and tooltip without opening the menu. */
  logPath?: string
}

/** The menu bar / notification area icon: its menu, count and tooltip follow the app's state. */
export class TrayService {
  private tray: Tray | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private refreshing = false
  private again = false
  private lastAttention: boolean | null = null

  constructor(private readonly deps: TrayServiceDeps) {}

  start(): void {
    if (this.tray) return
    const files = trayIconFiles(this.deps.platform, this.deps.iconDir)
    const image = nativeImage.createFromPath(files.normal)
    if (this.deps.platform === 'darwin') image.setTemplateImage(true)
    this.tray = new Tray(image)
    this.tray.setToolTip(this.deps.appName)
    if (this.deps.platform === 'darwin') this.tray.setIgnoreDoubleClickEvents(true)
    // Windows: a click opens the window and a right click the menu, as notification area icons do.
    if (this.deps.platform === 'win32') this.tray.on('click', () => this.deps.activate())
    void this.refresh()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.tray?.destroy()
    this.tray = null
  }

  /** Rebuilds soon; many changes in a row rebuild once. */
  schedule(delayMs = 250): void {
    if (!this.tray || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delayMs)
  }

  async refresh(): Promise<void> {
    if (!this.tray) return
    if (this.refreshing) {
      this.again = true
      return
    }
    this.refreshing = true
    try {
      const state = await this.deps.state()
      const text = this.deps.text()
      const tray = this.tray
      if (!tray || tray.isDestroyed()) return
      const badge = trayBadge(state, text)
      const items = buildTrayMenu(state, text)
      tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(items, this.deps.perform)))
      if (this.deps.logPath) writeFileSync(this.deps.logPath, JSON.stringify({ badge, items }, null, 2))
      tray.setToolTip(badge.tooltip)
      if (this.deps.platform === 'darwin') tray.setTitle(badge.title, { fontType: 'monospacedDigit' })
      const attention = badge.count > 0
      if (this.deps.platform !== 'darwin' && attention !== this.lastAttention) {
        const files = trayIconFiles(this.deps.platform, this.deps.iconDir)
        tray.setImage(nativeImage.createFromPath(attention ? files.attention : files.normal))
      }
      this.lastAttention = attention
    } catch {
      // A source that failed leaves the last menu in place; the next refresh tries again.
    } finally {
      this.refreshing = false
      if (this.again) {
        this.again = false
        this.schedule()
      }
    }
  }
}
