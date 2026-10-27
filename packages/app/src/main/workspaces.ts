import { stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expandProfileFolders, needsGitCheck, profileFolderPaths, projectChildren, type FolderChild, type Profile } from '@workhub/core'
import type { WorkspaceFolder } from '../shared/api'

type ReadDir = (path: string) => Promise<{ name: string; isDirectory(): boolean }[]>
type Exists = (path: string) => Promise<boolean>

export type FolderListing = Record<string, FolderChild[] | null>

const exists: Exists = (path) => stat(path).then(
  () => true,
  () => false
)

/**
 * The child folders of each of the profile's folders, by normalized path (null: it cannot be
 * read). `.git` is only looked for in the folders that list only git repositories.
 */
export async function readProfileListing(
  profile: Pick<Profile, 'folders' | 'folderOptions'>,
  home: string,
  read: ReadDir = (p) => readdir(p, { withFileTypes: true }),
  hasGit: Exists = (p) => exists(join(p, '.git'))
): Promise<FolderListing> {
  const out: FolderListing = {}
  for (const { folder, path } of profileFolderPaths(profile, home)) {
    if (path in out) continue
    const entries = await read(path).catch(() => null)
    if (!entries) {
      out[path] = null
      continue
    }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    const git = needsGitCheck(profile, folder, home)
    out[path] = await Promise.all(dirs.map(async (e) => ({ name: e.name, ...(git ? { isGitRepo: await hasGit(join(path, e.name)) } : {}) })))
  }
  return out
}

/**
 * The folders a profile works in, as Workhub 1's sidebar listed them: each profile folder, then
 * the folders inside it (hidden ones left out, only git repositories when the folder asks for
 * that). A folder that cannot be read is skipped; a folder listed twice appears once.
 */
export async function profileWorkspaces(profile: Pick<Profile, 'folders' | 'folderOptions'>, home: string, read?: ReadDir, hasGit?: Exists): Promise<WorkspaceFolder[]> {
  const listing = await readProfileListing(profile, home, read, hasGit)
  return expandProfileFolders(profile, listing, home).map(({ path, name, root }) => ({ path, name, root }))
}

/**
 * The projects each profile folder splits into for token spend ("Each subfolder is its own
 * project"; unset: every folder that is not a repository is split, as before the switch existed).
 */
export async function profileProjectChildren(profile: Pick<Profile, 'folders' | 'folderOptions'>, home: string, read?: ReadDir, hasGit: Exists = (p) => exists(join(p, '.git'))): Promise<Record<string, string[]>> {
  const listing = await readProfileListing(profile, home, read, hasGit)
  const repos = new Set<string>()
  for (const { path } of profileFolderPaths(profile, home)) if (await hasGit(path)) repos.add(path)
  return projectChildren(profile, listing, home, (path) => repos.has(path))
}
