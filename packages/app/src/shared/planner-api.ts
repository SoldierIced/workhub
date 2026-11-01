// Types of the Plan work bridge (window.hub.planner): milestones and the inbox, shared by main, preload and renderer.
import type { InboxAction, InboxBulkPatch, InboxItem, InboxKind, InboxProposal, Milestone, MilestoneCounts, MilestoneStatusKind } from '@workhub/core'

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
}

export interface PlannerView {
  /** The profile has the Plan module on. */
  enabled: boolean
  /** Sorted by status severity, then end date. */
  milestones: MilestoneView[]
  inbox: InboxItem[]
  /** What the profile's tracker (the inbox's, else the profile's) can do; the UI hides the rest. */
  tracker: { search: boolean; create: boolean; error?: string }
  /** The local day the statuses were computed for (`YYYY-MM-DD`). */
  today: string
}

export type PlannerResult = { ok: true } | { ok: false; error: string }

/** An item added, or why not; `duplicateOf` names the open item with the same title. */
export type InboxAddResult = { ok: true; item: InboxItem } | { ok: false; error: string; duplicateOf?: string }

/** What a single item's edit may change. */
export interface InboxEdit {
  title?: string
  detail?: string
  kind?: InboxKind
  people?: string[]
}

export interface PlannerApi {
  get(profileId: string): Promise<PlannerView>
  /** Adds or replaces a milestone (by id); a tracker milestone is counted again at once. */
  saveMilestone(profileId: string, milestone: Milestone): Promise<PlannerResult>
  deleteMilestone(profileId: string, id: string): Promise<PlannerResult>
  /** Counts the tracker milestones again now. */
  refreshMilestones(profileId: string): Promise<PlannerView>
  /** A pending item added by hand; `force` adds it even when an open item has the same title. */
  addItem(profileId: string, proposal: InboxProposal, force?: boolean): Promise<InboxAddResult>
  editItem(profileId: string, id: string, edit: InboxEdit): Promise<PlannerResult>
  /** Approve (creates the tracker issue of a task or bug; records a decision), keep, discard, done or reopen. */
  act(profileId: string, id: string, action: InboxAction): Promise<PlannerResult & { ticket?: { key: string; url?: string } }>
  /** "Send to inbox" on a metric alert: a pending bug with its context (never a ticket without approval). */
  fromAlert(profileId: string, alertKey: string): Promise<InboxAddResult>
  /** Sets area, criticality or due date on several items. */
  bulkEdit(profileId: string, ids: string[], patch: InboxBulkPatch): Promise<PlannerResult>
  /** A profile's milestones or inbox changed (a refresh, an action in another window, an agent's proposal). */
  onChanged(cb: (profileId: string) => void): () => void
}
