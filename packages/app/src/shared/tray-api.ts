import type { NotificationKind, TrayRoute, TraySession } from '@workhub/core'

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
}

export type { NotificationKind, TrayRoute }
