/**
 * Plan over the control endpoint: what an agent in a Workhub session may read and change of its
 * profile's plan. Today's and tomorrow's meetings, the inbox (read, and local moves of an item),
 * the milestones and the people. Approving an item to the tracker is never offered here: it stays a
 * human action in the UI. Every answer is short and capped; no secret (calendar addresses, notes)
 * leaves through it.
 */
import { INBOX_KINDS, INBOX_LIMITS, INBOX_STATUSES, MILESTONE_LIMITS, PIECE_LIMITS, PIECE_WEIGHT, filterInbox, isDay, isOpenItem, milestoneProblems, moduleScreens, parsePieces, parsePlanLinks, parseTicketKey, patchMilestone, plannerSettings, trackedState, type InboxItem, type Milestone, type MilestonePatch, type MilestoneProposal, type PieceView, type Profile, type TrackedTicket } from '@workhub/core'
import { randomUUID } from 'node:crypto'
import type { PlanView } from '../shared/plan-api'
import type { ControlReply } from './control-server'
import type { InboxUpdate, PlannerService } from './planner-service'

/** Items `GET /v1/inbox` returns by default and at most. */
export const CONTROL_INBOX_LIMIT = { default: 50, max: 200 } as const
/** Characters of an item's detail and an event's description in a list answer. */
export const CONTROL_TEXT_CAP = { detail: 1000, description: 500 } as const
/** At most this many events and attendees per event in `GET /v1/plan/today`. */
export const CONTROL_EVENT_CAP = { events: 100, attendees: 50 } as const
/** The longest note `PATCH /v1/inbox/:id` appends to an item's detail. */
export const CONTROL_NOTE_MAX = 2000

const DAY_MS = 86_400_000
const SESSION_ID = /^[\w-]{1,100}$/

export interface ControlProfileDeps {
  /** The profile a session runs in (undefined when there is no such session). */
  sessionProfile: (sessionId: string) => string | null | undefined
  /** Whether a profile exists, and the active one. */
  profiles: () => Promise<{ ids: string[]; active: string | null }>
}

export type ControlProfile = { ok: true; profileId: string; session: string | null } | { ok: false; status: number; error: string }

/**
 * The profile a control request acts on: the one of `session` (an agent passes `$WORKHUB_SESSION`),
 * else `profile` (a profile id), else the active one.
 */
export async function resolveControlProfile(deps: ControlProfileDeps, ask: { session?: unknown; profile?: unknown }): Promise<ControlProfile> {
  const { ids, active } = await deps.profiles()
  let profileId: string | null = null
  const session = typeof ask.session === 'string' && SESSION_ID.test(ask.session) ? ask.session : null
  if (session) {
    const owner = deps.sessionProfile(session)
    if (owner === undefined) return { ok: false, status: 404, error: 'unknown session' }
    profileId = owner
  }
  if (!profileId && typeof ask.profile === 'string' && ask.profile) {
    if (!ids.includes(ask.profile)) return { ok: false, status: 404, error: 'unknown profile' }
    profileId = ask.profile
  }
  profileId ??= active
  if (!profileId) return { ok: false, status: 409, error: 'no profile' }
  return { ok: true, profileId, session }
}

const fail = (status: number, error: string): ControlReply => ({ status, body: { ok: false, error } })
const iso = (ms: number) => new Date(ms).toISOString()
const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const STATE_REASON: Record<PlanView['state'], string | undefined> = {
  ready: undefined,
  demo: undefined,
  moduleOff: 'Plan is off in this profile',
  noConnection: 'No calendar is set up for this profile (Settings → Plan → Calendars)',
  error: 'No calendar of this profile could be read'
}

