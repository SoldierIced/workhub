import { randomUUID } from 'node:crypto'
import {
  alertInboxProposal,
  applyInboxAction,
  bulkEditInbox,
  cleanupInbox,
  countByCategory,
  countsKey,
  DEFAULT_INBOX_ISSUE_TYPE,
  DEFAULT_MILESTONE_MARGIN,
  findDuplicate,
  inboxSettings,
  INBOX_LIMITS,
  localDay,
  MAX_SEARCH_RESULTS,
  MILESTONE_LIMITS,
  milestoneStatus,
  moduleScreens,
  moveInboxItem,
  newInboxItem,
  plannerSettings,
  priorityOf,
  renderInboxDescription,
  sortMilestones,
  withTicket,
  type InboxAction,
  type InboxBulkPatch,
  type InboxItem,
  type InboxProposal,
  type InboxSource,
  type MetricAlert,
  type Milestone,
  type MilestoneCounts,
  type Profile,
  type TicketTracker
} from '@workhub/core'
import type { InboxAddResult, InboxEdit, MilestoneView, PlannerResult, PlannerView } from '../shared/planner-api'

/** Tracker milestones are counted again this often (and on demand). */
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
}

export interface PlannerState {
  profiles: Record<string, PlannerProfileState>
}

const EMPTY_PROFILE: PlannerProfileState = { milestones: [], counts: {}, errors: {}, inbox: [] }

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
  tooLong: `The note would make the detail longer than ${INBOX_LIMITS.detail} characters`
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
}

export type InboxUpdateResult = { ok: true; item: InboxItem } | { ok: false; error: string; reason: 'moduleOff' | 'unknown' | 'notAllowed' | 'tooLong' }

const planner = (p: Profile) => moduleScreens(p.modules).includes('planner')

/** Whatever is stored, as a well-formed state (an older or hand-edited file keeps what it can). */
function cleanState(raw: PlannerState, now: number): PlannerState {
  const profiles: Record<string, PlannerProfileState> = {}
  for (const [id, p] of Object.entries(raw.profiles ?? {})) {
    if (!p || typeof p !== 'object') continue
    profiles[id] = {
      milestones: Array.isArray(p.milestones) ? p.milestones : [],
      counts: p.counts && typeof p.counts === 'object' ? p.counts : {},
      errors: p.errors && typeof p.errors === 'object' ? p.errors : {},
      inbox: Array.isArray(p.inbox) ? cleanupInbox(p.inbox, now) : []
    }
  }
  return { profiles }
}

