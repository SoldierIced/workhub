// The Linux host payload: one archive per processor architecture, published as an asset of the
// app's GitHub release and installed into a WSL distribution on first use. Pure: names, addresses,
// checksum lines and which old versions to drop. Building the archive is scripts/stage-host.mjs;
// installing it is the app's main process (wsl-host-install.ts).
import { checksumFor } from '../setup/managed-tools'

export type HostPayloadArch = 'x64' | 'arm64'

export const HOST_PAYLOAD_ARCHES: readonly HostPayloadArch[] = ['x64', 'arm64']

export const isHostPayloadArch = (arch: unknown): arch is HostPayloadArch => arch === 'x64' || arch === 'arm64'

/** A host version as it appears in folder and file names (the app's semver, `2.0.0-alpha.1`). */
export const isHostVersion = (version: string): boolean => /^[\w.+-]+$/.test(version) && !/^\.+$/.test(version)

function checkVersion(version: string): void {
  if (!isHostVersion(version)) throw new Error(`not a host version: ${JSON.stringify(version)}`)
}

/** The archive's file name: `workhub-host-<version>-linux-<arch>.tar.gz`. */
export function hostPayloadName(version: string, arch: HostPayloadArch): string {
  checkVersion(version)
  if (!isHostPayloadArch(arch)) throw new Error(`not a host payload architecture: ${JSON.stringify(arch)}`)
  return `workhub-host-${version}-linux-${arch}.tar.gz`
}

/** Where the release of `version` keeps the archive and its `.sha256` (`owner/name` repository, tag `v<version>`). */
export function hostPayloadUrls(repo: string, version: string, arch: HostPayloadArch): { archive: string; checksum: string } {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not a GitHub repository: ${JSON.stringify(repo)}`)
  const archive = `https://github.com/${repo}/releases/download/v${version}/${hostPayloadName(version, arch)}`
  return { archive, checksum: `${archive}.sha256` }
}

/**
 * The SHA-256 a `.sha256` file gives for `fileName`: a `sha256sum` line (`<hash>  <name>`), or a
 * file holding the hash alone. Null when it names another file or holds no hash.
 */
export function payloadChecksum(text: string, fileName: string): string | null {
  const listed = checksumFor(text, fileName)
  if (listed) return listed
  const bare = text.trim()
  return /^[0-9a-fA-F]{64}$/.test(bare) ? bare.toLowerCase() : null
}

/** `manifest.json` at the archive's root. No path of the machine that built it. */
export interface HostPayloadManifest {
  version: string
  arch: HostPayloadArch
  /** The Node.js version in `node/`. */
  node: string
  /** What the archive was built from: `git <commit>`, or `unknown`. */
  createdFrom: string
}

export function hostPayloadManifest(options: { version: string; arch: HostPayloadArch; node: string; commit?: string | null }): HostPayloadManifest {
  checkVersion(options.version)
  const commit = options.commit && /^[0-9a-f]{7,64}$/.test(options.commit) ? options.commit : null
  return { version: options.version, arch: options.arch, node: options.node, createdFrom: commit ? `git ${commit}` : 'unknown' }
}

/** The file written last into an installed payload folder: without it the folder is not used. */
export const HOST_PAYLOAD_READY = '.ready'

/** The prefix of the folders a payload is unpacked into before it is moved into place. */
export const HOST_PAYLOAD_STAGING_PREFIX = '.tmp-'

/**
 * The entries of the hosts folder to delete once `current` is installed: every version but
 * `current` and the newest other one (kept so the previous app version still finds its host), and
 * leftover staging folders. `entries` come newest first (`ls -t`); names that are neither a
 * version (starting with a digit) nor a staging folder are left alone.
 */
export function hostVersionsToPrune(entries: readonly string[], current: string): string[] {
  const out: string[] = []
  let keptPrevious = false
  for (const name of entries) {
    if (name.startsWith(HOST_PAYLOAD_STAGING_PREFIX)) {
      if (isHostVersion(name) && name.length > HOST_PAYLOAD_STAGING_PREFIX.length) out.push(name)
      continue
    }
    if (name === current || !/^\d/.test(name) || !isHostVersion(name)) continue
    if (!keptPrevious) keptPrevious = true
    else out.push(name)
  }
  return out
}
