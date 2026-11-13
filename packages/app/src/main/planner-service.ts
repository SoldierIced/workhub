import { randomUUID } from 'node:crypto'
import {
  alertInboxProposal,
  applyInboxAction,
  applyMilestoneProposal,
  bulkEditInbox,
  cleanupInbox,
  countByCategory,
  countsKey,
  DEFAULT_AGENT_MILESTONE_MODE,
  DEFAULT_INBOX_ISSUE_TYPE,
  DEFAULT_MILESTONE_MARGIN,
  findDuplicate,
  followsTicket,
  inboxDueBy,
  inboxSettings,
  INBOX_LIMITS,
  linkTicket,
  localDay,
  markTicketDone,
  MAX_MILESTONE_PROPOSALS,
  MAX_SEARCH_RESULTS,
  MILESTONE_LIMITS,
  moveMilestone,
  moveMilestonePreview,
  type MoveMilestoneSummary,
  type PlanTrackers,
  milestoneStatus,
  moduleScreens,
  moveInboxItem,
  newInboxItem,
  pieceTally,
  pieceViews,
  plannerSettings,
  priorityOf,
  renderInboxDescription,
  sortMilestones,
  ticketStateKey,
  trackedState,
  withTicket,
  type InboxAction,
  type InboxBulkPatch,
  type InboxItem,
  type InboxProposal,
  type InboxSource,
  type InboxTicket,
  type MetricAlert,
  type Milestone,
  type MilestoneCounts,
  type MilestoneProposal,
  type PlanEditor,
  type PlanLink,
  type Profile,
  type TicketSummary,
  type TicketTracker,
  type TrackedTicket
} from '@workhub/core'
import type { InboxAddResult, InboxEdit, MilestoneView, PlannerResult, PlannerView } from '../shared/planner-api'

/** Tracker milestones are counted, and the tickets of pieces and linked items read, again this often (and on demand). */
export const MILESTONE_REFRESH_MS = 30 * 60_000
const FIRST_DELAY_MS = 20_000

/** One profile's milestones, their last counts and its inbox (`planner-state.json`). */
export interface PlannerProfileState {
  milestones: Milestone[]
  /** Last good count per milestone id. */
  counts: Record<string, MilestoneCounts>
  /** Why the last count of a milestone failed, by id. */
  errors: Record<string, string>
  inbox: InboxItem[]
  /** Milestone changes agents asked for, waiting for the user (`agentMilestones: 'ask'`). */
  proposals: MilestoneProposal[]
  /**
   * What the tracker last said about the tickets of milestone pieces and of inbox items that follow
   * one, by `ticketStateKey` (connection id, empty for the profile's tracker, and key). Files from
   * before pieces have none.
   */
  tickets: Record<string, TrackedTicket>
}

export interface PlannerState {
  profiles: Record<string, PlannerProfileState>
}

const EMPTY_PROFILE: PlannerProfileState = { milestones: [], counts: {}, errors: {}, inbox: [], proposals: [], tickets: {} }

export type TrackerLookup = (profileId: string, connectionId?: string) => Promise<{ tracker: TicketTracker } | { error: string }>

export interface PlannerServiceDeps {
  profiles: () => Promise<Profile[]>
  store: { load(fallback: PlannerState): PlannerState; save(value: PlannerState): void; flush?(): void }
  tracker: TrackerLookup
  changed: (profileId: string) => void
  now?: () => number
  newId?: () => string
  intervalMs?: number
  firstDelayMs?: number
}

export const PLANNER_ERRORS = {
  moduleOff: 'Plan is off in this profile',
  unknown: 'The item no longer exists',
  notAllowed: 'This item does not offer that action',
  noProject: 'Set the project for new issues in Settings → Plan → Inbox',
  noCreate: 'This tracker cannot create issues',
  noSearch: 'This tracker cannot search',
  tooMany: 'Too many milestones',
  unknownMilestone: 'The milestone does not exist',
  sameProfile: 'The milestone is already in that profile',
  unknownProposal: 'The proposal no longer exists',
  tooLong: `The note would make the detail longer than ${INBOX_LIMITS.detail} characters`,
  noLink: 'Only a local task or bug can be linked to a ticket',
  noRead: 'This tracker cannot read tickets by key'
} as const

