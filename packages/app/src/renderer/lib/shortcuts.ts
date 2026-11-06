import type { Platform } from '@shared/api'

/**
 * A keyboard shortcut with the platform's primary modifier (CmdOrCtrl): Command on macOS,
 * Control on Windows and Linux.
 */
export interface Shortcut {
  key: string
  shift?: boolean
  alt?: boolean
  /** False: the key without the primary modifier (Alt+↑ moves a sidebar row). */
  mod?: false
}

/** The part of a KeyboardEvent shortcut matching reads. */
export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** Labels of each key of a shortcut, in display order, e.g. ['⌘', '1'] on macOS, ['Ctrl', '1'] elsewhere. */
export function shortcutKeys(shortcut: Shortcut, platform: Platform): string[] {
  const mac = platform === 'mac'
  const keys: string[] = []
  if (mac) {
    if (shortcut.alt) keys.push('⌥')
    if (shortcut.shift) keys.push('⇧')
    if (shortcut.mod !== false) keys.push('⌘')
  } else {
    if (shortcut.mod !== false) keys.push('Ctrl')
    if (shortcut.alt) keys.push('Alt')
    if (shortcut.shift) keys.push('Shift')
  }
  keys.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key)
  return keys
}

/** One string for tooltips and aria-keyshortcuts-like hints: '⌘1' on macOS, 'Ctrl+1' elsewhere. */
export function shortcutLabel(shortcut: Shortcut, platform: Platform): string {
  return shortcutKeys(shortcut, platform).join(platform === 'mac' ? '' : '+')
}

/** True when the event is the shortcut on this platform (the other platform's modifier must be up). */
export function matchesShortcut(e: KeyLike, shortcut: Shortcut, platform: Platform): boolean {
  const mod = shortcut.mod === false ? !e.metaKey && !e.ctrlKey : platform === 'mac' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return (
    mod &&
    e.shiftKey === Boolean(shortcut.shift) &&
    e.altKey === Boolean(shortcut.alt) &&
    e.key.toLowerCase() === shortcut.key.toLowerCase()
  )
}

/** Copy written with macOS glyphs ("the Tickets screen (⌘3)") shown with this platform's modifier. */
export function platformShortcutText(text: string, platform: Platform): string {
  return platform === 'mac' ? text : text.replace(/⌘(\S)/g, 'Ctrl+$1')
}
