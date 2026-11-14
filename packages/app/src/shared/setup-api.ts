import type { InstallerId, SetupItem } from '@workhub/core'

/** The windows the setup flow opens (hash routes of the renderer: `#welcome`, `#setup`, `#howitworks`). */
export type SetupPage = 'welcome' | 'check' | 'help'

export interface SetupApi {
  /** Runs every check; the commands run with a timeout each. */
  run(): Promise<SetupItem[]>
  /** Installs a missing tool with the main process's own command for that installer; resolves when it ends. */
  install(installer: InstallerId): Promise<{ ok: boolean; output: string }>
  /** Opens (or focuses) a setup window. */
  openWindow(page: SetupPage): void
  /** Opens the Settings window on a tab (used by the fix buttons of the setup windows). */
  openSettings(tab: string): void
  /** The welcome flow is done: it does not open again on its own. */
  completeWelcome(): Promise<void>
}

/** Per-profile session environment variables: the values live in the secret store and never come back. */
export interface ProfileEnvApi {
  /** Names of the variables that have a stored value. */
  stored(profileId: string): Promise<string[]>
  /** Stores the given values and forgets the removed names. */
  save(profileId: string, values: Record<string, string>, removed: string[]): Promise<void>
}

export interface SystemNotificationsStatus {
  /** The OS shows this app's notifications: supported, and on macOS allowed in System Settings → Notifications. */
  supported: boolean
}

/** What the OS said about a test notification: shown, refused (with its reason), or nothing in time. */
export type NotificationTestResult = { outcome: 'shown' } | { outcome: 'failed'; error: string } | { outcome: 'timeout' }

export interface SystemNotificationsApi {
  status(): Promise<SystemNotificationsStatus>
  /** Opens the OS page where notifications for the app are turned on. */
  openSystemSettings(): void
  /** Shows one notification through the OS with this body, and reports what the OS said. */
  test(body: string): Promise<NotificationTestResult>
}
