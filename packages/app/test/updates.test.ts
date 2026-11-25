import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MacUpdateDeps } from '../src/main/mac-update'
import { RELEASE_NOTES_LIMITS, compareVersions } from '../src/shared/release-notes'
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

const { RELEASE_REPO, UpdateService, fetchNotesFromGitHub } = await import('../src/main/updates')
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

describe('what changed in the version found', () => {
  beforeEach(() => {
    autoUpdater.reset()
    vi.clearAllMocks()
    setPlatform('darwin', 'arm64')
  })
  afterEach(() => setPlatform(realPlatform, realArch))

  const manifests = [{ name: 'latest-mac.yml' }, { name: 'latest.yml' }, { name: 'latest-linux.yml' }]
  const release = (version: string, withNotes = true) => ({ tag_name: `v${version}`, draft: false, prerelease: true, assets: withNotes ? [...manifests, { name: 'release-notes.json' }] : manifests })
  const entry = (version: string) => ({ version, date: '2026-01-15', items: [{ kind: 'new', title: { en: `New in ${version}`, es: `Nuevo en ${version}` } }] })
  const file = { releases: [entry('2.0.0-alpha.3'), entry('2.0.0-alpha.2'), entry('2.0.0-alpha.1')] }

  function serviceWith(releases: ReturnType<typeof release>[], fetchNotes: (tag: string) => Promise<unknown>) {
    const changes: UpdateStatus[] = []
    const asked: string[] = []
    const s = new UpdateService((st) => void changes.push(st), async () => undefined, macDeps(), async () => releases, {
      fetchNotes: (tag) => {
        asked.push(tag)
        return fetchNotes(tag)
      }
    })
    return { s, changes, asked }
  }

  it('announces the version together with the notes of every version after the running one', async () => {
    const { s, changes, asked } = serviceWith([release('2.0.0-alpha.3')], async () => file)
    const status = await checkFinds(s, found('2.0.0-alpha.3'))
    expect(asked).toEqual(['v2.0.0-alpha.3'])
    expect(status.notes?.map((n) => n.version)).toEqual(['2.0.0-alpha.3', '2.0.0-alpha.2'])
    // Never the version first and its notes later: the first `available` already has them.
    expect(changes.find((c) => c.state === 'available')?.notes).toHaveLength(2)
    expect(status.notesError).toBeFalsy()
  })

  it('asks for no file when the release has none, and shows no notes', async () => {
    const { s, asked } = serviceWith([release('2.0.0-alpha.2', false)], async () => file)
    const status = await checkFinds(s)
    expect(asked).toEqual([])
    expect(status).toMatchObject({ state: 'available', version: '2.0.0-alpha.2' })
    expect(status.notes).toBeUndefined()
    expect(status.notesError).toBeFalsy()
  })

  it('asks for no file when the newest release is the running version', async () => {
    const { s, asked } = serviceWith([release('2.0.0-alpha.1')], async () => file)
    await s.check()
    expect(asked).toEqual([])
  })

  it('still offers the update when the notes cannot be read, and says they could not', async () => {
    const { s } = serviceWith([release('2.0.0-alpha.2')], async () => {
      throw new Error('timeout')
    })
    const status = await checkFinds(s)
    expect(status).toMatchObject({ state: 'available', version: '2.0.0-alpha.2', notesError: true })
    expect(status.notes).toBeUndefined()
  })

  it('does not keep the notes of an earlier check for a version whose notes could not be read', async () => {
    const releases = [release('2.0.0-alpha.2')]
    let fail = false
    const { s, changes } = serviceWith(releases, async () => {
      if (fail) throw new Error('offline')
      return file
    })
    expect((await checkFinds(s)).notes).toHaveLength(1)
    fail = true
    releases.unshift(release('2.0.0-alpha.3'))
    const status = await checkFinds(s, found('2.0.0-alpha.3'))
    expect(status).toMatchObject({ version: '2.0.0-alpha.3', notesError: true })
    expect(status.notes).toBeUndefined()
    // Nor while it is checking again.
    expect(changes.filter((c) => c.state === 'checking').at(-1)?.notes).toBeUndefined()
  })

  it('keeps the notes it already read when a later check of the same release cannot read them', async () => {
    let fail = false
    const { s } = serviceWith([release('2.0.0-alpha.2')], async () => {
      if (fail) throw new Error('timeout')
      return file
    })
    await checkFinds(s)
    fail = true
    const status = await checkFinds(s)
    expect(status.notes?.map((n) => n.version)).toEqual(['2.0.0-alpha.2'])
    expect(status.notesError).toBeFalsy()
  })

  it('links to the list of releases, where every version has its changes', async () => {
    const { s } = serviceWith([release('2.0.0-alpha.3')], async () => file)
    const status = await checkFinds(s, found('2.0.0-alpha.3'))
    expect(status.changesUrl).toBe(`https://github.com/${RELEASE_REPO}/releases`)
    expect(status.releaseUrl).toBe(`https://github.com/${RELEASE_REPO}/releases/tag/v2.0.0-alpha.3`)
  })
})

