import type {
  ConnectionTest,
  ListTicketsOptions,
  Ticket,
  TicketDetail,
  TicketTransition,
  TrackerCapabilities
} from './types'

/** Tickets of one tracker account (P4: Jira, Linear). Adapters implement it over the tracker's HTTP API. */
export interface TicketTracker {
  /** Provider id from the provider catalog, e.g. `jira`. */
  readonly provider: string
  readonly capabilities: TrackerCapabilities
  /** Whether a string is a ticket key of this tracker, e.g. `ABC-123`. */
  isTicketKey(text: string): boolean
  /** Checks the credentials and returns who they belong to. Never throws. */
  testConnection(): Promise<ConnectionTest>
  /** Open tickets assigned to the signed-in user, most recently updated first. */
  listAssigned(options?: ListTicketsOptions): Promise<Ticket[]>
  /** Everything the ticket window shows; null when the tracker does not know the key. */
  getTicket(key: string): Promise<TicketDetail | null>
  /** The status changes allowed right now. Empty when `capabilities.transitions` is off. */
  transitions(key: string): Promise<TicketTransition[]>
  transition(key: string, transitionId: string): Promise<void>
  /** Blank lines start paragraphs. */
  addComment(key: string, text: string): Promise<void>
  assignToMe(key: string): Promise<void>
}

/** A tracker call that failed in a way the user can read (bad credentials, network, 404). */
export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'TrackerError'
  }
}
