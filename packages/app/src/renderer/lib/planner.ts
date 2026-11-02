import {
  cleanCriticalities,
  DEFAULT_INBOX_SETTINGS,
  inboxSettings,
  isDay,
  milestoneProblems,
  parsePlanLinks,
  type InboxAction,
  type InboxBulkPatch,
  type InboxItem,
  type InboxKind,
  type InboxProposal,
  type InboxSettings,
  type InboxSourceType,
  type IssuePriority,
  type Milestone,
  type MilestonePiece,
  type MilestoneStatusKind,
  type PieceKind,
  type PieceState,
  type PlanLink,
  type PlannerSettings
} from '@workhub/core'
import type { MilestoneView } from '@shared/planner-api'
import type { Tone } from '../components/atoms'
import type { MessageKey } from '../i18n/translate'
import { slugify } from './tickets'
import { listToText, textToList } from './plan'

export const MILESTONE_STATUS_LABEL: Record<MilestoneStatusKind, MessageKey> = {
  late: 'planner.milestone.status.late',
  atRisk: 'planner.milestone.status.atRisk',
  onTrack: 'planner.milestone.status.onTrack',
  notStarted: 'planner.milestone.status.notStarted',
  done: 'planner.milestone.status.done'
}

export const MILESTONE_STATUS_TONE: Record<MilestoneStatusKind, Tone> = { late: 'danger', atRisk: 'warning', onTrack: 'success', notStarted: 'neutral', done: 'info' }

/** Late or at risk: what Home's "Milestones at risk" lists. */
export function milestonesAtRisk(rows: readonly MilestoneView[]): MilestoneView[] {
  return rows.filter((r) => r.status === 'late' || r.status === 'atRisk')
}

/** A milestone as its form edits it. */
export interface MilestoneForm {
  /** Null until saved. */
  id: string | null
  name: string
  start: string
  end: string
  kind: Milestone['source']['kind']
  progress: string
  connectionId: string
  query: string
  /** The pieces of a milestone made of pieces (kept while another source is picked, so switching back loses nothing). */
  pieces: MilestonePiece[]
  notes: string
  link: string
  links: LinkRow[]
}

/** One row of a links editor, as typed. */
export interface LinkRow {
  label: string
  url: string
}

/** The links of an editor's rows (blank rows left out); null when a row is not a valid link. */
export function rowsToLinks(rows: readonly LinkRow[]): PlanLink[] | null {
  const filled = rows.filter((r) => r.url.trim() || r.label.trim())
  const links = parsePlanLinks(filled.map((r) => ({ label: r.label, url: r.url.trim() })))
  return typeof links === 'string' ? null : links
}

export const linksToRows = (links: readonly PlanLink[] | undefined): LinkRow[] => (links ?? []).map((l) => ({ label: l.label === l.url ? '' : l.label, url: l.url }))

export function milestoneToForm(m: Milestone | undefined, today: string): MilestoneForm {
  if (!m) return { id: null, name: '', start: today, end: today, kind: 'manual', progress: '0', connectionId: '', query: '', pieces: [], notes: '', link: '', links: [] }
  return {
    id: m.id,
    name: m.name,
    start: m.start,
    end: m.end,
    kind: m.source.kind,
    progress: m.source.kind === 'manual' ? String(m.source.progress) : '0',
    connectionId: m.source.kind === 'tracker' ? (m.source.connectionId ?? '') : '',
    query: m.source.kind === 'tracker' ? m.source.query : '',
    pieces: m.source.kind === 'items' ? m.source.items.map((p) => ({ ...p })) : [],
    notes: m.notes ?? '',
    link: m.link ?? '',
    links: linksToRows(m.links)
  }
}

export function milestoneId(name: string, taken: readonly string[]): string {
  const root = slugify(name) || 'milestone'
  if (!taken.includes(root)) return root
  for (let i = 2; ; i++) if (!taken.includes(`${root}-${i}`)) return `${root}-${i}`
}

