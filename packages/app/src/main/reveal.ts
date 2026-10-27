import { isAbsolute, relative, resolve } from 'node:path'

/**
 * The absolute path of a file a session's agent named, only when it lies inside the session's
 * folder; null otherwise (another folder, `..` tricks, an empty path). The caller only reveals
 * it in the file manager: nothing is opened or run.
 */
export function pathInsideFolder(folder: string, path: string): string | null {
  if (typeof path !== 'string' || !path.trim() || typeof folder !== 'string' || !folder) return null
  const root = resolve(folder)
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}
