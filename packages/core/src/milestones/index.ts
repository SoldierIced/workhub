/**
 * Plan milestones: a named period of work whose progress is typed by hand, counted from a tracker
 * query, or weighed from its pieces (tickets, local tasks, links). Pure: the main process fetches
 * the counts and the tickets' states and stores the list (`planner-state.json`).
 */
import { daysBetween, isDay } from '../alerts/days'
import { parsePlanLinks, planLinksOk, type PlanEditor, type PlanLink } from '../inbox/links'
import { parsePieces, piecesOk, type MilestonePiece } from './pieces'

export * from './pieces'
export * from './membership'
export * from './move'

export type MilestoneSource = { kind: 'manual'; progress: number } | { kind: 'tracker'; connectionId?: string; query: string } | { kind: 'items'; items: MilestonePiece[] }

export interface Milestone {
  id: string
  name: string
  /** `YYYY-MM-DD`, both inclusive. */
  start: string
  end: string
  source: MilestoneSource
  /** Markdown. */
  notes?: string
  link?: string
  /** More labelled links; at most `PLAN_LINK_LIMITS.items`. */
  links?: PlanLink[]
  /** Epoch ms of its creation and of its last change, and who made that change (set by the Plan service). */
  createdAt?: number
  updatedAt?: number
  updatedBy?: PlanEditor
}

/** What a tracker query counted for a milestone, and when. */
export interface MilestoneCounts {
  total: number
  todo: number
  inProgress: number
  done: number
  /** Epoch ms of the count. */
  at: number
  /** The last refresh failed (the counts are those of the last good one). */
  error?: string
  /** `countsKey` of the milestone when it was counted: a changed query ignores old counts. */
  key?: string
}

export const MILESTONE_STATUSES = ['late', 'atRisk', 'onTrack', 'notStarted', 'done'] as const
/** In order of severity, worst first. */
export type MilestoneStatusKind = (typeof MILESTONE_STATUSES)[number]

export interface MilestoneProgress {
  status: MilestoneStatusKind
  /** Work done, 0 to 100. */
  progress: number
  /** Share of the period gone, 0 to 100. */
  elapsed: number
}

export const DEFAULT_MILESTONE_MARGIN = 10
export const MILESTONE_MARGIN_RANGE = [0, 100] as const
export const MILESTONE_LIMITS = { name: 200, notes: 5000, link: 2000, query: 2000, items: 200 } as const

const clamp100 = (n: number) => Math.min(100, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)))

/**
 * Where a milestone stands on `today`:
 * - done: all its work is done (manual 100 %, every ticket of the query done, or every piece done);
 * - notStarted: before its start;
 * - late: past its end and not done;
 * - atRisk: progress behind the share of time gone by more than `margin` points, or a counted
 *   milestone that started with nothing to count (a query that finds no ticket, no pieces);
 * - onTrack: otherwise.
 * `counts` is the query's count of a tracker milestone (not counted yet: 0 % done), or the weights
 * of a pieces milestone (`pieceTally`: `total` all weights, `done` those of the done pieces).
 * A counted milestone shows 100 % only when it is done.
 */
export function milestoneStatus(m: Pick<Milestone, 'start' | 'end' | 'source'>, counts: Pick<MilestoneCounts, 'total' | 'done'> | undefined, today: string, margin = DEFAULT_MILESTONE_MARGIN): MilestoneProgress {
  const manual = m.source.kind === 'manual' ? clamp100(m.source.progress) : null
  const counted = manual === null
  const done = manual !== null ? manual >= 100 : Boolean(counts && counts.total > 0 && counts.done >= counts.total)
  const progress = manual ?? (done ? 100 : counts && counts.total > 0 ? Math.min(99, clamp100((counts.done / counts.total) * 100)) : 0)
  const span = daysBetween(m.start, m.end)
  const gone = daysBetween(m.start, today)
  const elapsed = gone < 0 ? 0 : span <= 0 ? 100 : clamp100((gone / span) * 100)
  let status: MilestoneStatusKind
  if (done) status = 'done'
  else if (gone < 0) status = 'notStarted'
  else if (daysBetween(m.end, today) > 0) status = 'late'
  else if ((counted && counts !== undefined && counts.total === 0) || elapsed - progress > margin) status = 'atRisk'
  else status = 'onTrack'
  return { status, progress, elapsed }
}