/** Local midnight of the day of `now`. */
function startOfDay(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** The events of today and tomorrow (local days) for an agent, with their briefs. */
export function todayAnswer(view: PlanView, now: number): Record<string, unknown> {
  const from = startOfDay(now)
  const to = startOfDay(from + 2 * DAY_MS + DAY_MS / 2)
  const events = view.events.filter((e) => e.start < to && e.end > from)
  const reason = STATE_REASON[view.state]
  return {
    ok: true,
    state: view.state,
    ...(reason ? { reason } : {}),
    now: iso(now),
    calendars: view.calendars.map((c) => ({ name: c.name, ok: c.ok, ...(c.failure ? { failure: c.failure } : {}) })),
    events: events.slice(0, CONTROL_EVENT_CAP.events).map((e) => {
      const brief = view.briefs[e.id]
      return {
        id: e.id,
        title: e.title,
        start: iso(e.start),
        end: iso(e.end),
        allDay: e.allDay,
        ...(e.location ? { location: e.location } : {}),
        ...(e.meetingUrl ? { meetingUrl: e.meetingUrl } : {}),
        ...(e.organizer ? { organizer: { ...(e.organizer.name ? { name: e.organizer.name } : {}), email: e.organizer.email } } : {}),
        attendees: e.attendees.slice(0, CONTROL_EVENT_CAP.attendees).map((a) => ({ ...(a.name ? { name: a.name } : {}), email: a.email, ...(a.status ? { status: a.status } : {}) })),
        ...(e.attendees.length > CONTROL_EVENT_CAP.attendees ? { moreAttendees: e.attendees.length - CONTROL_EVENT_CAP.attendees } : {}),
        ...(e.description ? { description: cap(e.description, CONTROL_TEXT_CAP.description) } : {}),
        recurring: e.recurring,
        ...(brief ? { brief: { phase: brief.phase, ...(brief.sessionId ? { sessionId: brief.sessionId } : {}) } } : {})
      }
    }),
    ...(events.length > CONTROL_EVENT_CAP.events ? { truncated: true } : {})
  }
}

/** A ticket to link (`{ key, connectionId? }`, the key checked and upper-cased) or null to unlink; undefined when it is neither. */
export function parseTicketLink(value: unknown): { key: string; connectionId?: string } | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const key = parseTicketKey(v['key'])
  if (!key) return undefined
  const conn = v['connectionId']
  if (conn === undefined || conn === null || conn === '') return { key }
  return typeof conn === 'string' && conn.trim() && conn.length <= PIECE_LIMITS.connectionId ? { key, connectionId: conn.trim() } : undefined
}

/** A ticket's last known state as an agent sees it. */
function ticketStateAnswer(t: TrackedTicket | undefined): Record<string, unknown> {
  if (!t) return { state: 'unknown' }
  return {
    state: trackedState(t),
    ...(t.title ? { title: t.title } : {}),
    ...(t.status ? { status: t.status } : {}),
    ...(t.url ? { url: t.url } : {}),
    checkedAt: iso(t.checkedAt),
    ...(t.missing ? { missing: true } : {}),
    ...(t.unsupported ? { unsupported: true } : {}),
    ...(t.error ? { error: t.error } : {})
  }
}

/** One piece of a milestone as an agent sees it: what it points at, its state, weight and share (0-100). */
export function pieceAnswer(v: PieceView): Record<string, unknown> {
  const p = v.piece
  const what = p.kind === 'ticket' ? { key: p.key, ...(p.connectionId ? { connectionId: p.connectionId } : {}) } : p.kind === 'task' ? { itemId: p.itemId } : { url: p.url, label: p.label, done: p.done }
  return {
    kind: p.kind,
    ...what,
    title: v.title,
    state: v.state,
    ...(v.status ? { status: v.status } : {}),
    ...(v.url && p.kind !== 'link' ? { url: v.url } : {}),
    weight: p.weight,
    share: v.share,
    ...(v.checkedAt ? { checkedAt: iso(v.checkedAt) } : {}),
    ...(v.error ? { error: v.error } : {}),
    ...(v.missing ? { missing: true } : {})
  }
}

/** One inbox item as an agent sees it: people by name, dates as ISO, the detail capped, its ticket with its last known state. */
export function itemAnswer(item: InboxItem, people: readonly { id: string; name: string }[], detailCap: number = CONTROL_TEXT_CAP.detail, ticketState?: TrackedTicket): Record<string, unknown> {
  const names = (item.people ?? []).map((id) => people.find((p) => p.id === id)?.name ?? id)
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    detail: cap(item.detail, detailCap),
    ...(item.area ? { area: item.area } : {}),
    ...(item.criticality ? { criticality: item.criticality } : {}),
    ...(item.due ? { due: item.due } : {}),
    ...(names.length > 0 ? { people: names } : {}),
    ...(item.link ? { link: item.link } : {}),
    ...(item.links?.length ? { links: item.links } : {}),
    ...(item.ticket ? { ticket: { ...item.ticket, ...ticketStateAnswer(ticketState), ...(item.ticket.url ? { url: item.ticket.url } : {}) } } : {}),
    source: { type: item.source.type, ...(item.source.label ? { label: item.source.label } : {}) },
    createdAt: iso(item.createdAt),
    ...(item.closedAt ? { closedAt: iso(item.closedAt) } : {}),
    ...(item.updatedAt ? { updatedAt: iso(item.updatedAt), ...(item.updatedBy ? { updatedBy: item.updatedBy } : {}) } : {})
  }
}

