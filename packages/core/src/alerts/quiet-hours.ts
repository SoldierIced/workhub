/**
 * Quiet hours (Settings → Alerts, per profile): Health, flow-map and metric alert notifications
 * are not shown between `startHour` and `endHour`, local time. The watchers still record and
 * cool down what they found, so nothing bursts out when the quiet hours end. Session and meeting
 * notifications are never held back.
 */
import { inHourWindow } from '../automations/rules'
import type { NotificationKind } from '../notifications/policy'

export interface QuietHours {
  /** 0 to 23; the window is `[startHour, endHour)` and crosses midnight when the start is later. */
  startHour: number
  endHour: number
}

/** Stored under `profile.alerts`. */
export interface ProfileAlertSettings {
  quietHours: QuietHours | null
}

/** The notification kinds quiet hours hold back. */
export const QUIET_HOURS_KINDS: readonly NotificationKind[] = ['health', 'flowMaps', 'metricAlert']

/** Whether `now` (epoch ms) falls inside the quiet hours. Equal start and end hours mean none. */
export function inQuietHours(quiet: QuietHours | null | undefined, now: number): boolean {
  if (!quiet || quiet.startHour === quiet.endHour) return false
  return inHourWindow(new Date(now).getHours(), quiet.startHour, quiet.endHour)
}

/** Whether a notification of this kind is held back at `now`. */
export function quietNow(kind: NotificationKind, quiet: QuietHours | null | undefined, now: number): boolean {
  return QUIET_HOURS_KINDS.includes(kind) && inQuietHours(quiet, now)
}
