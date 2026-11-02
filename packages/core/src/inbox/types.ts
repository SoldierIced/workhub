/**
 * Plan's inbox: things to act on that come from the user, a metric alert, an agent or a meeting.
 * A pending item waits for approval: approved, a task or bug becomes a tracker issue and a decision
 * is recorded; or it is kept as a local task, or discarded. Nothing becomes a ticket without approval.
 */
import type { IssuePriority } from '../tickets/types'

export const INBOX_KINDS = ['task', 'bug', 'decision'] as const
export type InboxKind = (typeof INBOX_KINDS)[number]

export const INBOX_STATUSES = ['pending', 'ticket', 'local', 'discarded', 'done'] as const
/**
 * - pending: waiting for approval;
 * - ticket: approved and created in the tracker (`ticket` says where);
 * - local: kept in Workhub (a local task, or an approved decision);
 * - discarded, done: closed; pruned a week after `closedAt`.
 */
export type InboxStatus = (typeof INBOX_STATUSES)[number]

export const INBOX_SOURCE_TYPES = ['manual', 'alert', 'agent', 'meeting'] as const
export type InboxSourceType = (typeof INBOX_SOURCE_TYPES)[number]

export interface InboxSource {
  type: InboxSourceType
  /** What it came from: an alert key, a session id, an event id. */
  ref?: string
  /** A readable name of the source, e.g. the alert's metric or the automation's name. */
  label?: string
}

export interface InboxItem {
  id: string
  kind: InboxKind
  title: string
  detail: string
  source: InboxSource
  /** One of the profile's areas (Settings → Plan → Inbox). */
  area?: string
  /** The name of one of the profile's criticality levels. */
  criticality?: string
  /** `YYYY-MM-DD`. */
  due?: string
  /** Person ids (Plan → People). */
  people?: string[]
  /** A web link with more context (the alert's dashboard). */
  link?: string
  status: InboxStatus
  ticket?: { key: string; url?: string }
  /** Epoch ms. */
  createdAt: number
  closedAt?: number
}

/** A criticality level of a profile and the tracker priority it maps to. */
export interface CriticalityLevel {
  name: string
  priority: IssuePriority
}

/** A profile's inbox setup (`profiles[].planner.inbox`). */
export interface InboxSettings {
  /** The areas items can be filed under (free text, e.g. Backend, Mobile, Support). */
  areas: string[]
  criticalities: CriticalityLevel[]
  /** The tracker connection approvals create issues in; empty uses the profile's tracker. */
  trackerConnectionId: string
  /** Jira project key or Linear team key. */
  project: string
  /** The issue type of each kind that becomes a ticket; empty uses the tracker's default (`Task`, `Bug`). Decisions never become tickets. */
  issueTypes: { task: string; bug: string }
  /** The issue description; empty uses `DEFAULT_INBOX_DESCRIPTION_TEMPLATE`. */
  descriptionTemplate: string
}

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  areas: [],
  criticalities: [],
  trackerConnectionId: '',
  project: '',
  issueTypes: { task: '', bug: '' },
  descriptionTemplate: ''
}

export const DEFAULT_INBOX_ISSUE_TYPE: Record<'task' | 'bug', string> = { task: 'Task', bug: 'Bug' }

export const INBOX_TEMPLATE_PLACEHOLDERS = ['title', 'detail', 'source', 'link'] as const

export const DEFAULT_INBOX_DESCRIPTION_TEMPLATE = '{detail}\n\nSource: {source}\n{link}'

export const INBOX_LIMITS = {
  title: 300,
  detail: 5000,
  people: 20,
  /** Items one request to the control endpoint may propose. */
  perRequest: 20,
  /** Open items the duplicate check compares against (most recent first). */
  dedupeWindow: 500,
  /** Items kept per profile; the oldest closed ones go first. */
  items: 2000,
  areas: 50,
  criticalities: 10,
  label: 120
} as const

/** Closed items are pruned this long after they closed. */
export const INBOX_RETENTION_MS = 7 * 86_400_000

export type InboxAction = 'approve' | 'keep' | 'discard' | 'done' | 'reopen'
export const INBOX_ACTIONS: readonly InboxAction[] = ['approve', 'keep', 'discard', 'done', 'reopen']

/** Fields a bulk edit sets on every selected item; null clears a field, undefined leaves it. */
export interface InboxBulkPatch {
  area?: string | null
  criticality?: string | null
  due?: string | null
}

/** What a producer (the user, an alert, an agent) proposes; the inbox adds id, status and dates. */
export interface InboxProposal {
  kind: InboxKind
  title: string
  detail: string
  people?: string[]
  due?: string
  area?: string
  criticality?: string
  link?: string
}
