// Installs the `workhub host` of this app version into a WSL distribution: the Linux payload
// (scripts/stage-host.mjs) is taken from a local file (WORKHUB_HOST_PAYLOAD) or downloaded from the
// GitHub release of this version, checked against its SHA-256 and kept per version in the app's data
// folder, then streamed into the distribution through `wsl.exe` and unpacked there. The folder is
// moved into place and marked ready (`.ready`) last, so a failed install is never used.
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import {
  HOST_PAYLOAD_READY,
  HOST_PAYLOAD_STAGING_PREFIX,
  hostPayloadName,
  hostPayloadUrls,
  hostVersionsToPrune,
  payloadChecksum,
  wslHostPayload,
  type HostPayloadArch,
  type WslRun
} from '@workhub/core'
import type { WslRunWithInput } from '@workhub/adapters/host'
import type { Logger } from './log-file'
import type { HostInstallProgress } from '../shared/hosts-api'

export interface WslHostInstallOptions {
  distro: string
  /** The host version (the app's), which names the payload and its folder. */
  version: string
  arch: HostPayloadArch
  /** The home folder of the distribution's default user. */
  home: string
  /** The folder of the host versions inside the distribution; `~/.workhub/host` by default. */
  root?: string
  /** `wsl.exe` for the short steps (check, move into place, prune). */
  run: WslRun
  /** `wsl.exe` with the payload on its stdin (the unpacking). */
  runWithInput: WslRunWithInput
  fetch: (url: string) => Promise<Response>
  /** A payload archive on this computer, used instead of the download; its `<file>.sha256` is checked when present. */
  payloadFile?: string
  /** Where downloaded payloads are kept, one folder per version (older versions are removed). */
  cacheDir: string
  /** The GitHub repository releases are published to (`owner/name`). */
  repo: string
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** Each step of an install (not called when the host is already there): download bytes, checksum, unpacking. */
  onProgress?: (progress: HostInstallProgress) => void
}

export interface InstalledWslHost {
  dir: string
  nodePath: string
  entry: string
  /** Whether this call installed it (false: it was already there). */
  installed: boolean
}

export class WslHostInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WslHostInstallError'
  }
}

/** Unpacks stdin into $1, a fresh folder. */
const UNPACK = 'set -e; rm -rf -- "$1"; mkdir -p -- "$1"; tar -xzf - -C "$1"'
/** Checks the unpacked folder $1, moves it to $2 (replacing a half-installed one) and marks it ready. */
const PLACE = `set -e; test -x "$1/node/bin/node"; test -f "$1/host.js"; rm -rf -- "$2"; mv -- "$1" "$2"; touch -- "$2/${HOST_PAYLOAD_READY}"`
/** Deletes the entries named after $1 in the folder $1. */
const PRUNE = 'cd -- "$1" && shift && rm -rf -- "$@"'

