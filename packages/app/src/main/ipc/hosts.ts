import { listWslDistros, type WslRun } from '@workhub/core'
import type { IpcRegistrar } from '../ipc-guard'
import type { HostStatus, WslDistrosResult } from '../../shared/hosts-api'

export interface HostsIpcDeps {
  platform: NodeJS.Platform
  /** `wsl.exe`, for the list of distributions. */
  run: WslRun
  statuses: () => HostStatus[]
  /** Starts a failed host again; false when the id is not one that failed. */
  retry: (id: string) => boolean
}

/** The installed WSL distributions on Windows; none, with the reason, anywhere else or when WSL has none. */
export async function wslDistros(platform: NodeJS.Platform, run: WslRun): Promise<WslDistrosResult> {
  if (platform !== 'win32') return { distros: [], reason: 'notWindows' }
  const distros = await listWslDistros(run).catch(() => [])
  return distros.length ? { distros } : { distros: [], reason: 'none' }
}

/** Where sessions run (`hosts:*`): the WSL distributions, each host's status, and a retry of a failed one. */
export function registerHostsIpc(ipc: IpcRegistrar, deps: HostsIpcDeps): void {
  ipc.handle('hosts:wslDistros', () => wslDistros(deps.platform, deps.run))
  ipc.handle('hosts:status', () => deps.statuses())
  ipc.handle('hosts:retry', (_e, id: unknown) => typeof id === 'string' && deps.retry(id))
}