/** The milestone a form saves; links that are not valid are kept as typed so the check names them. */
export function formToMilestone(form: MilestoneForm, id: string): Milestone {
  const progress = Math.round(Number(form.progress))
  const links = rowsToLinks(form.links) ?? form.links.filter((r) => r.url.trim() || r.label.trim())
  return {
    id,
    name: form.name.trim(),
    start: form.start,
    end: form.end,
    source:
      form.kind === 'manual'
        ? { kind: 'manual', progress: Number.isFinite(progress) ? progress : -1 }
        : form.kind === 'items'
          ? { kind: 'items', items: form.pieces }
          : { kind: 'tracker', query: form.query.trim(), ...(form.connectionId ? { connectionId: form.connectionId } : {}) },
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    ...(form.link.trim() ? { link: form.link.trim() } : {}),
    ...(links.length > 0 ? { links } : {})
  }
}

const PROBLEM_KEY: Record<string, MessageKey> = {
  name: 'planner.milestone.problem.name',
  start: 'planner.milestone.problem.dates',
  end: 'planner.milestone.problem.dates',
  order: 'planner.milestone.problem.order',
  progress: 'planner.milestone.problem.progress',
  query: 'planner.milestone.problem.query',
  pieces: 'planner.milestone.problem.pieces',
  link: 'planner.milestone.problem.link',
  links: 'planner.links.problem',
  notes: 'planner.milestone.problem.notes'
}

/** The first thing wrong with a form, as a message; null when it can be saved. */
export function milestoneFormProblem(form: MilestoneForm): MessageKey | null {
  const problems = milestoneProblems(formToMilestone(form, 'check')).filter((p) => p !== 'id')
  return problems.length ? (PROBLEM_KEY[problems[0]!] ?? 'planner.milestone.problem.name') : null
}

export const PIECE_KIND_LABEL: Record<PieceKind, MessageKey> = { ticket: 'planner.pieces.kind.ticket', task: 'planner.pieces.kind.task', link: 'planner.pieces.kind.link' }
export const PIECE_STATE_LABEL: Record<PieceState, MessageKey> = { todo: 'planner.pieces.state.todo', inProgress: 'planner.pieces.state.inProgress', done: 'planner.pieces.state.done', unknown: 'planner.pieces.state.unknown' }
export const PIECE_STATE_TONE: Record<PieceState, Tone> = { todo: 'neutral', inProgress: 'info', done: 'success', unknown: 'warning' }

