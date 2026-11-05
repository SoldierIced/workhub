import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, constants, mkdtemp, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/** How long the server may take to answer a download or checksum request. */
export const CONNECT_TIMEOUT_MS = 30_000
/** How long a download may go without receiving a byte before it is given up. */
export const IDLE_TIMEOUT_MS = 60_000

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
    // Unique names: a leftover of an earlier update that could not be removed never blocks this one.
    await removeLeftovers(bundle, deps)
    const tag = randomBytes(4).toString('hex')
    const fresh = `${bundle}.new-${tag}`
    const old = `${bundle}.old-${tag}`
    try {
      await deps.run('ditto', [built, fresh])
      await deps.run('xattr', ['-dr', 'com.apple.quarantine', fresh]).catch(() => '')
      await deps.rename(bundle, old)
    } catch (err) {
      await deps.remove(fresh).catch(() => undefined)
      throw err
    }
    try {
      await deps.rename(fresh, bundle)
    } catch (err) {
      try {
        await deps.rename(old, bundle)
      } catch (rollback) {
        throw new Error(
          `the new version could not take the place of ${bundle} (${messageOf(err)}) and the previous one could not be put back (${messageOf(rollback)}): the previous version is at ${old}, the new one at ${fresh}`
        )
      }
      await deps.remove(fresh).catch(() => undefined)
      throw err
    }
    // The new version is in place: leftovers are tidied up when possible, never a failed update.
    await deps.remove(old).catch(() => undefined)
    await deps.run(LSREGISTER, ['-f', bundle]).catch(() => '')
  } finally {
    await deps.remove(tmp).catch(() => undefined)
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Best effort: removes `<bundle>.new*` / `<bundle>.old*` left by earlier updates; failures are ignored. */
async function removeLeftovers(bundle: string, deps: MacUpdateDeps): Promise<void> {
  const prefix = `${basename(bundle)}.`
  const leftover = (entry: string) => entry.startsWith(prefix) && /^(new|old)(-[0-9a-f]+)?$/.test(entry.slice(prefix.length))
  const names = await deps.list(dirname(bundle)).catch(() => [] as string[])
  for (const entry of names) if (leftover(entry)) await deps.remove(join(dirname(bundle), entry)).catch(() => undefined)
}

/**
 * Downloads `url` into `file`. The server must answer within `connectMs`, and the body must keep
 * arriving: `idleMs` without a byte aborts it, so a stalled download fails instead of hanging.
 */
export async function downloadFile(url: string, file: string, options: { fetch?: typeof fetch; connectMs?: number; idleMs?: number } = {}): Promise<void> {
  const { fetch: get = fetch, connectMs = CONNECT_TIMEOUT_MS, idleMs = IDLE_TIMEOUT_MS } = options
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(new Error(`the server did not answer within ${Math.round(connectMs / 1000)} s`)), connectMs)
  const idle = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error(`the download stalled (nothing received for ${Math.round(idleMs / 1000)} s)`)), idleMs)
  }
  try {
    const res = await get(url, { signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
    idle()
    const watch = new Transform({
      transform(chunk, _encoding, done) {
        idle()
        done(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), watch, createWriteStream(file), { signal: controller.signal })
  } catch (err) {
    throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : err
  } finally {
    clearTimeout(timer)
  }
}

/** The real system behind `MacUpdateDeps`. */
export const nodeMacUpdateDeps: MacUpdateDeps = {
  download: (url, file) => downloadFile(url, file),
  async text(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
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
