import type { ModuleToggles, OptionalModule } from '@workhub/core'
import { moduleScreens } from '@workhub/core'
import type { Shortcut } from './shortcuts'

export type Route =
  | 'home'
  | 'pullRequests'
  | 'tickets'
  | 'slack'
  | 'automations'
  | 'history'
  | 'flowMaps'
  | 'health'
  | 'plan'
  | 'sessions'
  | 'settings'

export interface NavItem {
  route: Route
  shortcut: Shortcut
  /** The optional module that must be on in the active profile for the item to show. */
  module?: OptionalModule
}

/** Main navigation, in Workhub 1's order and with its keys (⌘1-⌘8; ⌘7, once Flows, is Flow maps), then Plan (⌘9). */
export const NAV_ITEMS: readonly NavItem[] = [
  { route: 'home', shortcut: { key: '1' } },
  { route: 'pullRequests', shortcut: { key: '2' } },
  { route: 'tickets', shortcut: { key: '3' } },
  { route: 'slack', shortcut: { key: '4' }, module: 'chatWatcher' },
  { route: 'automations', shortcut: { key: '5' }, module: 'automations' },
  { route: 'history', shortcut: { key: '6' } },
  { route: 'flowMaps', shortcut: { key: '7' }, module: 'flowMaps' },
  { route: 'health', shortcut: { key: '8' }, module: 'health' },
  { route: 'plan', shortcut: { key: '9' }, module: 'planner' }
]

export const SESSIONS_ITEM: NavItem = { route: 'sessions', shortcut: { key: '0' } }
export const SETTINGS_ITEM: NavItem = { route: 'settings', shortcut: { key: ',' } }
/** Workhub 1's "new session" key. */
export const NEW_SESSION_SHORTCUT: Shortcut = { key: 't' }
/** Shows or hides the left sidebar. Not Option: on macOS it changes the key the event carries. */
export const SIDEBAR_SHORTCUT: Shortcut = { key: 's', shift: true }
/** Shows or hides the session monitor panel. */
export const MONITOR_SHORTCUT: Shortcut = { key: 'm', shift: true }

/** Nav items the active profile shows: an item tied to a module is hidden while the module is off. */
export function visibleNavItems(modules: ModuleToggles | undefined): NavItem[] {
  const on = new Set(moduleScreens(modules))
  return NAV_ITEMS.filter((item) => !item.module || on.has(item.module))
}

/** Every item reachable from the sidebar and the keyboard, in shortcut order. */
export function allNavItems(modules: ModuleToggles | undefined): NavItem[] {
  return [...visibleNavItems(modules), SESSIONS_ITEM, SETTINGS_ITEM]
}
