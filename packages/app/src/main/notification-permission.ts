import type { NotificationPermission } from '@workhub/adapters/notification-permission'

/** What a native notification reports: shown, or failed (macOS refuses it when the app may not notify). */
export interface ObservedNotification {
  once(event: 'show', listener: () => void): unknown
  once(event: 'failed', listener: (event: unknown, error: string) => void): unknown
}

export interface ProbeNotification extends ObservedNotification {
  show(): void
  close(): void
}

export interface NotificationPermissionDeps {
  platform: NodeJS.Platform
  /** Electron's `Notification.isSupported()`. */
  supported: () => boolean
  /** The app's entry in Notification Center's preferences (macOS 14 and older; `unknown` elsewhere). */
  readPrefs: () => Promise<NotificationPermission>
  /** A silent notification used as a probe when the preferences cannot be read. */
  createProbe: () => ProbeNotification
  now?: () => number
  /** How long a probe waits for `show` or `failed`. */
  probeTimeoutMs?: number
}

/** A refusal is checked again at most this often (coming back from System Settings re-reads it). */
const RECHECK_DENIED_MS = 15_000

/**
 * Whether the OS shows this app's notifications, for the "OS notifications off" warning. macOS:
 * the Notification Center preferences when they can be read; otherwise what the app's own
 * notifications reported (shown or failed), and with no evidence yet one silent probe. Read-only:
 * nothing in the system settings is ever written.
 */
export class NotificationPermissionCheck {
  private evidence: { allowed: boolean; at: number } | null = null
  private probing: Promise<boolean | null> | null = null

  constructor(private readonly deps: NotificationPermissionDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Records what a notification the app showed reports. Returns it, for chaining at creation. */
  observe<T extends ObservedNotification>(notification: T): T {
    notification.once('show', () => (this.evidence = { allowed: true, at: this.now() }))
    notification.once('failed', () => (this.evidence = { allowed: false, at: this.now() }))
    return notification
  }

  async allowed(): Promise<boolean> {
    if (!this.deps.supported()) return false
    if (this.deps.platform !== 'darwin') return true
    const prefs = await this.deps.readPrefs().catch((): NotificationPermission => 'unknown')
    if (prefs !== 'unknown') return prefs === 'allowed'
    const evidence = this.evidence
    if (evidence && (evidence.allowed || this.now() - evidence.at < RECHECK_DENIED_MS)) return evidence.allowed
    const probed = await this.probe()
    // A probe that reported nothing is not a refusal: no warning.
    return probed ?? evidence?.allowed ?? true
  }

  private probe(): Promise<boolean | null> {
    this.probing ??= new Promise<boolean | null>((resolve) => {
      let probe: ProbeNotification
      try {
        probe = this.observe(this.deps.createProbe())
      } catch {
        return resolve(null)
      }
      const timer = setTimeout(() => resolve(null), this.deps.probeTimeoutMs ?? 3_000)
      probe.once('show', () => {
        clearTimeout(timer)
        probe.close()
        resolve(true)
      })
      probe.once('failed', () => {
        clearTimeout(timer)
        resolve(false)
      })
      probe.show()
    }).finally(() => (this.probing = null))
    return this.probing
  }
}
