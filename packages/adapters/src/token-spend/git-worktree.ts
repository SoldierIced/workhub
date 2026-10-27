/**
 * Which repository a linked git worktree belongs to, read from the files git keeps (no git
 * process): a worktree's `.git` is a file `gitdir: <main>/.git/worktrees/<name>`, and that folder's
 * `commondir` points at the main repository's `.git`. Used to count a worktree that lives outside
 * a profile's folders for its repository inside them. Never throws.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

export interface WorktreeLink {
  /** The linked worktree's root (the folder holding the `.git` file). */
  worktree: string
  /** The main worktree's root (the folder holding the shared `.git` folder). */
  main: string
}

const MAX_DEPTH = 40

/**
 * The linked worktree a path is in, with its main worktree; null for a path in a main worktree,
 * outside any repository, or in a bare repository's worktree. The path need not exist any more:
 * the nearest existing folder above it is used.
 */
export async function worktreeOf(path: string): Promise<WorktreeLink | null> {
  let dir = resolve(path)
  for (let i = 0; i < MAX_DEPTH; i++) {
    const info = await stat(resolve(dir, '.git')).catch(() => null)
    if (info?.isDirectory()) return null
    if (info?.isFile()) return linkOf(dir)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

async function linkOf(worktree: string): Promise<WorktreeLink | null> {
  const text = await readFile(resolve(worktree, '.git'), 'utf8').catch(() => '')
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text)
  if (!m?.[1]) return null
  const gitdir = isAbsolute(m[1]) ? m[1] : resolve(worktree, m[1])
  const common = (await readFile(resolve(gitdir, 'commondir'), 'utf8').catch(() => '')).trim()
  // Without `commondir`, `<main>/.git/worktrees/<name>` still names the main repository.
  const commonDir = common ? (isAbsolute(common) ? common : resolve(gitdir, common)) : basename(dirname(gitdir)) === 'worktrees' ? dirname(dirname(gitdir)) : null
  if (!commonDir || basename(commonDir) !== '.git') return null
  const main = dirname(commonDir)
  return main === worktree ? null : { worktree, main }
}

/**
 * Worktree root -> main root for the paths given, as `folderSpend`'s `aliases`. Results (also the
 * misses) are kept in `cache` across calls.
 */
export async function worktreeAliases(paths: Iterable<string>, cache: Map<string, WorktreeLink | null> = new Map()): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const p of paths) {
    let link = cache.get(p)
    if (link === undefined) {
      link = await worktreeOf(p)
      cache.set(p, link)
    }
    if (link) out[link.worktree] = link.main
  }
  return out
}
