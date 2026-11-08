import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MacUpdateDeps } from '../src/main/mac-update'
import type { UpdateStatus } from '../src/shared/updates-api'

const electron = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '2.0.0-alpha.1', getPath: () => '/Applications/Acme.app/Contents/MacOS/Acme', relaunch: vi.fn(), quit: vi.fn() }
}))
vi.mock('electron', () => electron)

const updater = vi.hoisted(() => {
  // The on/emit subset of an EventEmitter that UpdateService uses.
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  return {
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: false,
      on(event: string, fn: (...args: unknown[]) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), fn])
      },
      emit(event: string, ...args: unknown[]) {
        for (const fn of handlers.get(event) ?? []) fn(...args)
      },
      reset() {
        handlers.clear()
      },
      checkForUpdates: vi.fn(async () => undefined as unknown),
      setFeedURL: vi.fn(),
      downloadUpdate: vi.fn(async () => [] as string[]),
      quitAndInstall: vi.fn()
    }
  }
})
vi.mock('electron-updater', () => updater)

const { RELEASE_REPO, UpdateService } = await import('../src/main/updates')
const { autoUpdater } = updater

const realPlatform = process.platform
const realArch = process.arch
const setPlatform = (platform: NodeJS.Platform, arch: string = realArch) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
}

/** A macOS system where the bundle can be replaced; `install` decides how the swap goes. */
function macDeps(install: (url: string) => Promise<void> = async () => undefined): MacUpdateDeps & { downloads: string[] } {
  const downloads: string[] = []
  return {
    downloads,
    download: async (url) => {
      downloads.push(url)
      await install(url)
    },
    text: async () => 'abc  file.zip',
    sha256: async () => 'abc',
    tempDir: async () => '/tmp/u',
    list: async () => ['Acme.app'],
    writable: async () => true,
    run: async (command) => (command.endsWith('PlistBuddy') ? 'com.example.acme\n' : ''),
    rename: async () => undefined,
    remove: async () => undefined
  }
}

const found = (version = '2.0.0-alpha.2') => ({
  version,
  files: [
    { url: `Acme-${version}-mac-x64.zip` },
    { url: `Acme-${version}-mac-arm64.zip` },
    { url: `Acme-${version}-mac-arm64.dmg` }
  ]
})

/** The release list the GitHub API answers with: one published release with every manifest. */
const published = async () => [{ tag_name: 'v2.0.0-alpha.2', draft: false, prerelease: true, assets: [{ name: 'latest-mac.yml' }, { name: 'latest.yml' }, { name: 'latest-linux.yml' }] }]

function service(mac: MacUpdateDeps) {
  const changes: UpdateStatus[] = []
  const opened: string[] = []
  const s = new UpdateService((st) => void changes.push(st), async (url) => void opened.push(url), mac, published)
  return { s, changes, opened }
}

/** "Check now", with the release found answering the check. */
async function checkFinds(s: InstanceType<typeof UpdateService>, info = found()) {
  autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
    autoUpdater.emit('update-available', info)
    return undefined
  })
  return s.check()
}

describe('UpdateService', () => {
  beforeEach(() => {
    autoUpdater.reset()
    vi.clearAllMocks()
  })
  afterEach(() => setPlatform(realPlatform, realArch))

  it('picks the macOS zip for this architecture and installs it from the release repository', async () => {
    setPlatform('darwin', 'arm64')
    const mac = macDeps()
    const { s } = service(mac)
    expect((await checkFinds(s)).state).toBe('available')
    expect(s.status().releaseUrl).toBe(`https://github.com/${RELEASE_REPO}/releases/tag/v2.0.0-alpha.2`)
    expect((await s.install()).state).toBe('ready')
    expect(mac.downloads).toEqual([`https://github.com/${RELEASE_REPO}/releases/download/v2.0.0-alpha.2/Acme-2.0.0-alpha.2-mac-arm64.zip`])
  })

  it('falls back to any zip when none names this architecture', async () => {
    setPlatform('darwin', 'ia32')
    const mac = macDeps()
    const { s } = service(mac)
    await checkFinds(s)
    await s.install()
    expect(mac.downloads[0]).toMatch(/Acme-2\.0\.0-alpha\.2-mac-x64\.zip$/)
  })

  it('goes back to available with the reason when the download fails, so it can be tried again', async () => {
    setPlatform('darwin', 'arm64')
    const mac = macDeps(async () => {
      throw new Error('the download stalled')
    })
    const { s, changes } = service(mac)
    await checkFinds(s)
    const after = await s.install()
    expect(changes.map((c) => c.state)).toContain('downloading')
    expect(after).toMatchObject({ state: 'available', message: 'the download stalled', version: '2.0.0-alpha.2' })
    // Check now reads again (no longer stuck behind a download).
    await s.check()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('does not check again while a download is under way', async () => {
    setPlatform('darwin', 'arm64')
    let finish!: () => void
    const mac = macDeps(() => new Promise<void>((resolve) => (finish = resolve)))
    const { s } = service(mac)
    await checkFinds(s)
    const installing = s.install()
    await vi.waitFor(() => expect(mac.downloads).toHaveLength(1))
    expect((await s.check()).state).toBe('downloading')
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    finish()
    expect((await installing).state).toBe('ready')
  })

  it('restarts through electron-updater off macOS, and relaunches on macOS', async () => {
    setPlatform('win32')
    const win = service(macDeps()).s
    await checkFinds(win)
    win.restart()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled() // not ready yet
    await win.install()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    win.restart()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(electron.app.relaunch).not.toHaveBeenCalled()

    setPlatform('darwin', 'arm64')
    const mac = service(macDeps()).s
    await checkFinds(mac)
    await mac.install()
    mac.restart()
    expect(electron.app.relaunch).toHaveBeenCalledTimes(1)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})

describe('picking the release to check', () => {
  const release = (tag_name: string, extra: Partial<{ draft: boolean; prerelease: boolean; assets: { name: string }[] }> = {}) => ({
    tag_name,
    draft: false,
    prerelease: true,
    assets: [{ name: 'latest-mac.yml' }, { name: 'latest.yml' }, { name: 'latest-linux.yml' }],
    ...extra
  })

  it('points electron-updater at the newest published release that has this platform\'s manifest', async () => {
    setPlatform('darwin')
    const releases = [release('v2.0.0-alpha.21', { draft: true }), release('v2.0.0-alpha.20', { assets: [] }), release('v2.0.0-alpha.19')]
    const service = new UpdateService(() => {}, async () => {}, undefined, async () => releases)
    await service.check()
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: `https://github.com/${RELEASE_REPO}/releases/download/v2.0.0-alpha.19` })
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('reports no update when no published release has installers yet', async () => {
    setPlatform('darwin')
    const service = new UpdateService(() => {}, async () => {}, undefined, async () => [release('v2.0.0-alpha.21', { assets: [] })])
    expect((await service.check()).state).toBe('none')
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('reports an error instead of guessing the release when the GitHub API cannot be read', async () => {
    setPlatform('darwin')
    const service = new UpdateService(() => {}, async () => {}, undefined, async () => {
      throw new Error('offline')
    })
    const status = await service.check()
    expect(status.state).toBe('error')
    expect(status.message).toContain('offline')
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled()
    // Without the list, electron-updater would follow the newest tag and 404 on a release still being built.
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })
})
