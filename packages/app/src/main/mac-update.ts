import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, constants, mkdtemp, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/** What the macOS installer needs from the system; the tests replace it. */
export interface MacUpdateDeps {
  /** Downloads `url` into `file`; throws when the server does not answer 2xx. */
  download(url: string, file: string): Promise<void>
  /** Reads a small text file over HTTP (the `.sha256` next to the zip). */
  text(url: string): Promise<string>
  run(command: string, args: string[]): Promise<string>
  sha256(file: string): Promise<string>
  tempDir(): Promise<string>
  list(dir: string): Promise<string[]>
  writable(path: string): Promise<boolean>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

/**
 * The `.app` bundle the running executable lives in (`/Applications/Workhub.app/Contents/MacOS/x`
 * → `/Applications/Workhub.app`), or null when it is not inside one (a dev run).
 */
export function bundleOf(exePath: string): string | null {
  const bundle = dirname(dirname(dirname(exePath)))
  return bundle.endsWith('.app') && basename(dirname(exePath)) === 'MacOS' ? bundle : null
}

/** Whether the app can replace its own bundle: it runs from one, in a folder it can write to. */
export async function canSelfUpdate(exePath: string, deps: Pick<MacUpdateDeps, 'writable'>): Promise<boolean> {
  const bundle = bundleOf(exePath)
  return bundle ? deps.writable(dirname(bundle)) : false
}

/**
 * Replaces the running macOS bundle with the release's zip, the way scripts/install.sh does
 * (an unsigned build cannot use Squirrel.Mac): download, check the published SHA-256, unpack,
 * check it is the same app, then swap the bundles. The running app keeps working; the new version
 * starts with the next launch.
 */
export async function installMacUpdate(options: { zipUrl: string; bundle: string; appId: string }, deps: MacUpdateDeps): Promise<void> {
  const { zipUrl, bundle, appId } = options
  const tmp = await deps.tempDir()
  try {
    const zip = join(tmp, 'update.zip')
    await deps.download(zipUrl, zip)
    const want = (await deps.text(`${zipUrl}.sha256`)).trim().split(/\s+/)[0]?.toLowerCase()
    if (!want || (await deps.sha256(zip)) !== want) throw new Error('the download does not match its checksum; nothing was installed')
    const unpacked = join(tmp, 'app')
    await deps.run('ditto', ['-x', '-k', zip, unpacked])
    const app = (await deps.list(unpacked)).find((name) => name.endsWith('.app'))
    if (!app) throw new Error('the download holds no app')
    const built = join(unpacked, app)
    const id = (await deps.run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(built, 'Contents', 'Info.plist')])).trim()
    if (id !== appId) throw new Error(`the download is another app (${id})`)
    const fresh = `${bundle}.new`
    const old = `${bundle}.old`
    await deps.remove(fresh)
    await deps.remove(old)
    await deps.run('ditto', [built, fresh])
    await deps.run('xattr', ['-dr', 'com.apple.quarantine', fresh]).catch(() => '')
    await deps.rename(bundle, old)
    try {
      await deps.rename(fresh, bundle)
    } catch (err) {
      await deps.rename(old, bundle)
      throw err
    }
    // The new version is in place: leftovers are tidied up when possible, never a failed update.
    await deps.remove(old).catch(() => undefined)
    await deps.run(LSREGISTER, ['-f', bundle]).catch(() => '')
  } finally {
    await deps.remove(tmp).catch(() => undefined)
  }
}

/** The real system behind `MacUpdateDeps`. */
export const nodeMacUpdateDeps: MacUpdateDeps = {
  async download(url, file) {
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(file))
  },
  async text(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`could not read the checksum (${res.status})`)
    return res.text()
  },
  run: (command, args) =>
    new Promise((resolve, reject) => execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)))),
  async sha256(file) {
    const hash = createHash('sha256')
    await pipeline(createReadStream(file), hash)
    return hash.digest('hex')
  },
  tempDir: () => mkdtemp(join(tmpdir(), 'workhub-update-')),
  list: (dir) => readdir(dir),
  writable: (path) =>
    access(path, constants.W_OK).then(
      () => true,
      () => false
    ),
  rename: (from, to) => rename(from, to),
  // Not fs.rm: inside Electron, fs treats `app.asar` as a folder, so a recursive rm of a bundle
  // cannot delete it and fails with ENOTEMPTY. /bin/rm sees the real file.
  remove: (path) =>
    new Promise((resolve, reject) => execFile('/bin/rm', ['-rf', '--', path], (err, _stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())))
}
