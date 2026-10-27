import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { WorkspaceFolder } from '../shared/api'
import { expandHome } from './automations'

/** How many child folders one profile folder lists at most (a huge folder must not flood the sidebar). */
const CHILDREN_CAP = 500

type ReadDir = (path: string) => Promise<{ name: string; isDirectory(): boolean }[]>

/**
 * The folders a profile works in, as Workhub 1's sidebar listed them: each profile folder, then
 * the folders inside it (hidden ones left out, by name). A folder that cannot be read is skipped;
 * a folder listed twice appears once.
 */
export async function profileWorkspaces(folders: readonly string[], home: string, read: ReadDir = (p) => readdir(p, { withFileTypes: true })): Promise<WorkspaceFolder[]> {
  const out: WorkspaceFolder[] = []
  const seen = new Set<string>()
  const add = (folder: WorkspaceFolder) => {
    if (seen.has(folder.path)) return
    seen.add(folder.path)
    out.push(folder)
  }
  for (const raw of folders) {
    if (!raw.trim()) continue
    const root = resolve(expandHome(raw.trim(), home))
    const entries = await read(root).catch(() => null)
    if (!entries) continue
    add({ path: root, name: basename(root) || root, root: true })
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .slice(0, CHILDREN_CAP)
      .forEach((name) => add({ path: join(root, name), name, root: false }))
  }
  return out
}