const detail = (r: { code: number | null; stdout: string; stderr?: string }): string => {
  const text = `${r.stderr ?? ''}\n${r.stdout}`.trim().split(/\r?\n/).slice(-5).join(' ')
  return `exit ${r.code}${text ? `: ${text}` : ''}`
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** The host of this version in the distribution, installed first when it is not there yet. */
export async function ensureWslHost(options: WslHostInstallOptions): Promise<InstalledWslHost> {
  const { distro, version, arch, run, log } = options
  const payload = wslHostPayload(options.home, version, options.root)
  const ready = await run(['-d', distro, '-e', 'test', '-f', `${payload.dir}/${HOST_PAYLOAD_READY}`])
  if (ready.code === 0) return { ...payload, installed: false }
  // `test` says 1 for a missing file; anything else is `wsl.exe` failing, not worth a download.
  if (ready.code !== 1) throw new WslHostInstallError(`could not check the host in ${distro} (${detail(ready)})`)

  const started = Date.now()
  const archive = await obtainPayload(options)
  options.onProgress?.({ phase: 'unpacking' })
  log.info(`host install: unpacking ${hostPayloadName(version, arch)} into ${distro} at ${payload.dir}`)
  const staging = `${payload.root}/${HOST_PAYLOAD_STAGING_PREFIX}${version}-${randomBytes(4).toString('hex')}`
  const discard = () => run(['-d', distro, '-e', 'rm', '-rf', '--', staging]).catch(() => undefined)
  const unpacked = await options.runWithInput(['-d', distro, '-e', 'sh', '-c', UNPACK, 'sh', staging], createReadStream(archive))
  if (unpacked.code !== 0) {
    await discard()
    throw new WslHostInstallError(`could not unpack the host into ${distro} (${detail(unpacked)})`)
  }
  const placed = await run(['-d', distro, '-e', 'sh', '-c', PLACE, 'sh', staging, payload.dir])
  if (placed.code !== 0) {
    await discard()
    throw new WslHostInstallError(`could not put the host in place in ${distro} (${detail(placed)})`)
  }
  log.info(`host install: ${version} installed in ${distro} in ${Math.round((Date.now() - started) / 1000)} s`)
  await prune(options, payload.root)
  return { ...payload, installed: true }
}

/** Removes the host versions this one replaces (keeping the previous one) from the distribution; a failure is only logged. */
async function prune(options: WslHostInstallOptions, root: string): Promise<void> {
  const { distro, run, log } = options
  try {
    const listed = await run(['-d', distro, '-e', 'ls', '-1At', '--', root])
    if (listed.code !== 0) throw new Error(detail(listed))
    const names = hostVersionsToPrune(listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), options.version)
    if (names.length === 0) return
    const removed = await run(['-d', distro, '-e', 'sh', '-c', PRUNE, 'sh', root, ...names])
    if (removed.code !== 0) throw new Error(detail(removed))
    log.info(`host install: removed ${names.join(', ')} from ${distro}`)
  } catch (err) {
    log.warn(`host install: could not remove old host versions from ${distro}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The payload archive on this computer: the local file, the cached download, or a new download. */
async function obtainPayload(options: WslHostInstallOptions): Promise<string> {
  const { version, arch, log } = options
  const name = hostPayloadName(version, arch)
  if (options.payloadFile) {
    const file = options.payloadFile
    if (!existsSync(file)) throw new WslHostInstallError(`the host payload ${file} (WORKHUB_HOST_PAYLOAD) does not exist`)
    const sumFile = `${file}.sha256`
    if (existsSync(sumFile)) {
      options.onProgress?.({ phase: 'verifying' })
      const expected = payloadChecksum(await readFile(sumFile, 'utf8'), basename(file))
      if (!expected) throw new WslHostInstallError(`${sumFile} holds no SHA-256 for ${basename(file)}`)
      if ((await sha256OfFile(file)) !== expected) throw new WslHostInstallError(`${file} does not match its SHA-256 (${sumFile})`)
    } else {
      log.warn(`host install: ${file} has no .sha256 next to it; using it unchecked`)
    }
    log.info(`host install: using the local payload ${file}`)
    return file
  }

  const folder = join(options.cacheDir, version)
  const cached = join(folder, name)
  const cachedSum = `${cached}.sha256`
  if (existsSync(cached) && existsSync(cachedSum)) {
    options.onProgress?.({ phase: 'verifying' })
    const expected = payloadChecksum(await readFile(cachedSum, 'utf8'), name)
    if (expected && (await sha256OfFile(cached)) === expected) return cached
  }

  // Distributions installed at the same time share one download of a payload.
  const inFlight = downloads.get(cached)
  if (inFlight) return inFlight
  const download = downloadPayload(options, folder, cached).finally(() => downloads.delete(cached))
  downloads.set(cached, download)
  return download
}

/** The downloads under way, by the cached file they end as. */
const downloads = new Map<string, Promise<string>>()

/** Downloads the payload of this version's release into `cached`, checked against its published SHA-256. */
async function downloadPayload(options: WslHostInstallOptions, folder: string, cached: string): Promise<string> {
  const { version, arch, log } = options
  const name = hostPayloadName(version, arch)
  const cachedSum = `${cached}.sha256`
  const urls = hostPayloadUrls(options.repo, version, arch)
  log.info(`host install: downloading ${urls.archive}`)
  const sumRes = await options.fetch(urls.checksum)
  if (!sumRes.ok) throw new WslHostInstallError(`could not download ${urls.checksum} (HTTP ${sumRes.status})`)
  const sumText = await sumRes.text()
  const expected = payloadChecksum(sumText, name)
  if (!expected) throw new WslHostInstallError(`${urls.checksum} holds no SHA-256 for ${name}`)
  const res = await options.fetch(urls.archive)
  if (!res.ok || !res.body) throw new WslHostInstallError(`could not download ${urls.archive} (HTTP ${res.status})`)
  await mkdir(folder, { recursive: true })
  // Its own temporary file: a download never writes into another's.
  const partial = `${cached}.${randomBytes(4).toString('hex')}.partial`
  const hash = createHash('sha256')
  const progress = downloadProgress(res, options.onProgress)
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk)
          progress(chunk.length)
          yield chunk
        }
      },
      createWriteStream(partial)
    )
  } catch (err) {
    await rm(partial, { force: true })
    throw new WslHostInstallError(`the download of ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  options.onProgress?.({ phase: 'verifying' })
  if (hash.digest('hex') !== expected) {
    await rm(partial, { force: true })
    throw new WslHostInstallError(`${name} does not match its published SHA-256`)
  }
  await rename(partial, cached)
  await writeFile(cachedSum, sumText)
  // A payload is about 180 MB: only this version's is kept.
  for (const entry of await readdir(options.cacheDir).catch(() => [] as string[])) {
    if (entry !== version) await rm(join(options.cacheDir, entry), { recursive: true, force: true })
  }
  return cached
}

/** Bytes are reported at the start, then each time another 1 % (or 4 MiB, without a size) has arrived. */
function downloadProgress(res: Response, onProgress: WslHostInstallOptions['onProgress']): (bytes: number) => void {
  const length = Number(res.headers.get('content-length'))
  const total = Number.isFinite(length) && length > 0 ? length : undefined
  const step = total ? Math.max(1, Math.floor(total / 100)) : 4 * 1024 * 1024
  let received = 0
  let reported = 0
  const report = () => onProgress?.({ phase: 'downloading', received, ...(total ? { total } : {}) })
  report()
  return (bytes) => {
    received += bytes
    if (received - reported < step && received !== total) return
    reported = received
    report()
  }
}
