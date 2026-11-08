import { appendFileSync } from 'node:fs'
import { shouldNotify, type AppOptions, type NotificationKind } from '@workhub/core'

/** The part of Electron's Notification the notifier uses (a fake in tests). */
export interface NotificationLike {
  on(event: 'click' | 'close', listener: () => void): unknown
  show(): void
  /** Removes it from the notification center (Electron's `close`). */
  close?(): void
}

export interface NotifierDeps {
  options: () => Promise<AppOptions>
  supported: () => boolean
  create: (content: { title: string; body: string }) => NotificationLike
  now?: () => number
  /** WORKHUB_NOTIFICATION_LOG: a run can read back what was shown without the OS notification center. */
  logPath?: string
  /** Called after each shown notification (the tray lists the recent ones). */
  onShown?: () => void
  /** Gets every notification that was shown, to repeat it elsewhere (a paired phone). */
  mirror?: (notification: MirroredNotification) => void
  /**
   * Whether the profile's quiet hours hold this kind back now (see `quietNow`). `profileId` is the
   * one the notification is about when it says (`log.profileId`), else the active profile.
   */
  quiet?: (kind: NotificationKind, profileId: string | undefined, now: number) => Promise<boolean>
}

/** Where a notification goes: the OS notification and the menu bar's recent list. */
export type NotificationChannel = 'notification' | 'tray'

export interface ShownNotification {
  id: string
  kind: NotificationKind
  title: string
  at: number
  /** The session it is about (`log.sessionId`), so the popover does not list it twice. */
  sessionId?: string
  open: () => void
}

/** A shown notification as it is repeated to a paired device: words only, never the open action. */
export interface MirroredNotification {
  kind: NotificationKind
  title: string
  body: string
  at: number
  sessionId?: string
  profileId?: string
  /** The same key as `replaces`: a newer notification about the same thing takes the older one's place. */
  tag?: string
}

/** How many shown notifications the menu bar remembers. */
export const RECENT_NOTIFICATIONS = 20

/**
 * Every OS notification goes through here: the kind's switch and "Pause notifications" are
 * checked in one place, the notification stays referenced until it closes (or the OS may drop its
 * click handler), and the recent ones are kept for the menu bar's "Recent notifications".
 */
export class Notifier {
  private readonly live = new Set<NotificationLike>()
  /** The last notification shown under each `replaces` key, so a newer one takes its place. */
  private readonly byKey = new Map<string, NotificationLike>()
  private readonly recentList: ShownNotification[] = []
  private seq = 0

  constructor(private readonly deps: NotifierDeps) {}

  /**
   * Resolves to whether it was shown. `log` adds fields to the test log line. `replaces`: a key
   * (one session, say) whose previous notification is taken out of the notification center, so
   * only the newest one about it stays. `channels` (Health alerts, per kind): leave out
   * `notification` to only list it in the menu bar, or `tray` to show it without listing it.
   * Inside the profile's quiet hours, Health, flow-map and metric alerts are not shown at all.
   */
  async show(kind: NotificationKind, content: { title: string; body?: string }, open: () => void, log: Record<string, unknown> = {}, replaces?: string, channels?: readonly NotificationChannel[]): Promise<boolean> {
    if (typeof content?.title !== 'string' || !this.deps.supported()) return false
    const now = (this.deps.now ?? Date.now)()
    if (!shouldNotify(kind, await this.deps.options(), now)) return false
    const os = !channels || channels.includes('notification')
    const listed = !channels || channels.includes('tray')
    if (!os && !listed) return false
    if (this.deps.quiet && (await this.deps.quiet(kind, typeof log['profileId'] === 'string' ? log['profileId'] : undefined, now))) return false
    const title = content.title.slice(0, 200)
    const body = String(content.body ?? '').slice(0, 400)
    if (this.deps.logPath) appendFileSync(this.deps.logPath, `${JSON.stringify({ title, body, kind, ...log, ...(channels ? { channels } : {}) })}\n`)
    const entry: ShownNotification = { id: `n${++this.seq}`, kind, title, at: now, open }
    if (typeof log['sessionId'] === 'string') entry.sessionId = log['sessionId']
    if (listed) {
      this.recentList.unshift(entry)
      this.recentList.splice(RECENT_NOTIFICATIONS)
    }
    this.mirror(entry, body, log, replaces)
    if (!os) {
      this.deps.onShown?.()
      return true
    }
    const notification = this.deps.create({ title, body })
    if (replaces) {
      const previous = this.byKey.get(replaces)
      if (previous) {
        this.live.delete(previous)
        previous.close?.()
      }
      this.byKey.set(replaces, notification)
    }
    this.live.add(notification)
    notification.on('close', () => {
      this.live.delete(notification)
      if (replaces && this.byKey.get(replaces) === notification) this.byKey.delete(replaces)
    })
    notification.on('click', () => {
      this.live.delete(notification)
      this.forget(entry.id)
      open()
    })
    notification.show()
    this.deps.onShown?.()
    return true
  }

  private mirror(entry: ShownNotification, body: string, log: Record<string, unknown>, replaces?: string): void {
    if (!this.deps.mirror) return
    const mirrored: MirroredNotification = { kind: entry.kind, title: entry.title, body, at: entry.at }
    if (entry.sessionId) mirrored.sessionId = entry.sessionId
    if (typeof log['profileId'] === 'string') mirrored.profileId = log['profileId']
    if (replaces) mirrored.tag = replaces
    try {
      this.deps.mirror(mirrored)
    } catch {
      // A paired device must never keep a notification from showing here.
    }
  }

  /** Newest first. */
  recent(): readonly ShownNotification[] {
    return this.recentList
  }

  /** Does what a click on a recent notification does, and drops it from the list. */
  openRecent(id: string): boolean {
    const entry = this.recentList.find((n) => n.id === id)
    if (!entry) return false
    this.forget(id)
    entry.open()
    return true
  }

  /** Empties the recent list ("Clear all" in the menu bar icon). */
  clearRecent(): void {
    if (!this.recentList.length) return
    this.recentList.splice(0)
    this.deps.onShown?.()
  }

  private forget(id: string): void {
    const i = this.recentList.findIndex((n) => n.id === id)
    if (i >= 0) this.recentList.splice(i, 1)
    this.deps.onShown?.()
  }
}
