/**
 * Which OS notifications are sent. Every kind has its own switch in Settings → General (a pull
 * request event also has one per event kind, checked where the event is worded), and "Pause
 * notifications" silences every kind until a moment in time. The main process asks `shouldNotify`
 * before it shows anything, so no notification path can skip the pause.
 */
import type { AppOptions } from '../config/schema'

export const NOTIFICATION_KINDS = ['replied', 'needsAnswer', 'error', 'prEvent', 'slack', 'automations', 'aiReview', 'tickets', 'health', 'usage'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

/** The boolean option that turns a kind on or off; null for kinds governed elsewhere. */
export const NOTIFICATION_TOGGLE: Record<NotificationKind, keyof AppOptions | null> = {
  replied: 'notifyReplied',
  needsAnswer: 'notifyNeedsAnswer',
  error: 'notifyError',
  // One switch per pull request event kind (`notifyPrEvents`), checked when the event is worded.
  prEvent: null,
  slack: 'notifySlack',
  automations: 'notifyAutomations',
  // AI review notices follow the session switches: a review that paused needs an answer.
  aiReview: 'notifyNeedsAnswer',
  tickets: 'notifyTickets',
  health: 'notifyHealth',
  // Usage alerts have their own switch per account under Settings → Usage.
  usage: null
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value)
}

/** Whether "Pause notifications" is in effect at `now` (epoch ms). */
export function notificationsPaused(options: Pick<AppOptions, 'notificationsPausedUntil'>, now: number): boolean {
  const until = options.notificationsPausedUntil
  return typeof until === 'number' && until > now
}

/** Whether a notification of this kind may be shown now. */
export function shouldNotify(kind: NotificationKind, options: AppOptions, now: number): boolean {
  if (notificationsPaused(options, now)) return false
  const toggle = NOTIFICATION_TOGGLE[kind]
  return toggle === null || options[toggle] !== false
}

export type PausePreset = 'hour' | 'tomorrow'

/** The hour of the day "until tomorrow" ends, local time. */
export const PAUSE_TOMORROW_HOUR = 8

/**
 * When a pause chosen now ends (epoch ms): an hour from now, or tomorrow at 08:00 local time.
 * `now` is a Date so the local calendar (and its daylight-saving changes) decides "tomorrow".
 */
export function pauseUntil(preset: PausePreset, now: Date): number {
  if (preset === 'hour') return now.getTime() + 60 * 60_000
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, PAUSE_TOMORROW_HOUR, 0, 0, 0)
  return end.getTime()
}
