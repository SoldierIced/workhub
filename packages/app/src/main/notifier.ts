import { appendFileSync } from 'node:fs'
import { shouldNotify, type AppOptions, type NotificationKind } from '@workhub/core'

/** The part of Electron's Notification the notifier uses (a fake in tests). */
export interface NotificationLike {
  on(event: 'click' | 'close', listener: () => void): unknown
  show(): void
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
}

export interface ShownNotification {
  id: string
  kind: NotificationKind
  title: string
  at: number
  open: () => void
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
  private readonly recentList: ShownNotification[] = []
  private seq = 0

  constructor(private readonly deps: NotifierDeps) {}

  /** Resolves to whether it was shown. `log` adds fields to the test log line. */
  async show(kind: NotificationKind, content: { title: string; body?: string }, open: () => void, log: Record<string, unknown> = {}): Promise<boolean> {
    if (typeof content?.title !== 'string' || !this.deps.supported()) return false
    const now = (this.deps.now ?? Date.now)()
    if (!shouldNotify(kind, await this.deps.options(), now)) return false
    const title = content.title.slice(0, 200)
    const body = String(content.body ?? '').slice(0, 400)
    if (this.deps.logPath) appendFileSync(this.deps.logPath, `${JSON.stringify({ title, body, kind, ...log })}\n`)
    const entry: ShownNotification = { id: `n${++this.seq}`, kind, title, at: now, open }
    this.recentList.unshift(entry)
    this.recentList.splice(RECENT_NOTIFICATIONS)
    const notification = this.deps.create({ title, body })
    this.live.add(notification)
    notification.on('close', () => this.live.delete(notification))
    notification.on('click', () => {
      this.live.delete(notification)
      this.forget(entry.id)
      open()
    })
    notification.show()
    this.deps.onShown?.()
    return true
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