/** Worst status first, then the nearest end, then the name. */
export function sortMilestones<T extends { milestone: Pick<Milestone, 'end' | 'name'>; status: MilestoneStatusKind }>(items: readonly T[]): T[] {
  const rank = (s: MilestoneStatusKind) => MILESTONE_STATUSES.indexOf(s)
  return [...items].sort((a, b) => rank(a.status) - rank(b.status) || a.milestone.end.localeCompare(b.milestone.end) || a.milestone.name.localeCompare(b.milestone.name))
}

/** What is wrong with a milestone as typed; empty when it can be saved. */
export function milestoneProblems(m: Milestone): string[] {
  const problems: string[] = []
  if (!m.id.trim() || m.id.length > 64) problems.push('id')
  if (!m.name.trim() || m.name.length > MILESTONE_LIMITS.name) problems.push('name')
  if (!isDay(m.start)) problems.push('start')
  if (!isDay(m.end)) problems.push('end')
  if (isDay(m.start) && isDay(m.end) && daysBetween(m.start, m.end) < 0) problems.push('order')
  if (m.source.kind === 'manual') {
    if (!Number.isFinite(m.source.progress) || m.source.progress < 0 || m.source.progress > 100) problems.push('progress')
  } else if (m.source.kind === 'items') {
    if (!piecesOk(m.source.items)) problems.push('pieces')
  } else if (!m.source.query.trim() || m.source.query.length > MILESTONE_LIMITS.query) problems.push('query')
  if (m.notes !== undefined && m.notes.length > MILESTONE_LIMITS.notes) problems.push('notes')
  if (m.link !== undefined && m.link !== '' && (!/^https?:\/\//i.test(m.link) || m.link.length > MILESTONE_LIMITS.link)) problems.push('link')
  if (m.links !== undefined && !planLinksOk(m.links)) problems.push('links')
  return problems
}

/** A milestone from untrusted input (IPC), trimmed; null when it is not one. */
export function parseMilestone(value: unknown): Milestone | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const src = v['source'] as Record<string, unknown> | undefined
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
  let source: MilestoneSource
  if (src?.['kind'] === 'manual' && typeof src['progress'] === 'number') source = { kind: 'manual', progress: Math.round(src['progress']) }
  else if (src?.['kind'] === 'tracker' && typeof src['query'] === 'string') source = { kind: 'tracker', query: src['query'].trim(), ...(str(src['connectionId']) ? { connectionId: str(src['connectionId']) } : {}) }
  else if (src?.['kind'] === 'items') {
    const items = parsePieces(src['items'])
    if (typeof items === 'string') return null
    source = { kind: 'items', items }
  } else return null
  const links = v['links'] === undefined || v['links'] === null ? [] : parsePlanLinks(v['links'])
  if (typeof links === 'string') return null
  // The dates and who changed it are the Plan service's to set, never taken from the caller.
  const m: Milestone = { id: str(v['id']), name: str(v['name']), start: str(v['start']), end: str(v['end']), source, ...(str(v['notes']) ? { notes: str(v['notes']) } : {}), ...(str(v['link']) ? { link: str(v['link']) } : {}), ...(links.length > 0 ? { links } : {}) }
  return milestoneProblems(m).length === 0 ? m : null
}

/** The query a counted milestone was counted for, so a changed query drops old counts. */
export function countsKey(m: Pick<Milestone, 'source'>): string | null {
  return m.source.kind === 'tracker' ? `${m.source.connectionId ?? ''}|${m.source.query}` : null
}

/**
 * What happens when an agent creates, changes or deletes a milestone through the control endpoint:
 * `ask` (default) keeps the change as a proposal until the user applies it on the Plan screen;
 * `allow` applies it at once.
 */
export const AGENT_MILESTONE_MODES = ['ask', 'allow'] as const
export type AgentMilestoneMode = (typeof AGENT_MILESTONE_MODES)[number]
export const DEFAULT_AGENT_MILESTONE_MODE: AgentMilestoneMode = 'ask'

/** Proposals kept per profile; the oldest go first past this. */
export const MAX_MILESTONE_PROPOSALS = 50

/** A milestone change an agent asked for, waiting for the user. */
export interface MilestoneProposal {
  id: string
  action: 'create' | 'update' | 'delete'
  milestoneId: string
  /** The milestone as it would be saved (create and update). */
  milestone?: Milestone
  /** The milestone when the change was asked (update and delete), to show what changes. */
  before?: Milestone
  /** The session that asked (`$WORKHUB_SESSION`) and a short label of why. */
  source: { session?: string; label?: string }
  /** Epoch ms. */
  createdAt: number
}

/**
 * Fields an agent may change on a milestone; a progress applies to a manual one, a query to a
 * tracker one. `items` replaces the pieces, and turns any milestone into one made of pieces.
 */
export interface MilestonePatch {
  name?: string
  start?: string
  end?: string
  progress?: number
  query?: string
  items?: MilestonePiece[]
  notes?: string | null
  link?: string | null
  /** Replaces the list; null or empty clears it. */
  links?: PlanLink[] | null
}

/** The milestone with a patch applied; a string says why it cannot be (the result is checked as a whole). */
export function patchMilestone(m: Milestone, patch: MilestonePatch): Milestone | string {
  const kindName = { manual: 'typed by hand', tracker: 'counted from a tracker query', items: 'made of pieces' }[m.source.kind]
  if (patch.items !== undefined && (patch.progress !== undefined || patch.query !== undefined)) return '"items" cannot go with "progress" or "query"'
  if (patch.progress !== undefined && m.source.kind !== 'manual') return `"progress" applies to a milestone typed by hand; this one is ${kindName}`
  if (patch.query !== undefined && m.source.kind !== 'tracker') return `"query" applies to a milestone counted from a tracker; this one is ${kindName}`
  const source: MilestoneSource =
    patch.items !== undefined
      ? { kind: 'items', items: patch.items }
      : m.source.kind === 'manual'
        ? { kind: 'manual', progress: patch.progress !== undefined ? Math.round(patch.progress) : m.source.progress }
        : m.source.kind === 'tracker'
          ? { ...m.source, ...(patch.query !== undefined ? { query: patch.query.trim() } : {}) }
          : m.source
  const { notes: _n, link: _l, links: _ls, ...rest } = m
  const notes = patch.notes === undefined ? m.notes : patch.notes?.trim() || undefined
  const link = patch.link === undefined ? m.link : patch.link?.trim() || undefined
  const links = patch.links === undefined ? m.links : patch.links ?? undefined
  const next: Milestone = {
    ...rest,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.start !== undefined ? { start: patch.start.trim() } : {}),
    ...(patch.end !== undefined ? { end: patch.end.trim() } : {}),
    source,
    ...(notes ? { notes } : {}),
    ...(link ? { link } : {}),
    ...(links && links.length > 0 ? { links } : {})
  }
  const problems = milestoneProblems(next)
  return problems.length === 0 ? next : `not a valid milestone: ${problems.join(', ')}`
}

/** The list with a proposal applied; a string says why it no longer applies (the milestone changed or went). */
export function applyMilestoneProposal(milestones: readonly Milestone[], p: MilestoneProposal): Milestone[] | string {
  const current = milestones.find((m) => m.id === p.milestoneId)
  if (p.action === 'create') {
    if (!p.milestone) return 'the proposal has no milestone'
    if (current) return 'a milestone with that id already exists'
    if (milestones.length >= MILESTONE_LIMITS.items) return 'too many milestones'
    return [...milestones, p.milestone]
  }
  if (!current) return 'the milestone no longer exists'
  // Applying over a milestone the user edited since would silently undo their edit.
  if (p.before && JSON.stringify(current) !== JSON.stringify(p.before)) return 'the milestone changed since the agent asked'
  if (p.action === 'delete') return milestones.filter((m) => m.id !== p.milestoneId)
  if (!p.milestone) return 'the proposal has no milestone'
  return milestones.map((m) => (m.id === p.milestoneId ? p.milestone! : m))
}
