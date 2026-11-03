import { isDay } from '../alerts/days'
import { isIssuePriority, type IssuePriority } from '../tickets/types'
import {
  DEFAULT_INBOX_DESCRIPTION_TEMPLATE,
  DEFAULT_INBOX_SETTINGS,
  INBOX_KINDS,
  INBOX_LIMITS,
  INBOX_RETENTION_MS,
  type CriticalityLevel,
  type InboxAction,
  type InboxBulkPatch,
  type InboxItem,
  type InboxKind,
  type InboxProposal,
  type InboxSettings,
  type InboxSource,
  type InboxTicket
} from './types'
import { parsePlanLinks } from './links'

/** A profile's inbox setup with the defaults filled in. */
export function inboxSettings(planner: { inbox?: Partial<InboxSettings> } | null | undefined): InboxSettings {
  const s = planner?.inbox ?? {}
  return { ...DEFAULT_INBOX_SETTINGS, ...s, issueTypes: { ...DEFAULT_INBOX_SETTINGS.issueTypes, ...s.issueTypes } }
}

/** Pending, kept, or in the tracker and not done yet: an item still to act on. */
export function isOpenItem(item: Pick<InboxItem, 'status'>): boolean {
  return item.status === 'pending' || item.status === 'local' || item.status === 'ticket'
}

/**
 * A task or bug whose ticket the tracker decides on: one sent to the tracker (`ticket`), or a local
 * one linked to an existing ticket. It becomes done when the ticket is (`markTicketDone`).
 */
export function followsTicket(item: Pick<InboxItem, 'status' | 'kind' | 'ticket'>): boolean {
  return item.ticket !== undefined && item.kind !== 'decision' && (item.status === 'ticket' || item.status === 'local')
}

/** A title reduced for comparison: lower case, no accents, punctuation as spaces, single spaces. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Sources whose `ref` names one thing that deserves one item: an alert. A session or a meeting proposes many. */
const ONE_ITEM_PER_REF: ReadonlySet<InboxSource['type']> = new Set(['alert'])

/**
 * An open item with the same normalized title, or from the same alert, among the most recent open
 * ones. A session's or a meeting's `ref` never makes a duplicate: one session proposes several items.
 */
export function findDuplicate(items: readonly InboxItem[], candidate: { title: string; source?: InboxSource }, window: number = INBOX_LIMITS.dedupeWindow): InboxItem | undefined {
  const title = normalizeTitle(candidate.title)
  const ref = candidate.source?.ref && ONE_ITEM_PER_REF.has(candidate.source.type) ? `${candidate.source.type}|${candidate.source.ref}` : null
  const open = items.filter(isOpenItem).sort((a, b) => b.createdAt - a.createdAt).slice(0, window)
  return open.find((i) => (title !== '' && normalizeTitle(i.title) === title) || (ref !== null && i.source.ref !== undefined && `${i.source.type}|${i.source.ref}` === ref))
}

/** Whether a criticality is among the profile's two most urgent priorities (1 or 2). */
export function isUrgent(item: Pick<InboxItem, 'criticality'>, levels: readonly CriticalityLevel[]): boolean {
  const level = levels.find((l) => l.name === item.criticality)
  return level !== undefined && level.priority <= 2
}

export function priorityOf(criticality: string | undefined, levels: readonly CriticalityLevel[]): IssuePriority | undefined {
  return levels.find((l) => l.name === criticality)?.priority
}

export interface InboxGroups {
  /** Waiting for approval, newest first. */
  pending: InboxItem[]
  /**
   * Local tasks and bugs: overdue or due today, then critical and high, then the rest; and those
   * whose ticket the tracker decides on (`followsTicket`), until it is done.
   */
  tasks: { due: InboxItem[]; urgent: InboxItem[]; rest: InboxItem[]; tracker: InboxItem[] }
  /** Recorded decisions, newest first. */
  decisions: InboxItem[]
  /** Closed in the last week (done, discarded), newest first. */
  closed: InboxItem[]
}

const byDueThenNewest = (a: InboxItem, b: InboxItem) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.createdAt - a.createdAt
const newest = (a: InboxItem, b: InboxItem) => b.createdAt - a.createdAt
const newestClosed = (a: InboxItem, b: InboxItem) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt)