/**
 * Plan's milestones and inbox for every profile: keeps them in a state file, counts tracker
 * milestones every 30 minutes, and turns approved inbox items into tracker issues. Everything that
 * changes state runs one at a time, so a double click never creates two issues.
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
    this.state.profiles[profileId] = { ...current, ...next, inbox: cleanupInbox(next.inbox ?? current.inbox, this.now()) }
    this.deps.store.save(this.state)
    this.deps.changed(profileId)
  }

  /** Counts the tracker milestones of every profile with Plan on whose count is due. */
  tick(): Promise<void> {
    return this.serial(async () => {
      try {
        for (const p of (await this.deps.profiles()).filter(planner)) await this.count(p.id, false)
      } catch {
        // The next tick tries again.
      }
    })
  }

  async view(profileId: string): Promise<PlannerView> {
    const profile = await this.profile(profileId)
    const today = localDay(this.now())
    const enabled = profile !== undefined && planner(profile)
    if (!profile || !enabled) return { enabled: false, milestones: [], inbox: [], tracker: { search: false, create: false }, today }
    const settings = plannerSettings(profile)
    const margin = settings.milestoneMargin ?? DEFAULT_MILESTONE_MARGIN
    const p = this.of(profileId)
    const rows: MilestoneView[] = p.milestones.map((m) => {
      const key = countsKey(m)
      const counts = key !== null && p.counts[m.id]?.key === key ? p.counts[m.id] : undefined
      const error = key !== null ? p.errors[m.id] : undefined
      return { milestone: m, ...milestoneStatus(m, counts, today, margin), ...(counts ? { counts } : {}), ...(error ? { error } : {}) }
    })
    const found = await this.deps.tracker(profileId, inboxSettings(settings).trackerConnectionId || undefined)
    const tracker = 'error' in found ? { search: false, create: false, error: found.error } : { search: Boolean(found.tracker.capabilities.search && found.tracker.searchByQuery), create: Boolean(found.tracker.capabilities.create && found.tracker.createIssue) }
    return { enabled, milestones: sortMilestones(rows), inbox: p.inbox, tracker, today }
  }

  // Milestones

  saveMilestone(profileId: string, milestone: Milestone): Promise<PlannerResult> {
    return this.serial(async () => {
      const profile = await this.profile(profileId)
      if (!profile || !planner(profile)) return { ok: false, error: PLANNER_ERRORS.moduleOff }
      const p = this.of(profileId)
      const exists = p.milestones.some((m) => m.id === milestone.id)
      if (!exists && p.milestones.length >= MILESTONE_LIMITS.items) return { ok: false, error: PLANNER_ERRORS.tooMany }
      this.put(profileId, { milestones: exists ? p.milestones.map((m) => (m.id === milestone.id ? milestone : m)) : [...p.milestones, milestone] })
      if (milestone.source.kind === 'tracker') await this.count(profileId, false, milestone.id)
      return { ok: true }
    })
  }

  deleteMilestone(profileId: string, id: string): Promise<PlannerResult> {
    return this.serial(async () => {
      const p = this.of(profileId)
      if (!p.milestones.some((m) => m.id === id)) return { ok: true }
      const { [id]: _c, ...counts } = p.counts
      const { [id]: _e, ...errors } = p.errors
      this.put(profileId, { milestones: p.milestones.filter((m) => m.id !== id), counts, errors })
      return { ok: true }
    })
  }

  refreshMilestones(profileId: string): Promise<PlannerView> {
    return this.serial(async () => {
      const profile = await this.profile(profileId)
      if (profile && planner(profile)) await this.count(profileId, true)
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

  // Inbox

  /** Adds pending items; an item with the same title (or source) as an open one is skipped unless `force`d. */
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

  editItem(profileId: string, id: string, edit: InboxEdit): Promise<PlannerResult> {
    return this.serial(async () => {
      const p = this.of(profileId)
      const item = p.inbox.find((i) => i.id === id)
      if (!item) return { ok: false, error: PLANNER_ERRORS.unknown }
      const next: InboxItem = { ...item, ...(edit.title !== undefined ? { title: edit.title } : {}), ...(edit.detail !== undefined ? { detail: edit.detail } : {}), ...(edit.kind ? { kind: edit.kind } : {}) }
      if (edit.people !== undefined) {
        if (edit.people.length > 0) next.people = edit.people
        else delete next.people
      }
      this.put(profileId, { inbox: p.inbox.map((i) => (i.id === id ? next : i)) })
      return { ok: true }
    })
  }

  bulkEdit(profileId: string, ids: readonly string[], patch: InboxBulkPatch): Promise<PlannerResult> {
    return this.serial(async () => {
      this.put(profileId, { inbox: bulkEditInbox(this.of(profileId).inbox, ids, patch) })
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
        this.replace(profileId, local)
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
        this.replace(profileId, withTicket(item, created, this.now()))
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
      const { note, status: _status, ...fields } = update
      if (Object.keys(fields).length > 0) next = bulkEditInbox([next], [id], fields)[0]!
      if (note) {
        const detail = next.detail ? `${next.detail}\n\n${note}` : note
        if (detail.length > INBOX_LIMITS.detail) return { ok: false, error: PLANNER_ERRORS.tooLong, reason: 'tooLong' }
        next = { ...next, detail }
      }
      if (next !== item) this.replace(profileId, next)
      return { ok: true, item: next }
    })
  }

  private replace(profileId: string, item: InboxItem): void {
    this.put(profileId, { inbox: this.of(profileId).inbox.map((i) => (i.id === item.id ? item : i)) })
  }
}
