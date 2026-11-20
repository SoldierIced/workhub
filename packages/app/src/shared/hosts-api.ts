import type { WslDistro } from '@workhub/core'

/**
 * Where a host is: starting (`connecting`), installing its payload into a WSL distribution
 * (`installing`), up (`connected`), given up on until a retry (`failed`), or not possible here
 * (`unavailable`: WSL hosts run only on Windows).
 */
export type HostState = 'connecting' | 'installing' | 'connected' | 'failed' | 'unavailable'

/** The step of a host install: the payload download (with its bytes), its checksum, the unpacking. */
export type HostInstallPhase = 'downloading' | 'verifying' | 'unpacking'

export interface HostInstallProgress {
  phase: HostInstallPhase
  /** Bytes downloaded so far, while `downloading`. */
  received?: number
  /** The payload's size, when the server said it. */
  total?: number
}

/** One host, as Settings shows it: `local`, or `wsl:<distro>`. */
export interface HostStatus {
  id: string
  kind: 'local' | 'wsl'
  state: HostState
  /** Why it failed or is unavailable (a short English reason from the main process, also in the log). */
  detail?: string
  installProgress?: HostInstallProgress
  /** Connected, but its sessions cannot reach Workhub's MCP server and control endpoint. */
  warning?: 'noControl'
}

/** The installed WSL distributions; empty with a reason off Windows (`notWindows`) or when WSL has none (`none`). */
export interface WslDistrosResult {
  distros: WslDistro[]
  reason?: 'notWindows' | 'none'
}

/** Settings → Profiles → "Where sessions run" (never offered to paired devices). */
export interface HostsApi {
  wslDistros(): Promise<WslDistrosResult>
  /** Every host started in this run of the app, `local` first. */
  status(): Promise<HostStatus[]>
  /** Starts a failed host again (installing it first when needed); false when it is not one that failed. */
  retry(id: string): Promise<boolean>
  onStatus(cb: (hosts: HostStatus[]) => void): () => void
}
