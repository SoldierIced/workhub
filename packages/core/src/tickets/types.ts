/** Tickets, as every tracker (Jira, Linear, GitHub Issues) reports them. */

/** Where a ticket stands, independent of the tracker's own status names. */
export type StatusCategory = 'todo' | 'inProgress' | 'done'

export type SprintState = 'active' | 'future' | 'closed'

/** A sprint (Jira) or cycle (Linear). Trackers without them leave `Ticket.sprint` unset. */
export interface TicketSprint {
  id: string
  name: string
  state: SprintState
  /** ISO date, used to order future sprints. */
  startDate?: string
}

export interface Ticket {
  /** `ABC-123` (Jira, Linear) or `owner/repo#123` (GitHub Issues). */
  key: string
  /** Provider id of the tracker, e.g. `jira`. */
  provider: string
  title: string
  /** The tracker's own status name, e.g. `In Review`. */
  status: string
  category: StatusCategory
  /** The open sprint of the ticket (active, else the earliest future one); unset in the backlog. */
  sprint?: TicketSprint
  assignee?: string
  type?: string
  priority?: string
  /** Browser URL. */
  url?: string
  /** Pull/merge request URLs the description and comments list (Workhub 1's ticket to PR link). */
  pullRequestUrls?: string[]
}

export interface TicketComment {
  id: string
  author: string
  /** Epoch milliseconds. */
  createdAt?: number
  /** Plain text: rich text is flattened by the adapter. */
  body: string
}

export interface TicketRef {
  key: string
  title: string
  status: string
  category: StatusCategory
}

export interface TicketDetail extends Ticket {
  description?: string
  reporter?: string
  labels: string[]
  createdAt?: number
  updatedAt?: number
  comments: TicketComment[]
  parent?: TicketRef
  children: TicketRef[]
}

/** A status change the tracker allows right now. */
export interface TicketTransition {
  id: string
  name: string
  /** The status it moves the ticket to. */
  status: string
  category: StatusCategory
}

/** What a tracker can do; the UI hides the rest. */
export interface TrackerCapabilities {
  sprints: boolean
  transitions: boolean
  comments: boolean
  assign: boolean
}

export type ConnectionTest = { ok: true; account: string } | { ok: false; error: string }

export interface ListTicketsOptions {
  /** Status names to leave out (Jira: the "statuses to hide" setting of Workhub 1). */
  ignoredStatuses?: string[]
}

/** The session facts that link it to a ticket. Every field is optional: agents give different data. */
export interface SessionRef {
  id: string
  title?: string
  cwd?: string
  gitBranch?: string
  summary?: string
  /** Keys the session monitor already found in the transcript. */
  ticketKeys?: string[]
}

/** The pull request facts that link it to a ticket (a code host fills them in P3). */
export interface PullRequestRef {
  url: string
  title?: string
  branch?: string
}