export type InboxQuery = { status: InboxItem['status'] | 'open' | 'all'; kind?: InboxItem['kind']; area?: string; q?: string; limit: number }

/** The filters of `GET /v1/inbox`; a string says what is wrong. */
export function parseInboxQuery(params: URLSearchParams): InboxQuery | string {
  const status = params.get('status') || 'open'
  if (status !== 'open' && status !== 'all' && !(INBOX_STATUSES as readonly string[]).includes(status)) return `"status" must be open, all or one of ${INBOX_STATUSES.join(', ')}`
  const kind = params.get('kind') || undefined
  if (kind !== undefined && !(INBOX_KINDS as readonly string[]).includes(kind)) return '"kind" must be task, bug or decision'
  const area = params.get('area') || undefined
  if (area !== undefined && area.length > 200) return '"area" is too long'
  const q = params.get('q') || undefined
  if (q !== undefined && q.length > 200) return '"q" is too long'
  const rawLimit = params.get('limit')
  const limit = rawLimit === null || rawLimit === '' ? CONTROL_INBOX_LIMIT.default : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1) return '"limit" must be a positive whole number'
  return { status: status as InboxQuery['status'], ...(kind ? { kind: kind as InboxItem['kind'] } : {}), ...(area ? { area } : {}), ...(q ? { q } : {}), limit: Math.min(limit, CONTROL_INBOX_LIMIT.max) }
}

/** Newest first, open ones (pending, then local and in the tracker) before closed ones. */
function inboxOrder(a: InboxItem, b: InboxItem): number {
  const rank = (i: InboxItem) => (i.status === 'pending' ? 0 : i.status === 'local' || i.status === 'ticket' ? 1 : 2)
  return rank(a) - rank(b) || b.createdAt - a.createdAt
}

const UPDATE_STATUSES = ['pending', 'local', 'done', 'discarded'] as const

/** The body of `PATCH /v1/inbox/:id`; a string says what is wrong. */
export function parseInboxUpdate(body: unknown): InboxUpdate | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object'
  const v = body as Record<string, unknown>
  const out: InboxUpdate = {}
  if (v['status'] !== undefined) {
    if (!(UPDATE_STATUSES as readonly unknown[]).includes(v['status'])) return '"status" must be pending, local, done or discarded (approving to the tracker is done in Workhub)'
    out.status = v['status'] as InboxUpdate['status']
  }
  if (v['due'] !== undefined) {
    if (v['due'] === null || v['due'] === '') out.due = null
    else if (isDay(v['due'])) out.due = v['due']
    else return '"due" must be a date (YYYY-MM-DD) or null'
  }
  for (const key of ['area', 'criticality'] as const) {
    const x = v[key]
    if (x === undefined) continue
    if (x === null || (typeof x === 'string' && !x.trim())) out[key] = null
    else if (typeof x === 'string' && x.length <= 200) out[key] = x.trim()
    else return `"${key}" must be a short text or null`
  }
  if (v['note'] !== undefined) {
    if (typeof v['note'] !== 'string') return '"note" must be a string'
    const note = v['note'].trim()
    if (note.length > CONTROL_NOTE_MAX) return `"note" is longer than ${CONTROL_NOTE_MAX} characters`
    if (note) out.note = note
  }
  if (v['links'] !== undefined) {
    if (v['links'] === null) out.links = null
    else {
      const links = parsePlanLinks(v['links'])
      if (typeof links === 'string') return links
      out.links = links
    }
  }
  if (v['ticket'] !== undefined) {
    const ticket = parseTicketLink(v['ticket'])
    if (ticket === undefined) return '"ticket" must be { "key": "ABC-12" } (an existing ticket, linked to a local task or bug) or null to unlink; tickets are never created here'
    out.ticket = ticket
  }
  if (Object.keys(out).length === 0) return 'nothing to change: send status, due, area, criticality, note, links or ticket'
  return out
}