describe('what changed: the request to the release', () => {
  const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch

  it('asks the release for its file and reads it', async () => {
    const asked: string[] = []
    const request = (async (url: string) => {
      asked.push(url)
      return new Response('{"releases":[]}')
    }) as unknown as typeof fetch
    expect(await fetchNotesFromGitHub('v2.0.0-alpha.2', request)).toEqual({ releases: [] })
    expect(asked).toEqual([`https://github.com/${RELEASE_REPO}/releases/download/v2.0.0-alpha.2/release-notes.json`])
  })

  it('fails on a missing file, on a body that is not the file and on one over the size limit', async () => {
    await expect(fetchNotesFromGitHub('v1.0.0', answer('Not Found', 404))).rejects.toThrow('404')
    await expect(fetchNotesFromGitHub('v1.0.0', answer('<html>sign in</html>'))).rejects.toThrow()
    await expect(fetchNotesFromGitHub('v1.0.0', answer(JSON.stringify({ releases: [], pad: 'x'.repeat(RELEASE_NOTES_LIMITS.bytes) })))).rejects.toThrow('too large')
  })
})

describe('the sample update of a development run (WORKHUB_DEMO_UPDATE)', () => {
  beforeEach(() => {
    autoUpdater.reset()
    vi.clearAllMocks()
    electron.app.isPackaged = false
  })
  afterEach(() => {
    electron.app.isPackaged = true
  })

  it('shows a newer version with sample notes in both languages and contacts nothing', async () => {
    const opened: string[] = []
    const fetchReleases = vi.fn(async () => [])
    const fetchNotes = vi.fn(async () => ({}))
    const s = new UpdateService(() => {}, async (url) => void opened.push(url), macDeps(), fetchReleases, { fetchNotes, demo: true })
    const status = await s.check()
    expect(status).toMatchObject({ state: 'available', currentVersion: '2.0.0-alpha.1', canInstall: false })
    expect(status.notes!.length).toBeGreaterThan(1)
    expect(status.notes![0]!.version).toBe(status.version)
    for (const note of status.notes!) expect(compareVersions(note.version, status.currentVersion)).toBeGreaterThan(0)
    expect(fetchReleases).not.toHaveBeenCalled()
    expect(fetchNotes).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    // "Update" opens the list of releases: the sample version has no page of its own.
    await s.install()
    expect(opened).toEqual([`https://github.com/${RELEASE_REPO}/releases`])
  })

  it('is ignored by a packaged app', () => {
    electron.app.isPackaged = true
    const s = new UpdateService(() => {}, async () => {}, macDeps(), async () => [], { demo: true })
    expect(s.status().state).toBe('idle')
  })
})