/** The open tasks and bugs a milestone can be made of (pending or kept, not already a piece), matching `text`, newest first. */
export function pieceTaskChoices(items: readonly InboxItem[], pieces: readonly MilestonePiece[], text: string): InboxItem[] {
  const taken = new Set(pieces.flatMap((p) => (p.kind === 'task' ? [p.itemId] : [])))
  const q = text.trim().toLowerCase()
  return items
    .filter((i) => i.kind !== 'decision' && (i.status === 'local' || i.status === 'pending') && !taken.has(i.id) && (!q || i.title.toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt - a.createdAt)
}

// Inbox

export const INBOX_KIND_LABEL: Record<InboxKind, MessageKey> = { task: 'planner.inbox.kind.task', bug: 'planner.inbox.kind.bug', decision: 'planner.inbox.kind.decision' }
export const INBOX_STATUS_LABEL: Record<InboxItem['status'], MessageKey> = {
  pending: 'planner.inbox.status.pending',
  ticket: 'planner.inbox.status.ticket',
  local: 'planner.inbox.status.local',
  discarded: 'planner.inbox.status.discarded',
  done: 'planner.inbox.status.done'
}
export const INBOX_SOURCE_LABEL: Record<InboxSourceType, MessageKey> = { manual: 'planner.inbox.source.manual', alert: 'planner.inbox.source.alert', agent: 'planner.inbox.source.agent', meeting: 'planner.inbox.source.meeting' }

/** The label of an action on an item; approving a decision records it. */
export function inboxActionLabel(action: InboxAction, kind: InboxKind): MessageKey {
  if (action === 'approve') return kind === 'decision' ? 'planner.inbox.action.record' : 'planner.inbox.action.approve'
  return `planner.inbox.action.${action}` as MessageKey
}

/** The "Add item" form. */
export interface InboxItemForm {
  kind: InboxKind
  title: string
  detail: string
  area: string
  criticality: string
  due: string
  people: string[]
}

export const EMPTY_ITEM_FORM: InboxItemForm = { kind: 'task', title: '', detail: '', area: '', criticality: '', due: '', people: [] }

export function formToProposal(form: InboxItemForm): InboxProposal {
  return {
    kind: form.kind,
    title: form.title.replace(/\s+/g, ' ').trim(),
    detail: form.detail.trim(),
    ...(form.area ? { area: form.area } : {}),
    ...(form.criticality ? { criticality: form.criticality } : {}),
    ...(isDay(form.due) ? { due: form.due } : {}),
    ...(form.people.length ? { people: form.people } : {})
  }
}

/** Settings → Plan → Inbox as its form edits it. */
export interface InboxSettingsForm {
  areas: string
  criticalities: { name: string; priority: IssuePriority }[]
  trackerConnectionId: string
  project: string
  taskType: string
  bugType: string
  descriptionTemplate: string
  margin: number
}

export function inboxSettingsToForm(planner: Partial<PlannerSettings> | undefined, margin: number): InboxSettingsForm {
  const s = inboxSettings(planner)
  return { areas: listToText(s.areas), criticalities: s.criticalities.map((c) => ({ ...c })), trackerConnectionId: s.trackerConnectionId, project: s.project, taskType: s.issueTypes.task, bugType: s.issueTypes.bug, descriptionTemplate: s.descriptionTemplate, margin }
}

export function formToInboxSettings(form: InboxSettingsForm): InboxSettings {
  return {
    ...DEFAULT_INBOX_SETTINGS,
    areas: textToList(form.areas).slice(0, 50),
    criticalities: cleanCriticalities(form.criticalities),
    trackerConnectionId: form.trackerConnectionId,
    project: form.project.trim(),
    issueTypes: { task: form.taskType.trim(), bug: form.bugType.trim() },
    descriptionTemplate: form.descriptionTemplate
  }
}

/** The levels a new profile might start from; offered as a one-click preset, never applied on its own. */
export const CRITICALITY_PRESET: { name: string; priority: IssuePriority }[] = [
  { name: 'Critical', priority: 1 },
  { name: 'High', priority: 2 },
  { name: 'Medium', priority: 3 },
  { name: 'Low', priority: 4 }
]

/** The bulk edit bar's choice for a select: leave the field as it is, clear it, or set this value. */
export const BULK_KEEP = ''
export const BULK_CLEAR = '__clear__'

/** The bulk edit bar as typed: `area` and `criticality` are `BULK_KEEP`, `BULK_CLEAR` or a value; the due date is kept, set to `dueDate` or cleared. */
export interface BulkForm {
  area: string
  criticality: string
  due: 'keep' | 'set' | 'clear'
  dueDate: string
}

export const EMPTY_BULK_FORM: BulkForm = { area: BULK_KEEP, criticality: BULK_KEEP, due: 'keep', dueDate: '' }

/** The patch the bulk edit bar sends: only the fields it changes (null clears one); a due date to set but not picked yet changes nothing. */
export function bulkFormToPatch(form: BulkForm): InboxBulkPatch {
  const patch: InboxBulkPatch = {}
  for (const key of ['area', 'criticality'] as const) {
    if (form[key] === BULK_CLEAR) patch[key] = null
    else if (form[key] !== BULK_KEEP) patch[key] = form[key]
  }
  if (form.due === 'clear') patch.due = null
  else if (form.due === 'set' && isDay(form.dueDate)) patch.due = form.dueDate
  return patch
}

/** How many of these items the patch would change; Apply waits until it is at least one. */
export function bulkChangeCount(items: readonly Pick<InboxItem, 'area' | 'criticality' | 'due'>[], patch: InboxBulkPatch): number {
  const keys = (['area', 'criticality', 'due'] as const).filter((k) => patch[k] !== undefined)
  return items.filter((item) => keys.some((k) => (item[k] || null) !== (patch[k] || null))).length
}

/** A Markdown body as plain text for a short preview in a list: no emphasis marks, code ticks, heading marks or link addresses. */
export function plainPreview(text: string): string {
  return text
    .replace(/^```.*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?![*\w])/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