export function groupInbox(items: readonly InboxItem[], today: string, levels: readonly CriticalityLevel[]): InboxGroups {
  const groups: InboxGroups = { pending: [], tasks: { due: [], urgent: [], rest: [], tracker: [] }, decisions: [], closed: [] }
  for (const item of items) {
    if (item.status === 'pending') groups.pending.push(item)
    else if (followsTicket(item)) groups.tasks.tracker.push(item)
    else if (item.status === 'local' && item.kind === 'decision') groups.decisions.push(item)
    else if (item.status === 'local') {
      if (item.due && item.due <= today) groups.tasks.due.push(item)
      else if (isUrgent(item, levels)) groups.tasks.urgent.push(item)
      else groups.tasks.rest.push(item)
    } else groups.closed.push(item)
  }
  groups.pending.sort(newest)
  groups.tasks.due.sort(byDueThenNewest)
  groups.tasks.urgent.sort(byDueThenNewest)
  groups.tasks.rest.sort(byDueThenNewest)
  groups.tasks.tracker.sort(byDueThenNewest)
  groups.decisions.sort(newest)
  groups.closed.sort(newestClosed)
  return groups
}

/**
 * Drops closed items older than a week, then the oldest closed ones beyond `INBOX_LIMITS.items`.
 * Items in `keep` (the tasks a milestone is made of) are never dropped, so its progress holds.
 */
export function cleanupInbox(items: readonly InboxItem[], now: number, keep: ReadonlySet<string> = new Set()): InboxItem[] {
  const kept = items.filter((i) => isOpenItem(i) || keep.has(i.id) || i.closedAt === undefined || now - i.closedAt < INBOX_RETENTION_MS)
  if (kept.length <= INBOX_LIMITS.items) return kept
  const extra = kept.length - INBOX_LIMITS.items
  const drop = new Set(kept.filter((i) => !isOpenItem(i) && !keep.has(i.id)).sort((a, b) => (a.closedAt ?? a.createdAt) - (b.closedAt ?? b.createdAt)).slice(0, extra).map((i) => i.id))
  return kept.filter((i) => !drop.has(i.id))
}

/** The actions an item offers, in display order. */
export function availableInboxActions(item: Pick<InboxItem, 'status' | 'kind'>): InboxAction[] {
  switch (item.status) {
    case 'pending':
      return ['approve', 'keep', 'discard']
    case 'local':
      return item.kind === 'decision' ? ['discard'] : ['done', 'discard']
    case 'done':
    case 'discarded':
      return ['reopen']
    case 'ticket':
      // Closed by hand when the tracker cannot say (it is done on its own once the ticket is).
      return ['done']
  }
}

/**
 * An item after an action that needs no tracker: keep, discard, done, reopen, and approving a
 * decision (it is recorded). Null when the item does not offer it, or when approving needs a ticket.
 */
export function applyInboxAction(item: InboxItem, action: InboxAction, now: number): InboxItem | null {
  if (!availableInboxActions(item).includes(action)) return null
  const { closedAt: _closed, ...open } = item
  switch (action) {
    case 'approve':
      return item.kind === 'decision' ? { ...open, status: 'local' } : null
    case 'keep':
      return { ...open, status: 'local' }
    case 'discard':
      return { ...item, status: 'discarded', closedAt: now }
    case 'done':
      return { ...item, status: 'done', closedAt: now }
    case 'reopen':
      return { ...open, status: item.status === 'discarded' ? 'pending' : 'local' }
  }
}

/** The local actions that take an item from one status to another (approval to the tracker is never one of them). */
const STATUS_PATHS: Partial<Record<InboxItem['status'], Partial<Record<InboxItem['status'], InboxAction[]>>>> = {
  pending: { local: ['keep'], done: ['keep', 'done'], discarded: ['discard'] },
  local: { done: ['done'], discarded: ['discard'] },
  done: { local: ['reopen'], discarded: ['reopen', 'discard'] },
  discarded: { pending: ['reopen'], local: ['reopen', 'keep'], done: ['reopen', 'keep', 'done'] }
}

/**
 * An item moved to `target` with local actions only (keep, done, discard, reopen): what an agent may
 * do. The item itself when it already has that status; null when no local path leads there (an item
 * sent to the tracker, a decision marked done, a kept item sent back to approval).
 */
export function moveInboxItem(item: InboxItem, target: InboxItem['status'], now: number): InboxItem | null {
  if (item.status === target) return item
  const path = STATUS_PATHS[item.status]?.[target]
  if (!path) return null
  let next: InboxItem | null = item
  for (const action of path) {
    next = next && applyInboxAction(next, action, now)
    if (!next) return null
  }
  return next
}

/** An approved task or bug once its tracker issue exists: it stays open until the ticket is done. */
export function withTicket(item: InboxItem, ticket: InboxTicket): InboxItem {
  const { closedAt: _closed, ...open } = item
  return { ...open, status: 'ticket', ticket: { key: ticket.key, ...(ticket.url ? { url: ticket.url } : {}), ...(ticket.connectionId ? { connectionId: ticket.connectionId } : {}) } }
}

