// Path helpers for a given flavor, without `node:path`: the app on Windows handles the POSIX paths
// of a host inside WSL, and translates them to and from `\\wsl.localhost\<distro>\...`.
//
// These are not `node:path`. `dirname` and `basename` normalize first, `normalize` drops a trailing
// separator, and a UNC share (`\\server\share`) is a root with no basename.

export type PathFlavor = 'posix' | 'win32'

const SEPARATOR: Record<PathFlavor, string> = { posix: '/', win32: '\\' }
const SPLIT: Record<PathFlavor, RegExp> = { posix: /\/+/, win32: /[\\/]+/ }

/** The root of a path (`/`, `C:\`, `C:`, `\\server\share\`, `\`, or '') and what follows it. */
function splitRoot(flavor: PathFlavor, p: string): { root: string; rest: string } {
  if (flavor === 'posix') return p.startsWith('/') ? { root: '/', rest: p.replace(/^\/+/, '') } : { root: '', rest: p }
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)[\\/]*/.exec(p)
  if (unc) return { root: `\\\\${unc[1]}\\${unc[2]}\\`, rest: p.slice(unc[0].length) }
  const drive = /^([A-Za-z]:)([\\/]+)?/.exec(p)
  if (drive) return { root: drive[2] ? `${drive[1]}\\` : drive[1]!, rest: p.slice(drive[0].length) }
  if (/^[\\/]/.test(p)) return { root: '\\', rest: p.replace(/^[\\/]+/, '') }
  return { root: '', rest: p }
}

function segments(flavor: PathFlavor, rest: string): string[] {
  return rest.split(SPLIT[flavor]).filter((s) => s !== '')
}

/** Collapses separators and resolves `.` and `..`; `..` never climbs above an absolute root. */
export function normalizeFlavorPath(flavor: PathFlavor, p: string): string {
  const { root, rest } = splitRoot(flavor, p)
  const rooted = root.endsWith(SEPARATOR[flavor])
  const out: string[] = []
  for (const s of segments(flavor, rest)) {
    if (s === '.') continue
    if (s !== '..') out.push(s)
    else if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else if (!rooted) out.push('..')
  }
  const body = out.join(SEPARATOR[flavor])
  return root + body || '.'
}

export function joinFlavorPath(flavor: PathFlavor, ...parts: string[]): string {
  return normalizeFlavorPath(flavor, parts.filter((p) => p !== '').join(SEPARATOR[flavor]))
}

export function isAbsoluteFlavorPath(flavor: PathFlavor, p: string): boolean {
  return flavor === 'posix' ? p.startsWith('/') : /^([\\/]|[A-Za-z]:[\\/])/.test(p)
}

export function dirnameFlavorPath(flavor: PathFlavor, p: string): string {
  const { root, rest } = splitRoot(flavor, normalizeFlavorPath(flavor, p))
  const parts = segments(flavor, rest)
  parts.pop()
  return root + parts.join(SEPARATOR[flavor]) || '.'
}

export function basenameFlavorPath(flavor: PathFlavor, p: string): string {
  // An empty path normalizes to `.`, which is not a name it has.
  if (p === '') return ''
  const { rest } = splitRoot(flavor, normalizeFlavorPath(flavor, p))
  return segments(flavor, rest).pop() ?? ''
}

const DISTRO = /^[A-Za-z0-9._-]+$/
/** Whether a string can name a WSL distribution here: letters, digits, `.`, `_` and `-`, never `.` or `..`. */
export const isWslDistroName = (d: string): boolean => DISTRO.test(d) && d !== '.' && d !== '..'

/**
 * `\\wsl.localhost\<distro>\a\b` or `\\wsl$\<distro>\a\b` (either separator, any case) as the
 * distro and its POSIX path; null for any other path, or one that climbs with `..`.
 */
export function wslUncToPosix(p: string): { distro: string; path: string } | null {
  const m = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]+([^\\/]+)(?:[\\/](.*))?$/i.exec(p)
  if (!m || !isWslDistroName(m[1]!)) return null
  const parts = (m[2] ?? '').split(/[\\/]+/)
  if (parts.includes('..')) return null
  return { distro: m[1]!, path: normalizeFlavorPath('posix', '/' + parts.join('/')) }
}

/** The Windows UNC path of an absolute POSIX path inside a distro. */
export function posixToWslUnc(distro: string, posixPath: string): string {
  if (!isWslDistroName(distro)) throw new Error(`not a WSL distro name: ${JSON.stringify(distro)}`)
  if (!posixPath.startsWith('/')) throw new Error(`not an absolute POSIX path: ${JSON.stringify(posixPath)}`)
  const rest = normalizeFlavorPath('posix', posixPath).slice(1)
  return `\\\\wsl.localhost\\${distro}\\${rest.split('/').join('\\')}`
}
