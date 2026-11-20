import { stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expandProfileFolders, joinFlavorPath, needsGitCheck, posixToWslUnc, profileFolderPaths, projectChildren, type FolderChild, type Profile, type ProfileHost } from '@workhub/core'
import type { WorkspaceFolder } from '../shared/api'

type ReadDir = (path: string) => Promise<{ name: string; isDirectory(): boolean }[]>
type Exists = (path: string) => Promise<boolean>

export type FolderListing = Record<string, FolderChild[] | null>

const exists: Exists = (path) => stat(path).then(
  () => true,
  () => false
)

/** How a profile's folders are read: their child folders, whether a path exists, and how a child's path is made. */
export interface FolderIo {
  read: ReadDir
  hasGit: Exists
  join: (parent: string, name: string) => string
}

/**
 * How the folders of a profile on `host` are read. A WSL profile's folders are Linux paths: on
 * Windows they are read through the distribution's `\\wsl.localhost\<distro>` share, and a child's
 * path is always joined with `/` (Windows' own join would turn the Linux path into a Windows one).
 */
export function folderIo(host: ProfileHost | undefined, platform: NodeJS.Platform = process.platform, fs: { readdir: ReadDir; exists: Exists } = { readdir: (p) => readdir(p, { withFileTypes: true }), exists }): FolderIo {
  if (host?.kind !== 'wsl') return { read: fs.readdir, hasGit: fs.exists, join }
  const local = (p: string) => (platform === 'win32' && p.startsWith('/') ? posixToWslUnc(host.distro, p) : p)
  return {
    read: (p) => fs.readdir(local(p)),
    hasGit: (p) => fs.exists(local(p)),
    join: (parent, name) => joinFlavorPath('posix', parent, name)
  }
}

/**
 * The child folders of each of the profile's folders, by normalized path (null: it cannot be
 * read). `.git` is only looked for in the folders that list only git repositories.
 */
export async function readProfileListing(profile: Pick<Profile, 'folders' | 'folderOptions' | 'host'>, home: string, io: FolderIo = folderIo(profile.host)): Promise<FolderListing> {
  const out: FolderListing = {}
  for (const { folder, path } of profileFolderPaths(profile, home)) {
    if (path in out) continue
    const entries = await io.read(path).catch(() => null)
    if (!entries) {
      out[path] = null
      continue
    }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    const git = needsGitCheck(profile, folder, home)
    out[path] = await Promise.all(dirs.map(async (e) => ({ name: e.name, ...(git ? { isGitRepo: await io.hasGit(io.join(io.join(path, e.name), '.git')) } : {}) })))
  }
  return out
}

/**
 * The folders a profile works in, as Workhub 1's sidebar listed them: each profile folder, then
 * the folders inside it (hidden ones left out, only git repositories when the folder asks for
 * that). A folder that cannot be read is skipped; a folder listed twice appears once. The folders
 * of a WSL profile are read inside its distribution (`folderIo`).
 */
export async function profileWorkspaces(profile: Pick<Profile, 'folders' | 'folderOptions' | 'host'>, home: string, io?: FolderIo): Promise<WorkspaceFolder[]> {
  const listing = await readProfileListing(profile, home, io)
  return expandProfileFolders(profile, listing, home).map(({ path, name, root }) => ({ path, name, root }))
}

/**
 * The projects each profile folder splits into for token spend ("Each subfolder is its own
 * project"; unset: every folder that is not a repository is split, as before the switch existed).
 */
export async function profileProjectChildren(profile: Pick<Profile, 'folders' | 'folderOptions' | 'host'>, home: string, io: FolderIo = folderIo(profile.host)): Promise<Record<string, string[]>> {
  const listing = await readProfileListing(profile, home, io)
  const repos = new Set<string>()
  for (const { path } of profileFolderPaths(profile, home)) if (await io.hasGit(io.join(path, '.git'))) repos.add(path)
  return projectChildren(profile, listing, home, (path) => repos.has(path))
}
