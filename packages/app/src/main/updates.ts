import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'node:path'
import { RELEASE_NOTES_FILE, RELEASE_NOTES_LIMITS, compareVersions, notesBetween, parseReleaseNotes, type ReleaseNotesEntry } from '../shared/release-notes'
import type { UpdateStatus } from '../shared/updates-api'
import { demoUpdate } from './demo-update'
import { bundleOf, canSelfUpdate, installMacUpdate, nodeMacUpdateDeps, type MacUpdateDeps } from './mac-update'
import { pickRelease, type ReleaseSummary } from './release-pick'

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

/** The parsed `release-notes.json` of the release with this tag; rejects when it cannot be read. */
export type FetchNotes = (tag: string) => Promise<unknown>
const NOTES_TIMEOUT_MS = 8_000
/**
 * One request for a release asset (not the GitHub API, so no rate limit), bounded in time and in
 * size: the file is small, and a slow or huge answer must not hold the update back.
 */
export const fetchNotesFromGitHub = async (tag: string, request: typeof fetch = fetch): Promise<unknown> => {
  const res = await request(`${RELEASES}/download/${encodeURIComponent(tag)}/${RELEASE_NOTES_FILE}`, { signal: AbortSignal.timeout(NOTES_TIMEOUT_MS) })
  if (!res.ok || !res.body) throw new Error(`release notes: HTTP ${res.status}`)
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > RELEASE_NOTES_LIMITS.bytes) throw new Error('release notes: the file is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export interface UpdateServiceOptions {
  fetchNotes?: FetchNotes
  /** WORKHUB_DEMO_UPDATE=1 in a run that is not packaged: a sample update with notes (demo-update.ts). */
  demo?: boolean
}

/**
 * Update checks over electron-updater against the GitHub Releases. Nothing runs unless the user
 * enabled the option or pressed "Check now". Installing downloads the new version and leaves it
 * ready; the user then restarts now or later. Unsigned macOS builds cannot use Squirrel.Mac, so
 * there the app swaps its own bundle (as scripts/install.sh does) when it can write to its folder,
 * and otherwise opens the release page.
 *
 * A release may carry `release-notes.json` (what changed, for users): it is read before the version
 * is announced, so the status that says "available" already has the notes of every version after
 * the running one. Reading them never fails a check.
 */
export class UpdateService {
  private current: UpdateStatus
  private wired = false
  /** The macOS zip of the version found, from the release's latest-mac.yml. */
  private macZip: string | undefined
  /** What the release `notesTag` says changed, and whether the file of the one being checked could not be read. */
  private releaseNotes: ReleaseNotesEntry[] = []
  private notesTag: string | undefined
  private notesFailed = false
  private readonly fetchNotes: FetchNotes
  private readonly demo: boolean

  constructor(
    private readonly onChanged: (status: UpdateStatus) => void,
    private readonly openUrl: (url: string) => Promise<void>,
    private readonly mac: MacUpdateDeps = nodeMacUpdateDeps,
    private readonly fetchReleases: FetchReleases = fetchReleasesFromGitHub,
    options: UpdateServiceOptions = {}
  ) {
    this.fetchNotes = options.fetchNotes ?? ((tag) => fetchNotesFromGitHub(tag))
    // Never in an installed app: there the variable would hide the real state of its updates.
    this.demo = options.demo === true && !app.isPackaged
    this.current = { state: app.isPackaged ? 'idle' : 'unsupported', currentVersion: app.getVersion(), canInstall: process.platform !== 'darwin' && this.canInstallElsewhere() }
    if (this.demo) this.current = this.demoStatus()
    else if (!app.isPackaged) this.current.message = 'Updates are only checked in the packaged app.'
  }

  /** The sample update: it cannot be installed, so "Update" opens the list of releases. */
  private demoStatus(): UpdateStatus {
    const sample = demoUpdate(app.getVersion())
    return { state: 'available', currentVersion: app.getVersion(), version: sample.version, releaseUrl: RELEASES, changesUrl: RELEASES, canInstall: false, notes: sample.notes }
  }

  status(): UpdateStatus {
    return this.current
  }

  async check(): Promise<UpdateStatus> {
    if (this.demo) {
      this.set(this.demoStatus())
      return this.current
    }
    if (!app.isPackaged) return this.current
    if (this.current.state === 'downloading' || this.current.state === 'ready') return this.current
    this.wire()
    // The notes shown belong to this check; what was read stays for the same release (readNotes).
    this.notesFailed = false
    this.set({ state: 'checking', message: undefined, notes: undefined, notesError: undefined, canInstall: await this.canInstall() })
    try {
      // electron-updater follows the newest tag, which exists before its installers are uploaded
      // (and for drafts). Point it at the newest release that has them. Without the API there is no
      // way to tell which release is complete, so report that instead of a misleading 404.
      const releases = await this.fetchReleases().catch((err: unknown) => {
        throw new Error(`Could not reach GitHub to list releases (${err instanceof Error ? err.message : String(err)}). Try again later.`)
      })
      const release = pickRelease(releases, { prerelease: autoUpdater.allowPrerelease, platform: process.platform })
      if (!release) {
        this.set({ state: 'none', version: undefined, releaseUrl: undefined, changesUrl: undefined })
        return this.current
      }
      const tag = release.tag_name
      await this.readNotes(release)
      autoUpdater.setFeedURL({ provider: 'generic', url: `${RELEASES}/download/${tag}` })
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
    // Silent: the assisted NSIS installer (oneClick: false) would otherwise open its wizard and wait.
    if (process.platform !== 'darwin') return autoUpdater.quitAndInstall(true, true)
    app.relaunch()
    app.quit()
  }

  /**
   * Reads what the release says changed, while the state is still `checking`. Only when it is newer
   * than this version and lists the file: an older release has none, and asking would be a wasted
   * request on every check. When the file cannot be read, what an earlier check read from this same
   * release is kept (the app checks again every few hours); notes of another release never are.
   */
  private async readNotes(release: ReleaseSummary): Promise<void> {
    const tag = release.tag_name
    const newer = (compareVersions(tag, this.current.currentVersion) ?? 0) > 0
    if (!newer || !release.assets.some((a) => a.name === RELEASE_NOTES_FILE)) return this.forgetNotes()
    try {
      this.releaseNotes = parseReleaseNotes(await this.fetchNotes(tag))
      this.notesTag = tag
    } catch {
      if (this.notesTag === tag) return
      this.forgetNotes()
      this.notesFailed = true
    }
  }

  private forgetNotes(): void {
    this.releaseNotes = []
    this.notesTag = undefined
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
      const notes = notesBetween(this.releaseNotes, this.current.currentVersion, info.version)
      this.set({ state: 'available', version: info.version, releaseUrl: `${RELEASES}/tag/v${info.version}`, changesUrl: RELEASES, message: undefined, notes: notes.length ? notes : undefined, notesError: this.notesFailed || undefined })
    })
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', version: undefined, releaseUrl: undefined, changesUrl: undefined }))
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
