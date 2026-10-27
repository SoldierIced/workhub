// Types of the tickets bridge (window.hub.tickets), shared by main, preload and renderer.
import type { Connection, ConnectionTest, SecretChange, Ticket, TicketDetail, TicketTransition } from '@workhub/core'

/**
 * - ready: a configured tracker serves the profile.
 * - demo: synthetic tickets (WORKHUB_DEMO_TICKETS=1), no credentials needed.
 * - noConnection: the profile has no tracker connection.
 * - incomplete: the connection lacks its site, email or token.
 * - unsupported: the provider has no adapter yet (GitHub Issues).
 */
export type TicketsState = 'ready' | 'demo' | 'noConnection' | 'incomplete' | 'unsupported'

export interface TicketsStatus {
  state: TicketsState
  provider?: string
  connectionName?: string
  /** Project keys of the connection (`ABC` for `ABC-123`); empty when none are set. */
  projectKeys: string[]
}

export type TicketsResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface TicketsApi {
  status(profileId: string | null): Promise<TicketsStatus>
  list(profileId: string): Promise<TicketsResult<Ticket[]>>
  get(profileId: string, key: string): Promise<TicketsResult<TicketDetail | null>>
  transitions(profileId: string, key: string): Promise<TicketsResult<TicketTransition[]>>
  transition(profileId: string, key: string, transitionId: string): Promise<TicketsResult<null>>
  comment(profileId: string, key: string, text: string): Promise<TicketsResult<null>>
  assignToMe(profileId: string, key: string): Promise<TicketsResult<null>>
  /** Checks a connection as typed in the form, before it is saved. */
  test(connection: Connection, secret: SecretChange): Promise<ConnectionTest>
  /** Opens (or focuses) the window of a ticket. */
  openWindow(profileId: string, key: string): Promise<void>
  /** Opens an http(s) URL in the default browser. */
  openExternal(url: string): Promise<void>
  /** Brings the main window forward on a session. */
  openSession(sessionId: string): void
  /** Fires in every window when a ticket was changed from any of them. */
  onChanged(cb: () => void): () => void
  /** Fires in the main window when a ticket window asks to show a session. */
  onOpenSession(cb: (sessionId: string) => void): () => void
}