/** What an agent may change on an item (`PATCH /v1/inbox/:id`): local moves and fields, never a tracker issue. */
export interface InboxUpdate {
  status?: 'pending' | 'local' | 'done' | 'discarded'
  /** Null clears it. */
  due?: string | null
  area?: string | null
  criticality?: string | null
  /** Appended to the detail as a new paragraph. */
  note?: string
  /** Replaces the item's links; null or empty clears them. */
  links?: PlanLink[] | null
  /** Links a local task or bug to an existing ticket by key; null unlinks it. Never creates a ticket. */
  ticket?: { key: string; connectionId?: string } | null
}

export type InboxUpdateResult = { ok: true; item: InboxItem } | { ok: false; error: string; reason: 'moduleOff' | 'unknown' | 'notAllowed' | 'tooLong' }

/** The inbox items milestone pieces point at: kept past the inbox's retention so the milestones' progress holds. */
function pieceItemIds(milestones: readonly Milestone[]): Set<string> {
  const ids = new Set<string>()
  for (const m of milestones) if (m.source.kind === 'items') for (const p of m.source.items) if (p.kind === 'task') ids.add(p.itemId)
  return ids
}

/** The connection (empty for the profile's tracker) whose tracker holds an item's ticket. */
const itemTicketConnection = (ticket: InboxTicket, inboxConnection: string) => ticket.connectionId ?? inboxConnection

/** The tickets to read, by connection (empty for the profile's tracker): those of milestone pieces and of the items that follow one. */
function ticketRefs(p: Pick<PlannerProfileState, 'milestones' | 'inbox'>, inboxConnection: string): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>()
  const add = (connection: string, key: string) => {
    const keys = refs.get(connection) ?? new Set<string>()
    keys.add(key)
    refs.set(connection, keys)
  }
  for (const m of p.milestones) if (m.source.kind === 'items') for (const piece of m.source.items) if (piece.kind === 'ticket') add(piece.connectionId ?? '', piece.key)
  for (const item of p.inbox) if (followsTicket(item)) add(itemTicketConnection(item.ticket!, inboxConnection), item.ticket!.key)
  return refs
}

const planner = (p: Profile) => moduleScreens(p.modules).includes('planner')

/** The item with its links replaced; an empty list or null drops them. */
function withLinks(item: InboxItem, links: readonly PlanLink[] | null): InboxItem {
  const { links: _old, ...rest } = item
  return links && links.length > 0 ? { ...rest, links: [...links] } : rest
}

/** Whatever is stored, as a well-formed state (an older or hand-edited file keeps what it can). */
function cleanState(raw: PlannerState, now: number): PlannerState {
  const profiles: Record<string, PlannerProfileState> = {}
  for (const [id, p] of Object.entries(raw.profiles ?? {})) {
    if (!p || typeof p !== 'object') continue
    profiles[id] = {
      milestones: Array.isArray(p.milestones) ? p.milestones : [],
      counts: p.counts && typeof p.counts === 'object' ? p.counts : {},
      errors: p.errors && typeof p.errors === 'object' ? p.errors : {},
      inbox: Array.isArray(p.inbox) ? cleanupInbox(p.inbox, now, pieceItemIds(Array.isArray(p.milestones) ? p.milestones : [])) : [],
      proposals: Array.isArray(p.proposals) ? p.proposals : [],
      tickets: p.tickets && typeof p.tickets === 'object' && !Array.isArray(p.tickets) ? p.tickets : {}
    }
  }
  return { profiles }
}

/**
 * Plan's milestones and inbox for every profile: keeps them in a state file, counts tracker
 * milestones and reads the tickets of pieces and linked items every 30 minutes (an item whose
 * ticket is done is marked done), and turns approved inbox items into tracker issues. Everything
 * that changes state runs one at a time, so a double click never creates two issues.
 */
