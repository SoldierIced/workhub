// Types of the Plan work bridge (window.hub.planner): milestones and the inbox, shared by main, preload and renderer.
import type { AgentMilestoneMode, InboxAction, InboxBulkPatch, InboxItem, InboxKind, InboxProposal, Milestone, MilestoneCounts, MilestoneProposal, MilestoneStatusKind, MoveMilestoneSummary, PieceView, PlanLink, TicketSummary, TrackedTicket } from '@workhub/core'
import type { PlanItemTarget } from './plan-item-window'

export interface MilestoneView {
  milestone: Milestone
  status: MilestoneStatusKind
  /** 0 to 100. */
  progress: number
  /** Share of the period gone, 0 to 100. */
  elapsed: number
  /** The last good count of a tracker milestone. */
  counts?: MilestoneCounts
  /** Why the last count failed. */
  error?: string
  /** The pieces of a milestone made of pieces, in its order, with their state and share. */
  pieces?: PieceView[]
}

export interface PlannerView {
  /** The profile has the Plan module on. */
  enabled: boolean
  /** Sorted by status severity, then end date. */
  milestones: MilestoneView[]
  inbox: InboxItem[]
  /** What the tracker last said about the ticket of an inbox item, by item id (items without a ticket, or not read yet, are absent). */
  itemTickets: Record<string, TrackedTicket>
  /** Milestone changes agents asked for, oldest first, waiting for the user. */
  proposals: MilestoneProposal[]
  /** Whether agents' milestone changes wait for the user (`ask`) or apply at once (`allow`). */
  agentMilestones: AgentMilestoneMode
  /** What the profile's tracker (the inbox's, else the profile's) can do; the UI hides the rest. */
  tracker: { search: boolean; create: boolean; error?: string }
  /** The local day the statuses were computed for (`YYYY-MM-DD`). */
  today: string
}

export type PlannerResult = { ok: true } | { ok: false; error: string }

/** An item added, or why not; `duplicateOf` names the open item with the same title. */
export type InboxAddResult = { ok: true; item: InboxItem } | { ok: false; error: string; duplicateOf?: string }

/** What a single item's edit may change; null (or an empty list) clears a field. */
export interface InboxEdit {
  title?: string
  detail?: string
  kind?: InboxKind
  people?: string[]
  due?: string | null
  area?: string | null
  criticality?: string | null
  links?: PlanLink[]
}

export interface PlannerApi {
  get(profileId: string): Promise<PlannerView>
  /** Adds or replaces a milestone (by id); a tracker milestone is counted again at once. */
  saveMilestone(profileId: string, milestone: Milestone): Promise<PlannerResult>
  deleteMilestone(profileId: string, id: string): Promise<PlannerResult>
  /** What moving a milestone to another profile would carry: items moved, items copied, tickets pinned to the first tracker. */
  moveMilestonePreview(fromProfileId: string, id: string, toProfileId: string): Promise<MoveMilestoneSummary | null>
  /** Moves a milestone, with its items, counts and proposals, to another profile's Plan; `id` is its id there. */
  moveMilestone(fromProfileId: string, id: string, toProfileId: string): Promise<({ ok: true; id: string } & MoveMilestoneSummary) | { ok: false; error: string }>
  /** Applies (`accept`) or rejects an agent's milestone proposal. */
  resolveProposal(profileId: string, proposalId: string, accept: boolean): Promise<PlannerResult>
  /** Counts the tracker milestones, and reads the tickets of pieces and linked items, again now. */
  refreshMilestones(profileId: string): Promise<PlannerView>
  /** A ticket by key as the tracker answers it now (null when it does not know the key); the milestone editor shows its title. */
  lookupTicket(profileId: string, key: string, connectionId?: string): Promise<{ ok: true; ticket: TicketSummary | null } | { ok: false; error: string }>
  /** Links a local task or bug to an existing ticket by key, or unlinks it (null). Never creates a ticket. */
  linkTicket(profileId: string, id: string, ticket: { key: string; connectionId?: string } | null): Promise<PlannerResult>
  /** A pending item added by hand; `force` adds it even when an open item has the same title. */
  addItem(profileId: string, proposal: InboxProposal, force?: boolean): Promise<InboxAddResult>
  editItem(profileId: string, id: string, edit: InboxEdit): Promise<PlannerResult>
  /** Approve (creates the tracker issue of a task or bug; records a decision), keep, discard, done or reopen. */
  act(profileId: string, id: string, action: InboxAction): Promise<PlannerResult & { ticket?: { key: string; url?: string } }>
  /** "Send to inbox" on a metric alert: a pending bug with its context (never a ticket without approval). */
  fromAlert(profileId: string, alertKey: string): Promise<InboxAddResult>
  /** Sets area, criticality or due date on several items. */
  bulkEdit(profileId: string, ids: string[], patch: InboxBulkPatch): Promise<PlannerResult>
  /** Opens an inbox item or a milestone (or a new milestone's form) in a window of its own, or focuses the one already open. */
  openWindow(target: PlanItemTarget): void
  /** In an item's window: the user asked to edit the item again while the window was open (the pencil on the Milestones tab). */
  onEditRequest(cb: () => void): () => void
  /** A profile's milestones or inbox changed (a refresh, an action in another window, an agent's proposal). */
  onChanged(cb: (profileId: string) => void): () => void
}
