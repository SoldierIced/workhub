import type { NotificationKind, TrayAction, TrayPopoverView, TrayRoute, TraySession } from '@workhub/core'

/** What only the renderer knows and the menu bar icon shows: unseen flags and the UI language. */
export interface TrayRendererState {
  locale: 'en' | 'es'
  sessions: TraySession[]
}

export interface TrayApi {
  /** Reports the sessions (with their unseen flags) and the language; sent again on every change. */
  setState(state: TrayRendererState): void
  /** The menu bar icon (or a notification) asked for a screen. */
  onNavigate(cb: (route: TrayRoute) => void): () => void
  /** "New session…" in the menu bar icon. */
  onNewSession(cb: () => void): () => void
  /** The popover window that opens from the icon (macOS, Windows); only that window gets its events. */
  popover: TrayPopoverApi
}

/** Hash the popover window loads the renderer with (see main.tsx). */
export const TRAY_POPOVER_HASH = '#tray-popover'

export interface TrayPopoverApi {
  /** What the popover shows now; null before the first tray refresh. */
  get(): Promise<TrayPopoverView | null>
  /** A new view while the popover is open. */
  onView(cb: (view: TrayPopoverView) => void): () => void
  /** The popover was shown again (reset scroll and focus). */
  onShown(cb: () => void): () => void
  /** Runs a tray action (checked again in the main process); most of them close the popover. */
  perform(action: TrayAction): void
  /** The content's natural height, so the window fits it (clamped to the screen). */
  resize(height: number): void
  hide(): void
}

export type { NotificationKind, TrayAction, TrayPopoverView, TrayRoute }
