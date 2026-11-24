// WSL distributions as `wsl.exe` reports them, and the command that starts a `workhub host` inside
// one. Pure: every call to `wsl.exe` goes through an injected runner, so this runs (and is tested)
// on any OS.
import { isWslDistroName, joinFlavorPath } from './paths'
import { isHostVersion, type HostPayloadArch } from './payload'

/**
 * What one `wsl.exe` run returned: its exit code and its output as text. The runner decodes it
 * (`wsl.exe` writes UTF-16LE or UTF-8, see the adapters' `decodeWslOutput`).
 */
export interface WslRunResult {
  code: number | null
  stdout: string
  stderr?: string
}

/** Runs `wsl.exe` with these arguments, without a shell; a failure is a non-zero code. */
export type WslRun = (args: string[]) => Promise<WslRunResult>

export interface WslDistro {
  name: string
  /** The distribution `wsl.exe` runs when none is named. */
  isDefault: boolean
  /** As `wsl.exe -l -v` words it (`Running`, `Stopped`, possibly translated); absent when unknown. */
  state?: string
  /** WSL 1 or 2; absent when unknown. */
  version?: number
}

// A BOM and NULs are dropped too: a stray one (UTF-16 padding) would make a name unreadable.
const lines = (text: string): string[] =>
  text
    .replace(/\uFEFF|\0/g, '')
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== '')

/**
 * The distribution names of `wsl.exe -l -q`, in its order. A line that cannot be a distribution
 * name (the "no installed distributions" message, in any language) is left out.
 */
export function parseWslQuietList(text: string): string[] {
  return [...new Set(lines(text).filter(isWslDistroName))]
}

/**
 * The rows of `wsl.exe -l -v`: a header line, then `[*] NAME STATE VERSION`, the default one
 * starred. Rows that do not read as one (the header, a message) are left out.
 */
export function parseWslVerboseList(text: string): WslDistro[] {
  const out: WslDistro[] = []
  for (const line of lines(text)) {
    // Split into words (no regular expression that could backtrack on a long line): the star, the
    // name, the state (one word or more, in WSL's language) and the version.
    const words = line.trim().split(/\s+/)
    const isDefault = words[0]!.startsWith('*')
    if (isDefault) words[0] = words[0]!.slice(1)
    if (words[0] === '') words.shift()
    const [name, ...rest] = words
    const version = rest.pop()
    if (!name || rest.length === 0 || !version || !/^\d+$/.test(version) || !isWslDistroName(name)) continue
    out.push({ name, isDefault, state: rest.join(' '), version: Number(version) })
  }
  return out
}

/**
 * The installed distributions: names from `wsl.exe -l -q`, default, state and version from
 * `wsl.exe -l -v` when it can be read. Empty when WSL has none, or is not there (the run fails).
 */
export async function listWslDistros(run: WslRun): Promise<WslDistro[]> {
  const quiet = await run(['-l', '-q'])
  if (quiet.code !== 0) return []
  const names = parseWslQuietList(quiet.stdout)
  if (names.length === 0) return []
  const verbose = await run(['-l', '-v']).catch(() => null)
  const rows = verbose && verbose.code === 0 ? parseWslVerboseList(verbose.stdout) : []
  return names.map((name) => rows.find((r) => r.name === name) ?? { name, isDefault: false })
}

/** What a host inside a distribution needs to know of it. */
export interface WslDistroInfo {
  /** `uname -m`: `x86_64`, `aarch64`, ... */
  arch: string
  /** The home folder of the distribution's default user (a POSIX path). */
  home: string
}

export class WslProbeError extends Error {
  constructor(
    readonly distro: string,
    detail: string
  ) {
    super(`could not read WSL distribution ${distro}: ${detail}`)
    this.name = 'WslProbeError'
  }
}

/** The `sh` script `probeWslDistro` runs: the machine on one line, then the home folder. */
export const WSL_PROBE_SCRIPT = 'uname -m; printf %s "$HOME"'

