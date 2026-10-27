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

/** An entry of the popover's own "More" menu (what the native tray menu offered besides the lists). */
export interface PopoverMenuItem {
  id: 'pauseHour' | 'pauseTomorrow' | 'resume' | 'checkForUpdates' | 'quit'
  label: MessageKey
  action: TrayAction
  /** A line above it. */
  separated?: boolean
}

/**
 * The popover's "More" menu: the pause presets (or resume), checking for updates where the build
 * can, and quitting. Opening the window, settings and a new session already sit in the popover.
 */
export function popoverMenuItems(view: Pick<TrayPopoverView, 'pausedUntil' | 'canCheckForUpdates'>): PopoverMenuItem[] {
  const items: PopoverMenuItem[] = view.pausedUntil
    ? [{ id: 'resume', label: 'trayPopover.resume', action: { kind: 'resume' } }]
    : [
        { id: 'pauseHour', label: 'trayPopover.pauseHour', action: { kind: 'pause', preset: 'hour' } },
        { id: 'pauseTomorrow', label: 'trayPopover.pauseTomorrow', action: { kind: 'pause', preset: 'tomorrow' } }
      ]
  if (view.canCheckForUpdates) items.push({ id: 'checkForUpdates', label: 'trayPopover.checkForUpdates', action: { kind: 'checkForUpdates' }, separated: true })
  items.push({ id: 'quit', label: 'trayPopover.quitTitle', action: { kind: 'quit' }, separated: true })
  return items
}