/**
 * A local task or bug linked to an existing ticket (`ticket`), or unlinked (null). Null when the
 * item cannot be: only local tasks and bugs are linked; an item sent to the tracker that is
 * unlinked goes back to a local task. Linking never creates a ticket.
 */
export function linkTicket(item: InboxItem, ticket: InboxTicket | null): InboxItem | null {
  if (item.kind === 'decision') return null
  const { ticket: _old, ...rest } = item
  if (ticket === null) {
    if (item.status === 'ticket') return { ...rest, status: 'local' }
    return item.status === 'local' ? rest : null
  }
  if (item.status !== 'local') return null
  return { ...rest, ticket: { key: ticket.key, ...(ticket.url ? { url: ticket.url } : {}), ...(ticket.connectionId ? { connectionId: ticket.connectionId } : {}) } }
}

/** An item that follows its ticket, marked done because the tracker says the ticket is; null when it does not follow one. */
export function markTicketDone(item: InboxItem, now: number): InboxItem | null {
  return followsTicket(item) ? { ...item, status: 'done', closedAt: now } : null
}

/** Sets area, criticality or due on the items with these ids. */
export function bulkEditInbox(items: readonly InboxItem[], ids: readonly string[], patch: InboxBulkPatch): InboxItem[] {
  const selected = new Set(ids)
  return items.map((item) => {
    if (!selected.has(item.id)) return item
    const next: InboxItem = { ...item }
    for (const key of ['area', 'criticality', 'due'] as const) {
      const value = patch[key]
      if (value === null || value === '') delete next[key]
      else if (value !== undefined) next[key] = value
    }
    return next
  })
}

/** Items whose kind, area and status match (`all` matches any), and whose title or detail has `text`. */
export function filterInbox(items: readonly InboxItem[], filters: { kind?: InboxKind | 'all'; area?: string | 'all'; status?: InboxItem['status'] | 'all'; text?: string }): InboxItem[] {
  const text = normalizeTitle(filters.text ?? '')
  return items.filter(
    (i) =>
      (!filters.kind || filters.kind === 'all' || i.kind === filters.kind) &&
      (!filters.area || filters.area === 'all' || i.area === filters.area) &&
      (!filters.status || filters.status === 'all' || i.status === filters.status) &&
      (!text || normalizeTitle(`${i.title} ${i.detail}`).includes(text))
  )
}

const SOURCE_NAME: Record<InboxSource['type'], string> = { manual: 'Added by hand', alert: 'Metric alert', agent: 'Agent', meeting: 'Meeting' }