/** The machine and home folder of a distribution, as its default user; throws a WslProbeError when it cannot be read. */
export async function probeWslDistro(run: WslRun, distro: string): Promise<WslDistroInfo> {
  if (!isWslDistroName(distro)) throw new WslProbeError(distro, 'not a distribution name')
  const r = await run(['-d', distro, '-e', 'sh', '-c', WSL_PROBE_SCRIPT])
  const out = r.stdout.replace(/\0/g, '')
  if (r.code !== 0) {
    const detail = lines(`${r.stderr ?? ''}\n${out}`).join(' ')
    throw new WslProbeError(distro, `exit ${r.code}${detail ? `: ${detail}` : ''}`)
  }
  const [arch = '', ...rest] = out.split(/\r?\n/)
  const home = rest.join('\n').trim()
  if (!/^[\w.-]+$/.test(arch.trim()) || !home.startsWith('/')) throw new WslProbeError(distro, `unexpected output ${JSON.stringify(out.slice(0, 200))}`)
  return { arch: arch.trim(), home }
}

/** Node's name for a `uname -m` machine (`x64`, `arm64`); null for one the host is not built for. */
export function nodeArchOfMachine(machine: string): 'x64' | 'arm64' | null {
  if (machine === 'x86_64' || machine === 'amd64') return 'x64'
  if (machine === 'aarch64' || machine === 'arm64') return 'arm64'
  return null
}

/** The folder the host versions live in inside a distribution: `~/.workhub/host`. */
export const wslHostRoot = (home: string): string => joinFlavorPath('posix', home, '.workhub', 'host')

/**
 * Where the host of this app version lives inside a distribution: `<root>/<version>/` (the root is
 * `~/.workhub/host` unless given), with `host.js` and its own Node at `node/bin/node`. The one
 * place that layout is written down; installing it there is a separate step (wsl-host-install.ts).
 */
export function wslHostPayload(home: string, hostVersion: string, root: string = wslHostRoot(home)): { root: string; dir: string; nodePath: string; entry: string } {
  if (!isHostVersion(hostVersion)) throw new Error(`not a host version: ${JSON.stringify(hostVersion)}`)
  if (!root.startsWith('/')) throw new Error(`the host folder must be an absolute path inside the distribution: ${JSON.stringify(root)}`)
  const dir = joinFlavorPath('posix', root, hostVersion)
  return { root, dir, nodePath: joinFlavorPath('posix', dir, 'node', 'bin', 'node'), entry: joinFlavorPath('posix', dir, 'host.js') }
}

/**
 * The host's arguments for an installed payload, as the app computes them for its own host: the
 * SDK's bundled `claude` as the terminal's fallback, and the bridge's adapters (claude-agent-acp)
 * on the PATH of agent adapters. The payload's Node goes there too, after them: claude-agent-acp
 * starts through `env node`, which a distribution without Node would not find. `--bridge-dir`
 * is left out: the host defaults to the `bridge` folder next to host.js.
 */
export function wslHostArgs(dir: string, arch: HostPayloadArch): string[] {
  const modules = joinFlavorPath('posix', dir, 'bridge', 'node_modules')
  return [
    '--fallback-path',
    joinFlavorPath('posix', modules, '@anthropic-ai', `claude-agent-sdk-linux-${arch}`),
    '--extra-path',
    joinFlavorPath('posix', modules, '.bin'),
    '--extra-path',
    joinFlavorPath('posix', dir, 'node', 'bin')
  ]
}

/** A command to start, with its arguments as a list (never through a shell). */
export interface HostLaunch {
  command: string
  args: string[]
  /** Variables set over the app's environment for this command. */
  env?: Record<string, string>
}

/**
 * `wsl.exe` starting the host inside a distribution, in the home folder of its default user, its
 * stdio piped to the app. `WSLENV` is emptied so no Windows variable (a token, say) reaches it.
 */
export function wslHostLaunch(options: { distro: string; nodePath: string; entry: string; hostVersion: string; args?: string[] }): HostLaunch {
  const { distro, nodePath, entry, hostVersion } = options
  if (!isWslDistroName(distro)) throw new Error(`not a WSL distro name: ${JSON.stringify(distro)}`)
  if (!nodePath.startsWith('/') || !entry.startsWith('/')) throw new Error('the host and its Node must be absolute paths inside the distribution')
  return {
    command: 'wsl.exe',
    args: ['-d', distro, '--cd', '~', '-e', nodePath, entry, '--stdio', '--host-version', hostVersion, ...(options.args ?? [])],
    env: { WSLENV: '' }
  }
}
