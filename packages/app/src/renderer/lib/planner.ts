import {
  cleanCriticalities,
  DEFAULT_INBOX_SETTINGS,
  inboxSettings,
  isDay,
  milestoneProblems,
  type InboxAction,
  type InboxItem,
  type InboxKind,
  type InboxProposal,
  type InboxSettings,
  type InboxSourceType,
  type IssuePriority,
  type Milestone,
  type MilestoneStatusKind,
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
  kind: 'manual' | 'tracker'
  progress: string
  connectionId: string
  query: string
  notes: string
  link: string
}

export function milestoneToForm(m: Milestone | undefined, today: string): MilestoneForm {
  if (!m) return { id: null, name: '', start: today, end: today, kind: 'manual', progress: '0', connectionId: '', query: '', notes: '', link: '' }
  return {
    id: m.id,
    name: m.name,
    start: m.start,
    end: m.end,
    kind: m.source.kind,
    progress: m.source.kind === 'manual' ? String(m.source.progress) : '0',
    connectionId: m.source.kind === 'tracker' ? (m.source.connectionId ?? '') : '',
    query: m.source.kind === 'tracker' ? m.source.query : '',
    notes: m.notes ?? '',
    link: m.link ?? ''
  }
}

export function milestoneId(name: string, taken: readonly string[]): string {
  const root = slugify(name) || 'milestone'
  if (!taken.includes(root)) return root
  for (let i = 2; ; i++) if (!taken.includes(`${root}-${i}`)) return `${root}-${i}`
}

export function formToMilestone(form: MilestoneForm, id: string): Milestone {
  const progress = Math.round(Number(form.progress))
  return {
    id,
    name: form.name.trim(),
    start: form.start,
    end: form.end,
    source: form.kind === 'manual' ? { kind: 'manual', progress: Number.isFinite(progress) ? progress : -1 } : { kind: 'tracker', query: form.query.trim(), ...(form.connectionId ? { connectionId: form.connectionId } : {}) },
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    ...(form.link.trim() ? { link: form.link.trim() } : {})
  }
}

const PROBLEM_KEY: Record<string, MessageKey> = {
  name: 'planner.milestone.problem.name',
  start: 'planner.milestone.problem.dates',
  end: 'planner.milestone.problem.dates',
  order: 'planner.milestone.problem.order',
  progress: 'planner.milestone.problem.progress',
  query: 'planner.milestone.problem.query',
  link: 'planner.milestone.problem.link',
  notes: 'planner.milestone.problem.notes'
}

/** The first thing wrong with a form, as a message; null when it can be saved. */
export function milestoneFormProblem(form: MilestoneForm): MessageKey | null {
  const problems = milestoneProblems(formToMilestone(form, 'check')).filter((p) => p !== 'id')
  return problems.length ? (PROBLEM_KEY[problems[0]!] ?? 'planner.milestone.problem.name') : null
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
