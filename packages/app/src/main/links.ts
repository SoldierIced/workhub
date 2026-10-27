import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BrowserWindow } from 'electron'
import type { IpcRegistrar } from './ipc-guard'
import type { Checkout, WorkhubConfig } from '@workhub/core'
import type { SessionIntent } from '../shared/links-api'

const exec = promisify(execFile)

async function git(folder: string, args: string[]): Promise<string | null> {
  try {
    return (await exec('git', ['-C', folder, ...args], { windowsHide: true, timeout: 10_000 })).stdout.trim()
  } catch {
    return null // Not a git repository, no origin, or git is not installed.
  }
}

/** Parses `git worktree list --porcelain`: one block per worktree with `worktree <path>` and `branch refs/heads/<name>`. */
export function parseWorktrees(output: string): { path: string; branch?: string }[] {
  const out: { path: string; branch?: string }[] = []
  for (const block of output.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) continue
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length)
    out.push({ path, branch: ref?.replace(/^refs\/heads\//, '') })
  }
  return out
}

/** Each profile folder with its remote and branch, followed by the other worktrees of the same repository. */
export async function checkoutsOf(folders: string[]): Promise<Checkout[]> {
  const out: Checkout[] = []
  const seen = new Set<string>()
  const add = (c: Checkout) => {
    const key = c.path.replace(/[\\/]+$/, '')
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }
  for (const folder of folders) {
    const remote = (await git(folder, ['remote', 'get-url', 'origin'])) || undefined
    const branch = (await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])) || undefined
    add({ path: folder, remote, branch: branch === 'HEAD' ? undefined : branch })
    const listing = await git(folder, ['worktree', 'list', '--porcelain'])
    if (listing) for (const w of parseWorktrees(listing)) add({ path: w.path, remote, branch: w.branch })
  }
  return out
}

export interface LinksIpcDeps {
  ipcMain: IpcRegistrar
  loadConfig: () => Promise<WorkhubConfig>
  mainWindow: () => BrowserWindow | null
}

export function registerLinksIpc({ ipcMain, loadConfig, mainWindow }: LinksIpcDeps): void {
  ipcMain.handle('links:checkouts', async (_e, profileId: string | null) => {
    const config = await loadConfig()
    const profile = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId))
    return checkoutsOf(profile?.folders ?? [])
  })
  ipcMain.on('links:request', (_e, intent: SessionIntent) => {
    const win = mainWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('links:intent', intent)
  })
}
