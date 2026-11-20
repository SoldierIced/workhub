// The Changes screen's lists, grown a page at a time: changed files and the pieces of one file's
// diff. A page can repeat rows when the list moved between reads; each row is kept once.
import type { RemoteChangedFile, RemoteDiffPiece } from '../shared/remote-changes-api'

export const fileKey = (f: Pick<RemoteChangedFile, 'repo' | 'path'>): string => `${f.repo}\0${f.path}`
export const pieceKey = (p: Pick<RemoteDiffPiece, 'hunk' | 'start'>): string => `${p.hunk}:${p.start}`

function addOnce<T>(have: readonly T[], rows: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set(have.map(keyOf))
  const out = [...have]
  for (const row of rows) {
    const key = keyOf(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

export const addFiles = (have: readonly RemoteChangedFile[], rows: readonly RemoteChangedFile[]): RemoteChangedFile[] => addOnce(have, rows, fileKey)
export const addPieces = (have: readonly RemoteDiffPiece[], rows: readonly RemoteDiffPiece[]): RemoteDiffPiece[] => addOnce(have, rows, pieceKey)

/**
 * A path in two parts for a row that may be too narrow: the `tail` (its last `keep` segments) is
 * always shown whole, the `head` before it gives way, so the middle is what gets cut and never the
 * end, which is what tells two paths apart. `head` keeps its trailing slash.
 */
export function splitPath(path: string, keep = 1): { head: string; tail: string } {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/(?<=[\\/])/)
  if (parts.length <= keep) return { head: '', tail: trimmed }
  return { head: parts.slice(0, parts.length - keep).join(''), tail: parts.slice(parts.length - keep).join('') }
}

/** A changed file's name and the folder it is in (empty at the repository's root). */
export function fileParts(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}
