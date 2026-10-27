/** Update checks against the GitHub Releases of the project (P8). */
export type UpdateState = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'error' | 'unsupported'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** The newer version, when `state` is `available` or `downloading`. */
  version?: string
  /** Where to download the new version by hand (always set when `available`). */
  releaseUrl?: string
  /**
   * Whether the app can download and install the update itself. False on macOS, where an unsigned
   * build cannot replace itself: the user downloads the new version instead.
   */
  canInstall: boolean
  message?: string
}

export interface UpdatesApi {
  status(): Promise<UpdateStatus>
  /** An explicit check, allowed even while the "check for updates" option is off. */
  check(): Promise<UpdateStatus>
  /** Downloads and installs (when `canInstall`), else opens the release page. */
  install(): Promise<UpdateStatus>
  onChanged(cb: (status: UpdateStatus) => void): () => void
}