export class PlannerService {
  private state: PlannerState
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private first: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly deps: PlannerServiceDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    this.state = cleanState(deps.store.load({ profiles: {} }), this.now())
  }

  start(): void {
    if (this.timer || this.first) return
    this.first = setTimeout(() => {
      this.first = null
      void this.tick()
      this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? MILESTONE_REFRESH_MS)
      this.timer.unref?.()
    }, this.deps.firstDelayMs ?? FIRST_DELAY_MS)
    this.first.unref?.()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
    this.first = null
    this.timer = null
    this.deps.store.flush?.()
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async profile(profileId: string): Promise<Profile | undefined> {
    return (await this.deps.profiles()).find((p) => p.id === profileId)
  }

  private of(profileId: string): PlannerProfileState {
    return this.state.profiles[profileId] ?? EMPTY_PROFILE
  }

  private put(profileId: string, next: Partial<PlannerProfileState>): void {
    const current = this.of(profileId)
    this.state.profiles[profileId] = { ...current, ...next, inbox: cleanupInbox(next.inbox ?? current.inbox, this.now(), pieceItemIds(next.milestones ?? current.milestones)) }
    this.deps.store.save(this.state)
    this.deps.changed(profileId)
  }

  /** Counts the tracker milestones, and reads the tickets, of every profile with Plan on whose count is due. */
  tick(): Promise<void> {
    return this.serial(async () => {
      try {
        for (const p of (await this.deps.profiles()).filter(planner)) {
          await this.count(p.id, false)
          await this.readTickets(p, false)
        }
      } catch {
        // The next tick tries again.
      }
    })
  }

  /** The profile's open tasks due today or overdue, overdue first (the menu bar popover); empty while Plan is off. */
  async dueToday(profileId: string): Promise<InboxItem[]> {
    const profile = await this.profile(profileId)
    if (!profile || !planner(profile)) return []
    return inboxDueBy(this.of(profileId).inbox, localDay(this.now()))
  }

  async view(profileId: string): Promise<PlannerView> {
    const profile = await this.profile(profileId)
    const today = localDay(this.now())
    const enabled = profile !== undefined && planner(profile)
    if (!profile || !enabled) return { enabled: false, milestones: [], inbox: [], itemTickets: {}, proposals: [], agentMilestones: DEFAULT_AGENT_MILESTONE_MODE, tracker: { search: false, create: false }, today }
    const settings = plannerSettings(profile)
    const margin = settings.milestoneMargin ?? DEFAULT_MILESTONE_MARGIN
    const inboxConnection = inboxSettings(settings).trackerConnectionId
    const p = this.of(profileId)
    const items = new Map(p.inbox.map((i) => [i.id, i]))
    const rows: MilestoneView[] = p.milestones.map((m) => {
      if (m.source.kind === 'items') {
        const pieces = pieceViews(m.source.items, { ticket: (connectionId, key) => p.tickets[ticketStateKey(connectionId, key)], task: (id) => items.get(id) })
        return { milestone: m, ...milestoneStatus(m, pieceTally(pieces), today, margin), pieces }
      }
      const key = countsKey(m)
      const counts = key !== null && p.counts[m.id]?.key === key ? p.counts[m.id] : undefined
      const error = key !== null ? p.errors[m.id] : undefined
      return { milestone: m, ...milestoneStatus(m, counts, today, margin), ...(counts ? { counts } : {}), ...(error ? { error } : {}) }
    })
    const itemTickets: Record<string, TrackedTicket> = {}
    for (const i of p.inbox) {
      const known = i.ticket && p.tickets[ticketStateKey(itemTicketConnection(i.ticket, inboxConnection), i.ticket.key)]
      if (known) itemTickets[i.id] = known
    }
    const found = await this.deps.tracker(profileId, inboxConnection || undefined)
    const tracker = 'error' in found ? { search: false, create: false, error: found.error } : { search: Boolean(found.tracker.capabilities.search && found.tracker.searchByQuery), create: Boolean(found.tracker.capabilities.create && found.tracker.createIssue) }
    return { enabled, milestones: sortMilestones(rows), inbox: p.inbox, itemTickets, proposals: p.proposals, agentMilestones: settings.agentMilestones ?? DEFAULT_AGENT_MILESTONE_MODE, tracker, today }
  }

  /** A ticket by key as its tracker answers it now (the milestone editor shows its title); null when the tracker does not know it. */
  async lookupTicket(profileId: string, key: string, connectionId?: string): Promise<{ ok: true; ticket: TicketSummary | null } | { ok: false; error: string }> {
    const profile = await this.profile(profileId)
    if (!profile || !planner(profile)) return { ok: false, error: PLANNER_ERRORS.moduleOff }
    const found = await this.deps.tracker(profileId, connectionId || undefined)
    if ('error' in found) return { ok: false, error: found.error }
    if (!found.tracker.readTickets) return { ok: false, error: PLANNER_ERRORS.noRead }
    try {
      const read = await found.tracker.readTickets([key])
      return { ok: true, ticket: read.find((t) => t.key.toUpperCase() === key.toUpperCase()) ?? null }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Milestones

  saveMilestone(profileId: string, milestone: Milestone): Promise<PlannerResult> {
    return this.serial(async () => {
      const profile = await this.profile(profileId)
      if (!profile || !planner(profile)) return { ok: false, error: PLANNER_ERRORS.moduleOff }
      const p = this.of(profileId)
      const current = p.milestones.find((m) => m.id === milestone.id)
      if (!current && p.milestones.length >= MILESTONE_LIMITS.items) return { ok: false, error: PLANNER_ERRORS.tooMany }
      const saved = this.stamp({ ...milestone, createdAt: current?.createdAt ?? this.now() }, 'user')
      this.put(profileId, { milestones: current ? p.milestones.map((m) => (m.id === milestone.id ? saved : m)) : [...p.milestones, saved] })
      if (milestone.source.kind === 'tracker') await this.count(profileId, false, milestone.id)
      if (milestone.source.kind === 'items') await this.readTickets(profile, false)
      return { ok: true }
    })
  }

  deleteMilestone(profileId: string, id: string): Promise<PlannerResult> {
    return this.serial(async () => {
      const p = this.of(profileId)
      if (!p.milestones.some((m) => m.id === id)) return { ok: true }
      await this.setMilestones(profileId, p.milestones.filter((m) => m.id !== id))
      return { ok: true }
    })
  }

  /** The trackers a profile reads tickets from when a piece or an item names none. */
  private trackersOf(profile: Profile): PlanTrackers {
    return { tracker: profile.connections.tracker, inbox: inboxSettings(plannerSettings(profile)).trackerConnectionId }
  }

  /** What moving a milestone to another profile would carry and change (see `moveMilestone` in core). */
  async moveMilestonePreview(fromId: string, id: string, toId: string): Promise<MoveMilestoneSummary | null> {
    const [from, to] = await Promise.all([this.profile(fromId), this.profile(toId)])
    if (!from || !to || fromId === toId) return null
    return moveMilestonePreview({ from: this.of(fromId), to: this.of(toId), id, fromTrackers: this.trackersOf(from), toTrackers: this.trackersOf(to) })
  }

  /**
   * Moves a milestone to another profile's Plan with its items, counts and proposals; tickets read
   * from the first profile's tracker keep reading from it. Its new id may differ (`id`).
   */
  moveMilestone(fromId: string, id: string, toId: string): Promise<({ ok: true; id: string } & MoveMilestoneSummary) | { ok: false; error: string }> {
    return this.serial(async () => {
      if (fromId === toId) return { ok: false, error: PLANNER_ERRORS.sameProfile }
      const [from, to] = await Promise.all([this.profile(fromId), this.profile(toId)])
      if (!from || !planner(from) || !to || !planner(to)) return { ok: false, error: PLANNER_ERRORS.moduleOff }
      if (this.of(toId).milestones.length >= MILESTONE_LIMITS.items) return { ok: false, error: PLANNER_ERRORS.tooMany }
      const r = moveMilestone({ from: this.of(fromId), to: this.of(toId), id, fromTrackers: this.trackersOf(from), toTrackers: this.trackersOf(to), newId: this.newId })
      if (!r.ok) return { ok: false, error: PLANNER_ERRORS.unknownMilestone }
      const milestone = this.stamp(r.milestone, 'user')
      this.put(fromId, r.from)
      this.put(toId, { ...r.to, milestones: r.to.milestones.map((m) => (m.id === milestone.id ? milestone : m)) })
      if (milestone.source.kind === 'tracker') await this.count(toId, false, milestone.id)
      if (milestone.source.kind === 'items') await this.readTickets(to, false)
      return { ok: true, id: milestone.id, moved: r.moved, copied: r.copied, pinned: r.pinned }
    })
  }

  /** Stores a new milestone list, drops the counts of the ones gone, and counts `countId` when it is a tracker one. */
  private async setMilestones(profileId: string, milestones: Milestone[], countId?: string): Promise<void> {
    const p = this.of(profileId)
    const kept = new Set(milestones.map((m) => m.id))
    const counts = Object.fromEntries(Object.entries(p.counts).filter(([id]) => kept.has(id)))
    const errors = Object.fromEntries(Object.entries(p.errors).filter(([id]) => kept.has(id)))
    this.put(profileId, { milestones, counts, errors })
    const kind = countId ? milestones.find((m) => m.id === countId)?.source.kind : undefined
    if (kind === 'tracker') await this.count(profileId, false, countId)
    if (kind === 'items') {
      const profile = await this.profile(profileId)
      if (profile) await this.readTickets(profile, false)
    }
  }

  /**
   * A milestone change asked by an agent (control endpoint). With `agentMilestones: 'allow'` it is
   * applied now; otherwise it waits as a proposal for the user. `change.milestone` is the milestone
   * as it would be saved (create and update), already checked.
   */
  agentMilestone(
    profileId: string,
    change: { action: MilestoneProposal['action']; milestoneId: string; milestone?: Milestone },
    source: MilestoneProposal['source']
  ): Promise<{ ok: true; applied: true; milestone?: Milestone } | { ok: true; applied: false; proposal: MilestoneProposal } | { ok: false; error: string; reason: 'moduleOff' | 'unknown' | 'conflict' }> {
    return this.serial(async () => {
      const profile = await this.profile(profileId)
      if (!profile || !planner(profile)) return { ok: false, error: PLANNER_ERRORS.moduleOff, reason: 'moduleOff' }
      const p = this.of(profileId)
      const before = p.milestones.find((m) => m.id === change.milestoneId)
      if (change.action !== 'create' && !before) return { ok: false, error: PLANNER_ERRORS.unknownMilestone, reason: 'unknown' }
      // Marked as the agent's change, whether applied now or later by the user.
      const milestone = change.milestone ? this.stamp({ ...change.milestone, createdAt: before?.createdAt ?? this.now() }, 'agent') : undefined
      const proposal: MilestoneProposal = {
        id: this.newId(),
        action: change.action,
        milestoneId: change.milestoneId,
        ...(milestone ? { milestone } : {}),
        ...(before ? { before } : {}),
        source,
        createdAt: this.now()
      }
      if ((plannerSettings(profile).agentMilestones ?? DEFAULT_AGENT_MILESTONE_MODE) === 'allow') {
        const next = applyMilestoneProposal(p.milestones, proposal)
        if (typeof next === 'string') return { ok: false, error: next, reason: 'conflict' }
        await this.setMilestones(profileId, next, change.action === 'delete' ? undefined : change.milestoneId)
        return { ok: true, applied: true, ...(milestone ? { milestone } : {}) }
      }
      this.put(profileId, { proposals: [...p.proposals, proposal].slice(-MAX_MILESTONE_PROPOSALS) })
      return { ok: true, applied: false, proposal }
    })
  }

  /** The user applies (`accept`) or rejects an agent's milestone proposal; either way it leaves the list. */
  resolveProposal(profileId: string, proposalId: string, accept: boolean): Promise<PlannerResult> {
    return this.serial(async () => {
      const p = this.of(profileId)
      const proposal = p.proposals.find((x) => x.id === proposalId)
      if (!proposal) return { ok: false, error: PLANNER_ERRORS.unknownProposal }
      const proposals = p.proposals.filter((x) => x.id !== proposalId)
      if (!accept) {
        this.put(profileId, { proposals })
        return { ok: true }
      }
      const next = applyMilestoneProposal(p.milestones, proposal)
      if (typeof next === 'string') return { ok: false, error: `Cannot apply: ${next}` }
      this.put(profileId, { proposals })
      await this.setMilestones(profileId, next, proposal.action === 'delete' ? undefined : proposal.milestoneId)
      return { ok: true }
    })
  }

  refreshMilestones(profileId: string): Promise<PlannerView> {
    return this.serial(async () => {
      const profile = await this.profile(profileId)
      if (profile && planner(profile)) {
        await this.count(profileId, true)
        await this.readTickets(profile, true)
      }
      return this.view(profileId)
    })
  }

  /** Counts the profile's tracker milestones (only `onlyId` when given) whose count is missing, stale, for another query, or `force`d. */
  private async count(profileId: string, force: boolean, onlyId?: string): Promise<void> {
    const p = this.of(profileId)
    const now = this.now()
    const due = p.milestones.filter((m) => {
      const key = countsKey(m)
      if (key === null || (onlyId && m.id !== onlyId)) return false
      const last = p.counts[m.id]
      return force || !last || last.key !== key || now - last.at >= MILESTONE_REFRESH_MS || p.errors[m.id] !== undefined
    })
    if (due.length === 0) return
    const counts = { ...p.counts }
    const errors = { ...p.errors }
    for (const m of due) {
      if (m.source.kind !== 'tracker') continue
      const found = await this.deps.tracker(profileId, m.source.connectionId)
      try {
        if ('error' in found) throw new Error(found.error)
        if (!found.tracker.searchByQuery || !found.tracker.capabilities.search) throw new Error(PLANNER_ERRORS.noSearch)
        const tickets = await found.tracker.searchByQuery(m.source.query, { limit: MAX_SEARCH_RESULTS })
        counts[m.id] = { ...countByCategory(tickets), at: this.now(), key: countsKey(m) ?? '' }
        delete errors[m.id]
      } catch (error) {
        errors[m.id] = error instanceof Error ? error.message : String(error)
      }
    }
    // The list may have changed while counting (a delete waits in the queue, so only stale ids are dropped).
    const ids = new Set(this.of(profileId).milestones.map((m) => m.id))
    const keep = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([id]) => ids.has(id)))
    this.put(profileId, { counts: keep(counts), errors: keep(errors) })
  }

  /**
   * Reads the tickets of the profile's milestone pieces and of the inbox items that follow one: one
   * request per connection with every key due (missing, older than the refresh, failed last time,
   * or all when `force`d). A tracker that cannot read by key leaves the state unknown. An item whose
   * ticket turned done since the last read is marked done (once: an item reopened by hand stays open).
   * States no piece or item points at any more are dropped.
   */
  private async readTickets(profile: Profile, force: boolean): Promise<void> {
    if (!planner(profile)) return
    const profileId = profile.id
    const inboxConnection = inboxSettings(plannerSettings(profile)).trackerConnectionId
    const before = this.of(profileId).tickets
    const refs = ticketRefs(this.of(profileId), inboxConnection)
    const tickets: Record<string, TrackedTicket> = {}
    for (const [connection, keys] of refs) for (const key of keys) {
      const k = ticketStateKey(connection, key)
      if (before[k]) tickets[k] = before[k]
    }
    let touched = Object.keys(tickets).length !== Object.keys(before).length
    const now = this.now()
    for (const [connection, keys] of refs) {
      const due = [...keys].filter((key) => {
        const t = tickets[ticketStateKey(connection, key)]
        return force || !t || t.error !== undefined || now - t.checkedAt >= MILESTONE_REFRESH_MS
      })
      if (due.length === 0) continue
      touched = true
      const found = await this.deps.tracker(profileId, connection || undefined)
      try {
        if ('error' in found) throw new Error(found.error)
        if (!found.tracker.readTickets) {
          for (const key of due) tickets[ticketStateKey(connection, key)] = { key, checkedAt: this.now(), unsupported: true }
          continue
        }
        const read = new Map((await found.tracker.readTickets(due)).map((t) => [t.key.toUpperCase(), t]))
        const at = this.now()
        for (const key of due) {
          const k = ticketStateKey(connection, key)
          const t = read.get(key)
          tickets[k] = t ? { key, title: t.title, status: t.status, category: t.category, ...(t.url ? { url: t.url } : {}), checkedAt: at } : { key, ...(tickets[k]?.title ? { title: tickets[k]!.title } : {}), checkedAt: at, missing: true }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        for (const key of due) {
          const k = ticketStateKey(connection, key)
          tickets[k] = { ...(tickets[k] ?? { key }), checkedAt: tickets[k]?.checkedAt ?? this.now(), error: message }
        }
      }
    }
    if (!touched) return
    let closed = false
    const inbox = this.of(profileId).inbox.map((item) => {
      if (!followsTicket(item)) return item
      const k = ticketStateKey(itemTicketConnection(item.ticket!, inboxConnection), item.ticket!.key)
      if (trackedState(tickets[k]) !== 'done' || trackedState(before[k]) === 'done') return item
      const done = markTicketDone(item, this.now())
      if (!done) return item
      closed = true
      return this.stamp(done, 'tracker')
    })
    this.put(profileId, { tickets, ...(closed ? { inbox } : {}) })
  }

  // Inbox

  /** Adds pending items; an item with the same title as an open one (or from the same alert) is skipped unless `force`d. */
  private async add(profileId: string, proposals: readonly InboxProposal[], source: InboxSource, force: boolean): Promise<{ added: InboxItem[]; duplicates: InboxItem[] } | { error: string }> {
    const profile = await this.profile(profileId)
    if (!profile || !planner(profile)) return { error: PLANNER_ERRORS.moduleOff }
    const people = plannerSettings(profile).people
    let inbox = [...this.of(profileId).inbox]
    const added: InboxItem[] = []
    const duplicates: InboxItem[] = []
    for (const proposal of proposals) {
      const twin = force ? undefined : findDuplicate(inbox, { title: proposal.title, source })
      if (twin) {
        duplicates.push(twin)
        continue
      }
      const item = newInboxItem(proposal, source, this.newId(), this.now(), people)
      inbox = [...inbox, item]
      added.push(item)
    }
    if (added.length > 0) this.put(profileId, { inbox })
    return { added, duplicates }
  }

  addItem(profileId: string, proposal: InboxProposal, force = false): Promise<InboxAddResult> {
    return this.serial(async () => {
      const r = await this.add(profileId, [proposal], { type: 'manual' }, force)
      if ('error' in r) return { ok: false, error: r.error }
      const item = r.added[0]
      return item ? { ok: true, item } : { ok: false, error: 'An open item has the same title', duplicateOf: r.duplicates[0]?.id }
    })
  }

  /** Items an agent or automation proposes (the control endpoint). */
  propose(profileId: string, proposals: readonly InboxProposal[], source: InboxSource): Promise<{ added: string[]; duplicates: string[] } | { error: string }> {
    return this.serial(async () => {
      const r = await this.add(profileId, proposals.slice(0, INBOX_LIMITS.perRequest), source, false)
      return 'error' in r ? r : { added: r.added.map((i) => i.id), duplicates: r.duplicates.map((i) => i.id) }
    })
  }

  /** "Send to inbox" on a metric alert: a pending bug with its context, once per open alert. */
  fromAlert(profileId: string, alert: MetricAlert): Promise<InboxAddResult> {
    return this.serial(async () => {
      const { proposal, source } = alertInboxProposal(alert)
      const r = await this.add(profileId, [proposal], source, false)
      if ('error' in r) return { ok: false, error: r.error }
      const item = r.added[0] ?? r.duplicates[0]
      return item ? { ok: true, item } : { ok: false, error: PLANNER_ERRORS.unknown }
    })
  }

  /** The user's edit of one item (the Plan screen or an item's window). */
  editItem(profileId: string, id: string, edit: InboxEdit): Promise<PlannerResult> {
    return this.serial(async () => {
      const p = this.of(profileId)
      const item = p.inbox.find((i) => i.id === id)
      if (!item) return { ok: false, error: PLANNER_ERRORS.unknown }
      let next: InboxItem = { ...item, ...(edit.title !== undefined ? { title: edit.title } : {}), ...(edit.detail !== undefined ? { detail: edit.detail } : {}), ...(edit.kind ? { kind: edit.kind } : {}) }
      if (edit.people !== undefined) {
        if (edit.people.length > 0) next.people = edit.people
        else delete next.people
      }
      if (edit.links !== undefined) next = withLinks(next, edit.links)
      const { due, area, criticality } = edit
      next = bulkEditInbox([next], [id], { ...(due !== undefined ? { due } : {}), ...(area !== undefined ? { area } : {}), ...(criticality !== undefined ? { criticality } : {}) })[0]!
      this.put(profileId, { inbox: p.inbox.map((i) => (i.id === id ? this.stamp(next, 'user') : i)) })
      return { ok: true }
    })
  }

  bulkEdit(profileId: string, ids: readonly string[], patch: InboxBulkPatch): Promise<PlannerResult> {
    return this.serial(async () => {
      const selected = new Set(ids)
      this.put(profileId, { inbox: bulkEditInbox(this.of(profileId).inbox, ids, patch).map((i) => (selected.has(i.id) ? this.stamp(i, 'user') : i)) })
      return { ok: true }
    })
  }

  act(profileId: string, id: string, action: InboxAction): Promise<PlannerResult & { ticket?: { key: string; url?: string } }> {
    return this.serial(async () => {
      const item = this.of(profileId).inbox.find((i) => i.id === id)
      if (!item) return { ok: false, error: PLANNER_ERRORS.unknown }
      const now = this.now()
      const local = applyInboxAction(item, action, now)
      if (local) {
        this.replace(profileId, this.stamp(local, 'user'))
        return { ok: true }
      }
      if (action !== 'approve' || item.status !== 'pending' || item.kind === 'decision') return { ok: false, error: PLANNER_ERRORS.notAllowed }
      const profile = await this.profile(profileId)
      if (!profile || !planner(profile)) return { ok: false, error: PLANNER_ERRORS.moduleOff }
      const settings = inboxSettings(plannerSettings(profile))
      if (!settings.project.trim()) return { ok: false, error: PLANNER_ERRORS.noProject }
      const found = await this.deps.tracker(profileId, settings.trackerConnectionId || undefined)
      if ('error' in found) return { ok: false, error: found.error }
      if (!found.tracker.createIssue || !found.tracker.capabilities.create) return { ok: false, error: PLANNER_ERRORS.noCreate }
      try {
        const priority = priorityOf(item.criticality, settings.criticalities)
        const created = await found.tracker.createIssue({
          project: settings.project.trim(),
          issueType: settings.issueTypes[item.kind] || DEFAULT_INBOX_ISSUE_TYPE[item.kind],
          title: item.title,
          description: renderInboxDescription(settings.descriptionTemplate, item),
          ...(priority ? { priority } : {})
        })
        this.replace(profileId, this.stamp(withTicket(item, { ...created, ...(settings.trackerConnectionId ? { connectionId: settings.trackerConnectionId } : {}) }), 'user'))
        await this.readTickets(profile, false)
        return { ok: true, ticket: created }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  /** An agent's change to one item: a local status move and fields; it never creates a tracker issue. */
  updateItem(profileId: string, id: string, update: InboxUpdate): Promise<InboxUpdateResult> {
    return this.serial(async () => {
      const profile = await this.profile(profileId)
      if (!profile || !planner(profile)) return { ok: false, error: PLANNER_ERRORS.moduleOff, reason: 'moduleOff' }
      const item = this.of(profileId).inbox.find((i) => i.id === id)
      if (!item) return { ok: false, error: PLANNER_ERRORS.unknown, reason: 'unknown' }
      let next: InboxItem | null = update.status ? moveInboxItem(item, update.status, this.now()) : item
      if (!next) return { ok: false, error: `${PLANNER_ERRORS.notAllowed}: ${item.status} → ${update.status}`, reason: 'notAllowed' }
      const { note, status: _status, links, ticket, ...fields } = update
      if (Object.keys(fields).length > 0) next = bulkEditInbox([next], [id], fields)[0]!
      if (links !== undefined) next = withLinks(next, links)
      if (ticket !== undefined) {
        const linked = linkTicket(next, ticket)
        if (!linked) return { ok: false, error: PLANNER_ERRORS.noLink, reason: 'notAllowed' }
        next = linked
      }
      if (note) {
        const detail = next.detail ? `${next.detail}\n\n${note}` : note
        if (detail.length > INBOX_LIMITS.detail) return { ok: false, error: PLANNER_ERRORS.tooLong, reason: 'tooLong' }
        next = { ...next, detail }
      }
      if (next !== item) {
        next = this.stamp(next, 'agent')
        this.replace(profileId, next)
      }
      if (ticket) {
        // A linked ticket already done marks the item done at once.
        this.forgetTicket(profileId, ticket.key)
        await this.readTickets(profile, false)
        next = this.of(profileId).inbox.find((i) => i.id === id) ?? next
      }
      return { ok: true, item: next }
    })
  }

  /** The user links a local task or bug to an existing ticket by key, or unlinks it (null). */
  linkItemTicket(profileId: string, id: string, ticket: { key: string; connectionId?: string } | null): Promise<PlannerResult> {
    return this.serial(async () => {
      const profile = await this.profile(profileId)
      if (!profile || !planner(profile)) return { ok: false, error: PLANNER_ERRORS.moduleOff }
      const item = this.of(profileId).inbox.find((i) => i.id === id)
      if (!item) return { ok: false, error: PLANNER_ERRORS.unknown }
      const next = linkTicket(item, ticket)
      if (!next) return { ok: false, error: PLANNER_ERRORS.noLink }
      this.replace(profileId, this.stamp(next, 'user'))
      if (ticket) {
        this.forgetTicket(profileId, ticket.key)
        await this.readTickets(profile, false)
      }
      return { ok: true }
    })
  }

  /** Drops what is stored of a ticket just linked, so its next read counts as new: a ticket already done marks the item done. */
  private forgetTicket(profileId: string, key: string): void {
    const tickets = Object.fromEntries(Object.entries(this.of(profileId).tickets).filter(([k]) => !k.endsWith(`|${key}`)))
    this.put(profileId, { tickets })
  }

  /** The item or milestone marked as changed now by `by`. */
  private stamp<T extends { updatedAt?: number; updatedBy?: PlanEditor }>(value: T, by: PlanEditor): T {
    return { ...value, updatedAt: this.now(), updatedBy: by }
  }

  private replace(profileId: string, item: InboxItem): void {
    this.put(profileId, { inbox: this.of(profileId).inbox.map((i) => (i.id === item.id ? item : i)) })
  }
}
