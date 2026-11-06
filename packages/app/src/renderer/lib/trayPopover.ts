import type { TrayAction, TrayPopoverSession, TrayPopoverUsage, TrayPopoverView, TrayTone } from '@workhub/core'
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

/** An entry of one of the popover's footer sub-views (the bell and "⋯"). */
export interface PopoverMenuItem {
  id: 'resume' | 'pauseHour' | 'pauseTomorrow' | 'pauseIndefinite' | 'quietHours' | 'adjustNotifications' | 'checkForUpdates' | 'quit'
  label: MessageKey
  action: TrayAction
  /** A line above it. */
  separated?: boolean
  /** The pause it starts, to show "until HH:MM" beside it. */
  until?: 'hour' | 'tomorrow'
  /** It opens another place (a "›" on the right). */
  opens?: boolean
}

export type PopoverMenuId = 'notifications' | 'more'

/**
 * The footer sub-views. The bell offers the pause presets, quiet hours and the notification
 * settings; while paused it offers Resume first. "⋯" offers checking for updates where the build
 * can, and quitting.
 */
export function popoverMenuItems(menu: PopoverMenuId, view: Pick<TrayPopoverView, 'canCheckForUpdates' | 'pausedUntil'>): PopoverMenuItem[] {
  if (menu === 'notifications') {
    const paused = view.pausedUntil !== null
    const items: PopoverMenuItem[] = paused ? [{ id: 'resume', label: 'trayPopover.menu.resume', action: { kind: 'resume' } }] : []
    items.push(
      { id: 'pauseHour', label: 'trayPopover.menu.pauseHour', action: { kind: 'pause', preset: 'hour' }, separated: paused, until: 'hour' },
      { id: 'pauseTomorrow', label: 'trayPopover.menu.pauseTomorrow', action: { kind: 'pause', preset: 'tomorrow' }, until: 'tomorrow' },
      { id: 'pauseIndefinite', label: 'trayPopover.menu.pauseIndefinite', action: { kind: 'pause', preset: 'indefinite' } },
      { id: 'quietHours', label: 'trayPopover.menu.quietHours', action: { kind: 'openSettings', section: 'notifications' }, separated: true, opens: true },
      { id: 'adjustNotifications', label: 'trayPopover.menu.adjust', action: { kind: 'openSettings', section: 'notifications' }, opens: true }
    )
    return items
  }
  const items: PopoverMenuItem[] = []
  if (view.canCheckForUpdates) items.push({ id: 'checkForUpdates', label: 'trayPopover.checkForUpdates', action: { kind: 'checkForUpdates' } })
  items.push({ id: 'quit', label: 'trayPopover.quitTitle', action: { kind: 'quit' }, separated: items.length > 0 })
  return items
}

const hour = (h: number) => `${String(h).padStart(2, '0')}:00`

/** The value beside "Quiet hours": the range of the active profile's quiet hours, or off. */
export function quietHoursValue(quiet: { startHour: number; endHour: number } | null | undefined): { key: MessageKey; params?: Record<string, string> } {
  if (!quiet) return { key: 'trayPopover.quietHours.off' }
  return { key: 'trayPopover.quietHours.range', params: { start: hour(quiet.startHour), end: hour(quiet.endHour) } }
}

/** With more usage accounts than this, "Usage" folds into one summary row. */
export const USAGE_FOLD_AFTER = 3

/**
 * The "Usage" block: with 1 to 3 accounts the rows as they come and no expander; with more, a
 * summary (how many, and the most spent one) and, when unfolded, every row most spent first.
 */
export function usageBlock(usage: readonly TrayPopoverUsage[], expanded: boolean): { summary: { count: number; top: TrayPopoverUsage } | null; rows: TrayPopoverUsage[] } {
  if (usage.length <= USAGE_FOLD_AFTER) return { summary: null, rows: [...usage] }
  const sorted = [...usage].sort((a, b) => b.window.percent - a.window.percent)
  return { summary: { count: usage.length, top: sorted[0]! }, rows: expanded ? sorted : [] }
}

/** "Recent" is remembered open or closed per context: while sessions need the user or work, and while none do. */
export type RecentContext = 'busy' | 'quiet'
export type RecentMemory = Partial<Record<RecentContext, boolean>>

export function recentContext(view: Pick<TrayPopoverView, 'needsYou' | 'working'>): RecentContext {
  return view.needsYou.length > 0 || view.working.length > 0 ? 'busy' : 'quiet'
}

/** Whether "Recent" is unfolded: the user's last choice in this context, else folded while busy and unfolded while quiet. */
export function recentExpanded(view: Pick<TrayPopoverView, 'needsYou' | 'working'>, memory: RecentMemory): boolean {
  const context = recentContext(view)
  return memory[context] ?? context === 'quiet'
}

export type OverflowList = 'plan' | 'needsYou' | 'working' | 'recent'

const OVERFLOW_ACTION: Record<OverflowList, TrayAction> = {
  plan: { kind: 'navigate', route: 'plan' },
  needsYou: { kind: 'navigate', route: 'sessions' },
  working: { kind: 'navigate', route: 'sessions' },
  recent: { kind: 'open' }
}

/** The "N more in the app ›" row of a list past its quota, and where it leads; null within the quota. */
export function overflowRow(view: Pick<TrayPopoverView, 'planMore' | 'needsYouMore' | 'workingMore' | 'notificationsMore'>, list: OverflowList): { count: number; action: TrayAction } | null {
  const count = { plan: view.planMore, needsYou: view.needsYouMore, working: view.workingMore, recent: view.notificationsMore }[list]
  return count > 0 ? { count, action: OVERFLOW_ACTION[list] } : null
}


/** How long until `at`, as the words of a countdown ("12 min", "2 h 40", "3 h"); minutes round up. */
export function countdown(at: number, now: number): { key: MessageKey; params: Record<string, number> } {
  const total = Math.max(1, Math.ceil((at - now) / 60_000))
  if (total < 60) return { key: 'trayPopover.countdown.minutes', params: { minutes: total } }
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return minutes ? { key: 'trayPopover.countdown.hoursMinutes', params: { hours, minutes } } : { key: 'trayPopover.countdown.hours', params: { hours } }
}