/** The body of `POST /v1/milestones` as a milestone (without its id); a string says what is wrong. */
export function parseMilestoneCreate(body: unknown): Omit<Milestone, 'id'> | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object'
  const v = body as Record<string, unknown>
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
  const hasProgress = v['progress'] !== undefined
  const hasQuery = v['query'] !== undefined
  const hasItems = v['items'] !== undefined
  if ([hasProgress, hasQuery, hasItems].filter(Boolean).length !== 1) return 'send one of "progress" (0-100, typed by hand), "query" (a tracker query to count) or "items" (the pieces it is made of)'
  if (hasProgress && (typeof v['progress'] !== 'number' || !Number.isFinite(v['progress']))) return '"progress" must be a number from 0 to 100'
  if (hasQuery && typeof v['query'] !== 'string') return '"query" must be a string'
  let source: Milestone['source']
  if (hasItems) {
    const items = parsePieces(v['items'])
    if (typeof items === 'string') return `${items} (a piece is { "kind": "ticket", "key" } | { "kind": "task", "itemId" } | { "kind": "link", "url", "label"?, "done"? }, each with an optional "weight" ${PIECE_WEIGHT.min}-${PIECE_WEIGHT.max}, default ${PIECE_WEIGHT.default})`
    source = { kind: 'items', items }
  } else source = hasProgress ? { kind: 'manual', progress: Math.round(v['progress'] as number) } : { kind: 'tracker', query: str(v['query']), ...(str(v['connectionId']) ? { connectionId: str(v['connectionId']) } : {}) }
  const links = v['links'] === undefined || v['links'] === null ? [] : parsePlanLinks(v['links'])
  if (typeof links === 'string') return links
  const m: Milestone = { id: 'new', name: str(v['name']), start: str(v['start']), end: str(v['end']), source, ...(str(v['notes']) ? { notes: str(v['notes']) } : {}), ...(str(v['link']) ? { link: str(v['link']) } : {}), ...(links.length > 0 ? { links } : {}) }
  const problems = milestoneProblems(m)
  if (problems.length > 0) return `not a valid milestone: ${problems.join(', ')} (name up to ${MILESTONE_LIMITS.name} characters, start and end as YYYY-MM-DD with start <= end, progress 0-100, link http(s))`
  const { id: _id, ...rest } = m
  return rest
}

/** The body of `PATCH /v1/milestones/:id`; a string says what is wrong. */
export function parseMilestonePatch(body: unknown): MilestonePatch | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object'
  const v = body as Record<string, unknown>
  const out: MilestonePatch = {}
  for (const key of ['name', 'start', 'end', 'query'] as const) {
    if (v[key] === undefined) continue
    if (typeof v[key] !== 'string') return `"${key}" must be a string`
    out[key] = v[key] as string
  }
  for (const key of ['notes', 'link'] as const) {
    if (v[key] === undefined) continue
    if (v[key] !== null && typeof v[key] !== 'string') return `"${key}" must be a string or null`
    out[key] = v[key] as string | null
  }
  if (v['progress'] !== undefined) {
    if (typeof v['progress'] !== 'number' || !Number.isFinite(v['progress'])) return '"progress" must be a number from 0 to 100'
    out.progress = v['progress']
  }
  if (v['links'] !== undefined) {
    if (v['links'] === null) out.links = null
    else {
      const links = parsePlanLinks(v['links'])
      if (typeof links === 'string') return links
      out.links = links
    }
  }
  if (v['items'] !== undefined) {
    const items = parsePieces(v['items'])
    if (typeof items === 'string') return items
    out.items = items
  }
  if (Object.keys(out).length === 0) return 'nothing to change: send name, start, end, progress, query, items, notes, link or links'
  return out
}

/** The source of an agent's change: its session and an optional short label (`reason`). */
function changeSource(session: string | null, body: unknown): MilestoneProposal['source'] {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const label = typeof b['reason'] === 'string' ? b['reason'].trim().slice(0, 200) : ''
  return { ...(session ? { session } : {}), ...(label ? { label } : {}) }
}

