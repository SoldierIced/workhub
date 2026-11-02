import {
  CALENDAR_CONNECTION_SETTINGS,
  MAX_LEAD_MINUTES,
  MAX_PLANNER_REFRESH_MINUTES,
  MIN_PLANNER_REFRESH_MINUTES,
  type CalendarEvent,
  type Connection,
  type MeetingRule,
  type Person
} from '@workhub/core'
import type { PlanBrief, PlanCalendarFailure, PlanState } from '@shared/plan-api'
import type { MessageKey } from '../i18n/translate'
import { slugify } from './tickets'

/** The refresh intervals Settings → Plan offers, in minutes. */
export const PLAN_REFRESH_CHOICES = [5, 10, 15, 30, 60, 120] as const
/** The reminder lead times Settings → Plan offers, in minutes (0 turns the default reminder off). */
export const PLAN_LEAD_CHOICES = [0, 1, 2, 5, 10, 15, 30, 60] as const

export const PLAN_STATE_COPY: Partial<Record<PlanState, { title: MessageKey; hint: MessageKey }>> = {
  moduleOff: { title: 'plan.status.moduleOff.title', hint: 'plan.status.moduleOff.hint' },
  noConnection: { title: 'plan.status.noConnection.title', hint: 'plan.status.noConnection.hint' },
  error: { title: 'plan.status.error.title', hint: 'plan.status.error.hint' }
}

export const CALENDAR_FAILURE_KEY: Record<PlanCalendarFailure, MessageKey> = {
  unreachable: 'plan.failure.unreachable',
  unauthorized: 'plan.failure.unauthorized',
  notCalendar: 'plan.failure.notCalendar',
  tooLarge: 'plan.failure.tooLarge',
  noSecret: 'plan.failure.noSecret'
}

/** What an event's brief control says: a fresh "Prepare brief", or where the started one is. */
export function briefLabel(brief: PlanBrief | undefined): MessageKey {
  if (!brief) return 'plan.brief.prepare'
  switch (brief.phase) {
    case 'preparing':
      return 'plan.brief.preparing'
    case 'ready':
      return 'plan.brief.ready'
    case 'closed':
      return 'plan.brief.closed'
    case 'failed':
      return 'plan.brief.retry'
  }
}

/** A comma- or line-separated list typed in a field, trimmed, without empties or repeats. */
export function textToList(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))]
}

export const listToText = (list: readonly string[] | undefined) => (list ?? []).join(', ')

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)))
export const clampLead = (n: number) => clamp(n, 0, MAX_LEAD_MINUTES)
export const clampRefresh = (n: number) => clamp(n, MIN_PLANNER_REFRESH_MINUTES, MAX_PLANNER_REFRESH_MINUTES)

/** A rule as its form edits it: lists as typed text. */
export interface RuleForm {
  id: string
  name: string
  enabled: boolean
  action: MeetingRule['action']
  leadMinutes: number
  titleContains: string
  titleRegex: string
  attendeeEmails: string
  minAttendees: string
  recurringOnly: boolean
  message: string
  automationId: string
}

export function ruleToForm(rule: MeetingRule): RuleForm {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    action: rule.action,
    leadMinutes: rule.leadMinutes,
    titleContains: listToText(rule.match.titleContains),
    titleRegex: rule.match.titleRegex ?? '',
    attendeeEmails: listToText(rule.match.attendeeEmails),
    minAttendees: rule.match.minAttendees === undefined ? '' : String(rule.match.minAttendees),
    recurringOnly: rule.match.recurringOnly === true,
    message: rule.message ?? '',
    automationId: rule.automationId ?? ''
  }
}

export function formToRule(form: RuleForm): MeetingRule {
  const contains = textToList(form.titleContains)
  const emails = textToList(form.attendeeEmails).map((e) => e.toLowerCase())
  const min = Number.parseInt(form.minAttendees, 10)
  const match: MeetingRule['match'] = {
    ...(contains.length ? { titleContains: contains } : {}),
    ...(form.titleRegex.trim() ? { titleRegex: form.titleRegex.trim() } : {}),
    ...(emails.length ? { attendeeEmails: emails } : {}),
    ...(Number.isFinite(min) && min > 0 ? { minAttendees: min } : {}),
    ...(form.recurringOnly ? { recurringOnly: true } : {})
  }
  return {
    id: form.id,
    name: form.name.trim(),
    enabled: form.enabled,
    match,
    action: form.action,
    leadMinutes: clampLead(form.leadMinutes),
    ...(form.action === 'remind' && form.message.trim() ? { message: form.message.trim() } : {}),
    ...(form.action === 'brief' && form.automationId ? { automationId: form.automationId } : {})
  }
}

export function emptyRuleForm(id: string, action: MeetingRule['action']): RuleForm {
  return ruleToForm({ id, name: '', enabled: true, match: {}, action, leadMinutes: action === 'brief' ? 30 : 5 })
}

/** A person as the form edits them: emails as typed text. */
export interface PersonForm {
  id: string
  name: string
  emails: string
  github: string
  jira: string
  linear: string
  slack: string
  notes: string
}

export function personToForm(person: Person): PersonForm {
  const h = person.handles ?? {}
  return { id: person.id, name: person.name, emails: listToText(person.emails), github: h.github ?? '', jira: h.jira ?? '', linear: h.linear ?? '', slack: h.slack ?? '', notes: person.notes ?? '' }
}

export function formToPerson(form: PersonForm): Person {
  const handles = Object.fromEntries((['github', 'jira', 'linear', 'slack'] as const).map((k) => [k, form[k].trim()]).filter(([, v]) => v)) as Person['handles']
  return {
    id: form.id,
    name: form.name.trim(),
    emails: textToList(form.emails).map((e) => e.toLowerCase()),
    ...(handles && Object.keys(handles).length ? { handles } : {}),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {})
  }
}

/** An id for a new person, from their name, not taken yet. */
export function personId(name: string, taken: readonly string[]): string {
  const root = slugify(name) || 'person'
  if (!taken.includes(root)) return root
  for (let i = 2; ; i++) if (!taken.includes(`${root}-${i}`)) return `${root}-${i}`
}

/** The form of a calendar connection: the address is typed only to set or replace it. */
export interface CalendarForm {
  id: string | null
  name: string
  ownerEmail: string
  /** The private address as typed; empty keeps the stored one. */
  secret: string
}

export function calendarToForm(connection: Connection | undefined): CalendarForm {
  return { id: connection?.id ?? null, name: connection?.name ?? '', ownerEmail: connection?.settings[CALENDAR_CONNECTION_SETTINGS.ownerEmail] ?? '', secret: '' }
}

export function formToCalendar(form: CalendarForm, id: string): Connection {
  const owner = form.ownerEmail.trim().toLowerCase()
  return { id, kind: 'calendar', provider: 'ics', ...(form.name.trim() ? { name: form.name.trim() } : {}), settings: owner ? { [CALENDAR_CONNECTION_SETTINGS.ownerEmail]: owner } : {} }
}

/** Whether a typed calendar address looks usable (https or webcal); the main process checks again. */
export function looksLikeCalendarUrl(text: string): boolean {
  return /^(https|webcals?):\/\/\S+$/i.test(text.trim())
}

/** The event's time range as a row shows it, or null for an all-day event. */
export function eventTimes(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>, format: (ms: number) => string): string | null {
  if (event.allDay) return null
  return event.end > event.start ? `${format(event.start)} – ${format(event.end)}` : format(event.start)
}

/** Whether the event is happening at `now`. */
export const isOngoing = (event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>, now: number) => !event.allDay && event.start <= now && now < event.end
