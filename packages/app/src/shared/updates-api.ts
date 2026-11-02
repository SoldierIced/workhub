/** Update checks against the GitHub Releases of the project (P8). */
export type UpdateState = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** The newer version, when `state` is `available`, `downloading` or `ready` (installed, runs after a restart). */
  version?: string
  /** Where to download the new version by hand (always set when `available`). */
  releaseUrl?: string
  /**
   * Whether the app can download and install the update itself. On macOS only when it runs from a
   * bundle in a folder it can write to (it replaces its own bundle); otherwise the user downloads it.
   */
  canInstall: boolean
  message?: string
}

export interface UpdatesApi {
  status(): Promise<UpdateStatus>
  /** An explicit check, allowed even while the "check for updates" option is off. */
  check(): Promise<UpdateStatus>
  /** Downloads and installs (when `canInstall`), else opens the release page. Ends in `ready`. */
  install(): Promise<UpdateStatus>
  /** Restarts into an update that is `ready`. */
  restart(): Promise<void>
  onChanged(cb: (status: UpdateStatus) => void): () => void
  /** Never prompt again for this version (a newer one still prompts). */
  skip(version: string): Promise<void>
  /** An automatic check found a newer version and the once-a-day prompt is due. */
  onPrompt(cb: (status: UpdateStatus) => void): () => void
}
