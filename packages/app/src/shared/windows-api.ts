// Session windows and the native application menu (window.hub.windows, window.hub.menu).
import type { SessionMonitorSnapshot } from '@workhub/core'

/** A command of the native application menu, run by the window it is sent to. */
export type MenuCommand =
  /** A new session; `agentKey` preselects the agent (an `EffectiveAgent.key`). */
  | { kind: 'newSession'; agentKey?: string }
  /** One of the main navigation screens (the ⌘1-⌘8 items, Sessions, Settings). */
  | { kind: 'navigate'; route: string }
  /** Closes the session of the window: the session window's, else the main window's selection. */
  | { kind: 'closeSession' }
  /** Opens the main window's selected session in a window of its own. */
  | { kind: 'openInWindow' }
  /** Shows the session as the app, its console or a shell. */
  | { kind: 'showMode'; mode: 'app' | 'console' | 'shell' }

/**
 * What the main window's renderer holds about a session and main does not: the chat items and the
 * monitor. A session window starts from it, then follows the session's live events.
 */
export interface SessionSnapshot {
  items: unknown[]
  monitor: SessionMonitorSnapshot
}

export interface WindowsApi {
  /** Shows a session in a window of its own; one already in its window comes to the front. */
  openSession(sessionId: string): void
  /** A sub-agent's conversation in a window of its own. */
  openSubagent(sessionId: string, subagentId: string): void
  /** Puts a session back in the main window and selects it there; its own window closes. */
  dock(sessionId: string): void
  /** Ids of the sessions shown in windows of their own now. */
  detached(): Promise<string[]>
  onDetached(cb: (ids: string[]) => void): () => void
  /** The main window is asked to show (select) a session. */
  onShowSession(cb: (sessionId: string) => void): () => void
  /** The session whose own window is focused (null: none), so the main window counts it as seen. */
  onFocusedSession(cb: (sessionId: string | null) => void): () => void
  /** A session window asks for the chat the main window holds; null when it has none. */
  snapshot(sessionId: string): Promise<SessionSnapshot | null>
  /** Main window only: a session window wants a snapshot; answer with `replySnapshot`. */
  onSnapshotRequest(cb: (requestId: string, sessionId: string) => void): () => void
  replySnapshot(requestId: string, snapshot: SessionSnapshot | null): void
}

export interface MenuApi {
  onCommand(cb: (command: MenuCommand) => void): () => void
}
