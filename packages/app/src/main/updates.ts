import { app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/updates-api'

/** Where releases are published; must match the `publish` block of electron-builder.config.mjs. */
const RELEASES = 'https://github.com/SoldierIced/workhub/releases'

/**
 * Update checks over electron-updater against the GitHub Releases. Nothing runs unless the user
 * enabled the option or pressed "Check now". Unsigned macOS builds cannot replace themselves, so
 * there the update is only announced and the release page is opened to download it by hand.
 */
export class UpdateService {
  private current: UpdateStatus
  private wired = false

  constructor(private readonly onChanged: (status: UpdateStatus) => void) {
    this.current = { state: app.isPackaged ? 'idle' : 'unsupported', currentVersion: app.getVersion(), canInstall: this.canInstall() }
    if (!app.isPackaged) this.current.message = 'Updates are only checked in the packaged app.'
  }

  status(): UpdateStatus {
    return this.current
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.current
    this.wire()
    this.set({ state: 'checking', message: undefined })
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return this.current
  }

  async install(): Promise<UpdateStatus> {
    if (this.current.state !== 'available') return this.current
    if (!this.current.canInstall) {
      await shell.openExternal(this.current.releaseUrl ?? RELEASES)
      return this.current
    }
    this.set({ state: 'downloading' })
    try {
      await autoUpdater.downloadUpdate()
      autoUpdater.quitAndInstall()
    } catch (err) {
      this.set({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return this.current
  }

  private canInstall(): boolean {
    if (process.platform === 'darwin') return false
    if (process.platform === 'linux') return Boolean(process.env['APPIMAGE'])
    return true
  }

  private wire(): void {
    if (this.wired) return
    this.wired = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    // The project ships pre-releases (2.0.0-alpha.N) until it is stable.
    autoUpdater.allowPrerelease = app.getVersion().includes('-')
    autoUpdater.on('update-available', (info) =>
      this.set({ state: 'available', version: info.version, releaseUrl: `${RELEASES}/tag/v${info.version}`, message: undefined })
    )
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', version: undefined, releaseUrl: undefined }))
    autoUpdater.on('error', (err) => this.set({ state: 'error', message: err.message }))
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.current = { ...this.current, ...patch }
    this.onChanged(this.current)
  }
}
