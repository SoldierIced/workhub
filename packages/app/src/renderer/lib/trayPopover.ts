import type { TrayAction, TrayPopoverSession, TrayPopoverView, TrayTone } from '@workhub/core'
import type { Tone } from '../components/atoms/Badge'
import { LEVEL_LABEL, LEVEL_TONE } from './attention'
import type { MessageKey } from '../i18n/translate'

/** "5m", "3h", "2d" since `at`; null under a minute ("now"). */
export function elapsed(at: number, now: number): string | null {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return null
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** The chip a session row shows: its attention level, else its plain state. */
export function sessionChip(s: Pick<TrayPopoverSession, 'level' | 'state'>): { tone: Tone; key: MessageKey } {
  if (s.level) return { tone: LEVEL_TONE[s.level], key: LEVEL_LABEL[s.level] }
  if (s.state === 'starting') return { tone: 'warning', key: 'trayPopover.state.starting' }
  if (s.state === 'stopped') return { tone: 'neutral', key: 'trayPopover.state.stopped' }
  return { tone: 'neutral', key: 'trayPopover.state.idle' }
}

/** The popover's tones are the badge tones. */
export const toneOf = (tone: TrayTone): Tone => tone

export const BAR_CLASS: Record<TrayTone, string> = {
  neutral: 'bg-subtle',
  success: 'brand-gradient',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-danger'
}

export const DOT_CLASS: Record<TrayTone, string> = {
  neutral: 'bg-subtle',
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-danger'
}

/**
 * Arrow-key navigation between the popover's rows and buttons: the index to focus for `key`
 * from `current` (-1: nothing focused yet) among `count` items, or null for other keys.
 */
export function nextFocus(current: number, count: number, key: string): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** An entry of one of the popover's footer menus (the bell and "⋯"). */
export interface PopoverMenuItem {
  id: 'resume' | 'pauseHour' | 'pauseTomorrow' | 'pauseIndefinite' | 'adjustNotifications' | 'checkForUpdates' | 'quit'
  label: MessageKey
  action: TrayAction
  /** A line above it. */
  separated?: boolean
}

export type PopoverMenuId = 'notifications' | 'more'

/**
 * The footer menus. The bell offers the pause presets and the notification settings; while
 * paused it offers Resume first. "⋯" offers checking for updates where the build can, and quitting.
 */
export function popoverMenuItems(menu: PopoverMenuId, view: Pick<TrayPopoverView, 'canCheckForUpdates' | 'pausedUntil'>): PopoverMenuItem[] {
  if (menu === 'notifications') {
    const paused = view.pausedUntil !== null
    const items: PopoverMenuItem[] = paused ? [{ id: 'resume', label: 'trayPopover.menu.resume', action: { kind: 'resume' } }] : []
    items.push(
      { id: 'pauseHour', label: 'trayPopover.menu.pauseHour', action: { kind: 'pause', preset: 'hour' }, separated: paused },
      { id: 'pauseTomorrow', label: 'trayPopover.menu.pauseTomorrow', action: { kind: 'pause', preset: 'tomorrow' } },
      { id: 'pauseIndefinite', label: 'trayPopover.menu.pauseIndefinite', action: { kind: 'pause', preset: 'indefinite' } },
      { id: 'adjustNotifications', label: 'trayPopover.menu.adjust', action: { kind: 'openSettings', section: 'notifications' }, separated: true }
    )
    return items
  }
  const items: PopoverMenuItem[] = []
  if (view.canCheckForUpdates) items.push({ id: 'checkForUpdates', label: 'trayPopover.checkForUpdates', action: { kind: 'checkForUpdates' } })
  items.push({ id: 'quit', label: 'trayPopover.quitTitle', action: { kind: 'quit' }, separated: items.length > 0 })
  return items
}

/** How long until `at`, as the words of a countdown ("12 min", "2 h 40", "3 h"); minutes round up. */
export function countdown(at: number, now: number): { key: MessageKey; params: Record<string, number> } {
  const total = Math.max(1, Math.ceil((at - now) / 60_000))
  if (total < 60) return { key: 'trayPopover.countdown.minutes', params: { minutes: total } }
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return minutes ? { key: 'trayPopover.countdown.hoursMinutes', params: { hours, minutes } } : { key: 'trayPopover.countdown.hours', params: { hours } }
}