export interface PlanControlDeps extends ControlProfileDeps {
  planner: Pick<PlannerService, 'view' | 'updateItem' | 'agentMilestone'>
  /** A new milestone id. */
  newId?: () => string
  /** The profile's agenda with its briefs (the Plan screen's view). */
  agenda: (profileId: string) => Promise<PlanView>
  profile: (profileId: string) => Promise<Profile | undefined>
  now?: () => number
}

/** The ask of a request: `session` and `profile` from the query, or from a JSON body. */
const askOf = (params: URLSearchParams, body?: unknown) => {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  return { session: b['session'] ?? params.get('session') ?? undefined, profile: b['profile'] ?? params.get('profile') ?? undefined }
}

/** The handlers of the Plan endpoints, for `ControlDeps.plan`. */
export function createPlanControl(deps: PlanControlDeps): PlanControl {
  const now = deps.now ?? Date.now
  const plannerOn = (p: Profile | undefined) => p !== undefined && moduleScreens(p.modules).includes('planner')
  return {
    async today(params) {
      const who = await resolveControlProfile(deps, askOf(params))
      if (!who.ok) return fail(who.status, who.error)
      return { status: 200, body: todayAnswer(await deps.agenda(who.profileId), now()) }
    },
    async inbox(params) {
      const query = parseInboxQuery(params)
      if (typeof query === 'string') return fail(400, query)
      const who = await resolveControlProfile(deps, askOf(params))
      if (!who.ok) return fail(who.status, who.error)
      const profile = await deps.profile(who.profileId)
      if (!plannerOn(profile)) return { status: 200, body: { ok: true, enabled: false, reason: STATE_REASON.moduleOff, items: [], total: 0 } }
      const view = await deps.planner.view(who.profileId)
      const narrowed = filterInbox(view.inbox, { kind: query.kind ?? 'all', area: query.area ?? 'all', status: query.status === 'open' ? 'all' : query.status, ...(query.q ? { text: query.q } : {}) })
      const items = (query.status === 'open' ? narrowed.filter(isOpenItem) : narrowed).sort(inboxOrder)
      const people = plannerSettings(profile).people
      return { status: 200, body: { ok: true, enabled: true, today: view.today, items: items.slice(0, query.limit).map((i) => itemAnswer(i, people, CONTROL_TEXT_CAP.detail, view.itemTickets[i.id])), total: items.length, ...(items.length > query.limit ? { truncated: true } : {}) } }
    },
    async updateItem(id, body, params) {
      if (!/^[\w.:-]{1,200}$/.test(id)) return fail(400, 'bad item id')
      const update = parseInboxUpdate(body)
      if (typeof update === 'string') return fail(400, update)
      const who = await resolveControlProfile(deps, askOf(params, body))
      if (!who.ok) return fail(who.status, who.error)
      const r = await deps.planner.updateItem(who.profileId, id, update)
      if (!r.ok) return fail(r.reason === 'unknown' ? 404 : r.reason === 'tooLong' ? 400 : 409, r.error)
      const profile = await deps.profile(who.profileId)
      const view = r.item.ticket ? await deps.planner.view(who.profileId) : undefined
      return { status: 200, body: { ok: true, item: itemAnswer(r.item, plannerSettings(profile).people, INBOX_LIMITS.detail, view?.itemTickets[r.item.id]) } }
    },
    async milestones(params) {
      const who = await resolveControlProfile(deps, askOf(params))
      if (!who.ok) return fail(who.status, who.error)
      const view = await deps.planner.view(who.profileId)
      if (!view.enabled) return { status: 200, body: { ok: true, enabled: false, reason: STATE_REASON.moduleOff, milestones: [] } }
      return {
        status: 200,
        body: {
          ok: true,
          enabled: true,
          today: view.today,
          agentChanges: view.agentMilestones,
          pending: view.proposals.map((p) => ({ proposalId: p.id, action: p.action, id: p.milestoneId, ...(p.milestone ? { name: p.milestone.name } : p.before ? { name: p.before.name } : {}), createdAt: iso(p.createdAt) })),
          milestones: view.milestones.map((row) => ({
            id: row.milestone.id,
            name: row.milestone.name,
            start: row.milestone.start,
            end: row.milestone.end,
            status: row.status,
            progress: row.progress,
            elapsed: row.elapsed,
            source: row.milestone.source.kind,
            ...(row.counts ? { counts: { total: row.counts.total, todo: row.counts.todo, inProgress: row.counts.inProgress, done: row.counts.done, at: iso(row.counts.at) } } : {}),
            ...(row.pieces ? { pieces: row.pieces.map(pieceAnswer) } : {}),
            ...(row.error ? { error: row.error } : {}),
            ...(row.milestone.notes ? { notes: cap(row.milestone.notes, CONTROL_TEXT_CAP.detail) } : {}),
            ...(row.milestone.link ? { link: row.milestone.link } : {}),
            ...(row.milestone.links?.length ? { links: row.milestone.links } : {}),
            ...(row.milestone.updatedAt ? { updatedAt: iso(row.milestone.updatedAt), ...(row.milestone.updatedBy ? { updatedBy: row.milestone.updatedBy } : {}) } : {})
          }))
        }
      }
    },
    async changeMilestone(id, method, body, params) {
      if (id !== null && !/^[\w.:-]{1,64}$/.test(id)) return fail(400, 'bad milestone id')
      const who = await resolveControlProfile(deps, askOf(params, body))
      if (!who.ok) return fail(who.status, who.error)
      const view = await deps.planner.view(who.profileId)
      if (!view.enabled) return fail(409, STATE_REASON.moduleOff!)
      let change: Parameters<PlanControlDeps['planner']['agentMilestone']>[1]
      if (method === 'POST') {
        const created = parseMilestoneCreate(body)
        if (typeof created === 'string') return fail(400, created)
        const milestoneId = (deps.newId ?? randomUUID)()
        change = { action: 'create', milestoneId, milestone: { id: milestoneId, ...created } }
      } else {
        const current = view.milestones.find((r) => r.milestone.id === id)?.milestone
        if (!current) return fail(404, 'unknown milestone')
        if (method === 'DELETE') change = { action: 'delete', milestoneId: current.id }
        else {
          const patch = parseMilestonePatch(body)
          if (typeof patch === 'string') return fail(400, patch)
          const next = patchMilestone(current, patch)
          if (typeof next === 'string') return fail(400, next)
          change = { action: 'update', milestoneId: current.id, milestone: next }
        }
      }
      const r = await deps.planner.agentMilestone(who.profileId, change, changeSource(who.session, body))
      if (!r.ok) return fail(r.reason === 'unknown' ? 404 : 409, r.error)
      if (r.applied) return { status: 200, body: { ok: true, applied: true, id: change.milestoneId } }
      return { status: 202, body: { ok: true, applied: false, pending: true, proposalId: r.proposal.id, id: change.milestoneId, note: 'The user must apply this change on the Plan screen (Milestones); it is not applied yet.' } }
    },
    async people(params) {
      const who = await resolveControlProfile(deps, askOf(params))
      if (!who.ok) return fail(who.status, who.error)
      const profile = await deps.profile(who.profileId)
      if (!plannerOn(profile)) return { status: 200, body: { ok: true, enabled: false, reason: STATE_REASON.moduleOff, people: [] } }
      // Notes stay in Workhub: they go into briefs, not to any agent that asks.
      const people = plannerSettings(profile).people.map((p) => ({ id: p.id, name: p.name, emails: p.emails, ...(p.handles && Object.values(p.handles).some(Boolean) ? { handles: p.handles } : {}) }))
      return { status: 200, body: { ok: true, enabled: true, people } }
    }
  }
}

/** What the control server calls for the Plan endpoints. */
export interface PlanControl {
  /** `GET /v1/plan/today`. */
  today(params: URLSearchParams): Promise<ControlReply>
  /** `GET /v1/inbox`. */
  inbox(params: URLSearchParams): Promise<ControlReply>
  /** `PATCH /v1/inbox/:id`. */
  updateItem(id: string, body: unknown, params: URLSearchParams): Promise<ControlReply>
  /** `GET /v1/milestones`. */
  milestones(params: URLSearchParams): Promise<ControlReply>
  /** `POST /v1/milestones` (id null), `PATCH` or `DELETE /v1/milestones/:id`: applied or proposed, per the profile's setting. */
  changeMilestone(id: string | null, method: 'POST' | 'PATCH' | 'DELETE', body: unknown, params: URLSearchParams): Promise<ControlReply>
  /** `GET /v1/people`. */
  people(params: URLSearchParams): Promise<ControlReply>
}