/** The issue description of an item from the profile's template ({title} {detail} {source} {link}). */
export function renderInboxDescription(template: string, item: Pick<InboxItem, 'title' | 'detail' | 'source' | 'link'>): string {
  const source = item.source.label ? `${SOURCE_NAME[item.source.type]}: ${item.source.label}` : SOURCE_NAME[item.source.type]
  const values: Record<string, string> = { title: item.title, detail: item.detail, source, link: item.link ?? '' }
  return (template.trim() || DEFAULT_INBOX_DESCRIPTION_TEMPLATE)
    .replace(/\{(title|detail|source|link)\}/g, (_m, key: string) => values[key] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** A proposal from untrusted input, checked field by field; a string says what is wrong. */
export function parseInboxProposal(value: unknown): InboxProposal | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'every item must be an object'
  const v = value as Record<string, unknown>
  const kind = v['kind'] === undefined ? 'task' : v['kind']
  if (typeof kind !== 'string' || !(INBOX_KINDS as readonly string[]).includes(kind)) return '"kind" must be task, bug or decision'
  if (typeof v['title'] !== 'string' || !oneLine(v['title'])) return 'every item needs a "title"'
  const title = oneLine(v['title'])
  if (title.length > INBOX_LIMITS.title) return `"title" is longer than ${INBOX_LIMITS.title} characters`
  if (v['detail'] !== undefined && typeof v['detail'] !== 'string') return '"detail" must be a string'
  const detail = typeof v['detail'] === 'string' ? v['detail'].trim() : ''
  if (detail.length > INBOX_LIMITS.detail) return `"detail" is longer than ${INBOX_LIMITS.detail} characters`
  if (v['due'] !== undefined && !isDay(v['due'])) return '"due" must be a date (YYYY-MM-DD)'
  const people = v['people']
  if (people !== undefined && (!Array.isArray(people) || people.length > INBOX_LIMITS.people || people.some((p) => typeof p !== 'string' || p.length > 320))) return `"people" must be a list of at most ${INBOX_LIMITS.people} names, emails or ids`
  const link = v['link']
  if (link !== undefined && (typeof link !== 'string' || !/^https?:\/\//i.test(link) || link.length > 2000)) return '"link" must be an http(s) address'
  const links = v['links'] === undefined || v['links'] === null ? [] : parsePlanLinks(v['links'])
  if (typeof links === 'string') return links
  const short = (x: unknown) => (typeof x === 'string' && x.trim() && x.length <= 200 ? x.trim() : undefined)
  const area = short(v['area'])
  const criticality = short(v['criticality'])
  return {
    kind: kind as InboxKind,
    title,
    detail,
    ...(Array.isArray(people) && people.length > 0 ? { people: (people as string[]).map((p) => p.trim()).filter(Boolean) } : {}),
    ...(typeof v['due'] === 'string' ? { due: v['due'] } : {}),
    ...(area ? { area } : {}),
    ...(criticality ? { criticality } : {}),
    ...(typeof link === 'string' ? { link } : {}),
    ...(links.length > 0 ? { links } : {})
  }
}

/** The proposals of a request body: `{ items: [...] }`, a list, or a single item; at most `INBOX_LIMITS.perRequest`. */
export function parseInboxProposals(body: unknown): { ok: true; items: InboxProposal[]; label?: string } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'the body must be a JSON object' }
  const wrapped = !Array.isArray(body) && Array.isArray((body as { items?: unknown }).items)
  const list: unknown[] = Array.isArray(body) ? body : wrapped ? ((body as { items: unknown[] }).items) : [body]
  if (list.length === 0) return { ok: false, error: 'no items' }
  if (list.length > INBOX_LIMITS.perRequest) return { ok: false, error: `at most ${INBOX_LIMITS.perRequest} items per request` }
  const items: InboxProposal[] = []
  for (const [i, entry] of list.entries()) {
    const parsed = parseInboxProposal(entry)
    if (typeof parsed === 'string') return { ok: false, error: list.length > 1 ? `item ${i + 1}: ${parsed}` : parsed }
    items.push(parsed)
  }
  const label = wrapped ? (body as { source?: unknown }).source : undefined
  return { ok: true, items, ...(typeof label === 'string' && label.trim() ? { label: oneLine(label).slice(0, INBOX_LIMITS.label) } : {}) }
}

/** Person ids for names, emails or ids typed by a producer; unknown ones are left out. */
export function matchPeople(values: readonly string[] | undefined, people: readonly { id: string; name: string; emails: string[] }[]): string[] {
  const out = new Set<string>()
  for (const raw of values ?? []) {
    const v = raw.trim().toLowerCase()
    const person = people.find((p) => p.id.toLowerCase() === v || p.name.trim().toLowerCase() === v || p.emails.some((e) => e.trim().toLowerCase() === v))
    if (person) out.add(person.id)
  }
  return [...out]
}

/** A new pending item from a proposal. */
export function newInboxItem(proposal: InboxProposal, source: InboxSource, id: string, now: number, people: readonly { id: string; name: string; emails: string[] }[] = []): InboxItem {
  const ids = matchPeople(proposal.people, people)
  return {
    id,
    kind: proposal.kind,
    title: proposal.title,
    detail: proposal.detail,
    source,
    ...(proposal.area ? { area: proposal.area } : {}),
    ...(proposal.criticality ? { criticality: proposal.criticality } : {}),
    ...(proposal.due ? { due: proposal.due } : {}),
    ...(ids.length > 0 ? { people: ids } : {}),
    ...(proposal.link ? { link: proposal.link } : {}),
    ...(proposal.links && proposal.links.length > 0 ? { links: proposal.links } : {}),
    status: 'pending',
    createdAt: now
  }
}

/** The open items that involve a person, newest first. */
export function openItemsOf(items: readonly InboxItem[], personId: string): InboxItem[] {
  return items.filter((i) => isOpenItem(i) && i.people?.includes(personId)).sort(newest)
}

/** A settings form's levels, cleaned: named, unique, a valid priority. */
export function cleanCriticalities(levels: readonly { name: string; priority: unknown }[]): CriticalityLevel[] {
  const seen = new Set<string>()
  const out: CriticalityLevel[] = []
  for (const l of levels) {
    const name = l.name.trim()
    if (!name || seen.has(name.toLowerCase()) || !isIssuePriority(l.priority)) continue
    seen.add(name.toLowerCase())
    out.push({ name, priority: l.priority })
  }
  return out.slice(0, INBOX_LIMITS.criticalities)
}
