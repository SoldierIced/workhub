import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'node:path'
import type { UpdateStatus } from '../shared/updates-api'
import { bundleOf, canSelfUpdate, installMacUpdate, nodeMacUpdateDeps, type MacUpdateDeps } from './mac-update'
import { pickReleaseTag, type ReleaseSummary } from './release-pick'

/** `owner/name` from scripts/brand.mjs, set at build time by electron.vite.config.ts (`define`). */
declare const __WORKHUB_RELEASE_REPO__: string | undefined

/** The repository releases are published to; tests run unbundled, without the build-time value. */
export const RELEASE_REPO = typeof __WORKHUB_RELEASE_REPO__ === 'string' ? __WORKHUB_RELEASE_REPO__ : 'example/workhub'
/** Where releases are published; the same repository as the `publish` block of electron-builder.config.mjs. */
const RELEASES = `https://github.com/${RELEASE_REPO}/releases`

/** The newest releases, as the GitHub API lists them (drafts are not visible without a token). */
export type FetchReleases = () => Promise<ReleaseSummary[]>
const fetchReleasesFromGitHub: FetchReleases = async () => {
  const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=10`, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  return (await res.json()) as ReleaseSummary[]
}

/**
 * Update checks over electron-updater against the GitHub Releases. Nothing runs unless the user
 * enabled the option or pressed "Check now". Installing downloads the new version and leaves it
 * ready; the user then restarts now or later. Unsigned macOS builds cannot use Squirrel.Mac, so
 * there the app swaps its own bundle (as scripts/install.sh does) when it can write to its folder,
 * and otherwise opens the release page.
 */
export class UpdateService {
  private current: UpdateStatus
  private wired = false
  /** The macOS zip of the version found, from the release's latest-mac.yml. */
  private macZip: string | undefined

  constructor(
    private readonly onChanged: (status: UpdateStatus) => void,
    private readonly openUrl: (url: string) => Promise<void>,
    private readonly mac: MacUpdateDeps = nodeMacUpdateDeps,
    private readonly fetchReleases: FetchReleases = fetchReleasesFromGitHub
  ) {
    this.current = { state: app.isPackaged ? 'idle' : 'unsupported', currentVersion: app.getVersion(), canInstall: process.platform !== 'darwin' && this.canInstallElsewhere() }
    if (!app.isPackaged) this.current.message = 'Updates are only checked in the packaged app.'
  }

  status(): UpdateStatus {
    return this.current
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.current
    if (this.current.state === 'downloading' || this.current.state === 'ready') return this.current
    this.wire()
    this.set({ state: 'checking', message: undefined, canInstall: await this.canInstall() })
    try {
      // electron-updater follows the newest tag, which exists before its installers are uploaded
      // (and for drafts). Point it at the newest release that has them; without the API, check as before.
      const releases = await this.fetchReleases().catch(() => null)
      if (releases) {
        const tag = pickReleaseTag(releases, { prerelease: autoUpdater.allowPrerelease, platform: process.platform })
        if (!tag) {
          this.set({ state: 'none', version: undefined, releaseUrl: undefined })
          return this.current
        }
        autoUpdater.setFeedURL({ provider: 'generic', url: `${RELEASES}/download/${tag}` })
      }
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return this.current
  }

  /** Downloads and installs the version found; it runs from the next launch (see `restart`). */
  async install(): Promise<UpdateStatus> {
    if (this.current.state !== 'available') return this.current
    if (!this.current.canInstall) {
      await this.openUrl(this.current.releaseUrl ?? RELEASES)
      return this.current
    }
    this.set({ state: 'downloading', message: undefined })
    try {
      if (process.platform === 'darwin') await this.installOnMac()
      else {
        await autoUpdater.downloadUpdate()
        // "Later" still installs it, when the app quits.
        autoUpdater.autoInstallOnAppQuit = true
      }
      this.set({ state: 'ready' })
    } catch (err) {
      // Back to `available` with the reason: Install and Check now both work again.
      this.set({ state: 'available', message: err instanceof Error ? err.message : String(err) })
    }
    return this.current
  }

  /** Restarts into the installed update. */
  restart(): void {
    if (this.current.state !== 'ready') return
    if (process.platform !== 'darwin') return autoUpdater.quitAndInstall()
    app.relaunch()
    app.quit()
  }

  private async installOnMac(): Promise<void> {
    const bundle = bundleOf(app.getPath('exe'))
    if (!bundle || !this.macZip || !this.current.version) throw new Error('this copy of the app cannot replace itself')
    const appId = (await this.mac.run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(bundle, 'Contents', 'Info.plist')])).trim()
    await installMacUpdate({ zipUrl: `${RELEASES}/download/v${this.current.version}/${this.macZip}`, bundle, appId }, this.mac)
  }

  private async canInstall(): Promise<boolean> {
    if (process.platform === 'darwin') return canSelfUpdate(app.getPath('exe'), this.mac)
    return this.canInstallElsewhere()
  }

  private canInstallElsewhere(): boolean {
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
    autoUpdater.on('update-available', (info) => {
      this.macZip = info.files.find((f) => f.url.endsWith(`-${process.arch}.zip`))?.url ?? info.files.find((f) => f.url.endsWith('.zip'))?.url
      this.set({ state: 'available', version: info.version, releaseUrl: `${RELEASES}/tag/v${info.version}`, message: undefined })
    })
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', version: undefined, releaseUrl: undefined }))
    autoUpdater.on('error', (err) => {
      // The macOS install does not go through electron-updater; its errors are reported by install().
      if (this.current.state !== 'downloading') this.set({ state: 'error', message: err.message })
    })
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.current = { ...this.current, ...patch }
    this.onChanged(this.current)
  }
}
