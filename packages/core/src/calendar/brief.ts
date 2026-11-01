import { peopleAt, startOfLocalDayAt } from './agenda'
import { FIRED_KEEP_MS } from './rules'
import type { BriefRecord, CalendarEvent, Person } from './types'

/** The placeholders a brief template may use. */
export const BRIEF_PLACEHOLDERS = ['title', 'start', 'end', 'attendees', 'description', 'meetingUrl', 'people', 'context'] as const
export type BriefPlaceholder = (typeof BRIEF_PLACEHOLDERS)[number]

/** The brief prompt a profile starts with (Settings → Plan lets the user rewrite it). */
export const DEFAULT_BRIEF_TEMPLATE = `Prepare me for this meeting. Keep it short and practical; do not change any files.

Meeting: {title}
When: {start} to {end}
Attendees: {attendees}
Call link: {meetingUrl}

Description:
{description}

People I keep notes on:
{people}

What Workhub knows about my current work:
{context}

Write a short prep brief:
1. The likely goals of this meeting.
2. Open items that matter here (pull requests, tickets, pending decisions).
3. Questions I should ask.

If this is a recurring stand-up, write a yesterday / today / blockers summary instead, based on the work above.`

const PLACEHOLDER = /\{(\w+)\}/g

/** Fills a template's known placeholders; unknown ones stay as typed. */
export function renderBriefTemplate(template: string, values: Partial<Record<BriefPlaceholder, string>>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => ((BRIEF_PLACEHOLDERS as readonly string[]).includes(name) ? (values[name as BriefPlaceholder] ?? '') : whole))
}

/** The placeholders a template uses that are not known (a typo such as `{titel}`). */
export function unknownPlaceholders(template: string): string[] {
  const out = new Set<string>()
  for (const m of template.matchAll(PLACEHOLDER)) if (!(BRIEF_PLACEHOLDERS as readonly string[]).includes(m[1]!)) out.add(m[1]!)
  return [...out]
}

/** One open pull request, as the brief context lists it. */
export interface BriefPullRequest {
  title: string
  url: string
  author?: string
  repo?: string
}

/** One ticket, as the brief context lists it. */
export interface BriefTicket {
  key: string
  title: string
  status: string
  assignee?: string
}

export interface BriefContextInput {
  /** The user's own open pull requests. */
  mine: readonly BriefPullRequest[]
  /** Pull requests waiting for the user's review (the ones by attendees count as involving them). */
  toReview?: readonly BriefPullRequest[]
  /** The user's tickets in progress. */
  tickets: readonly BriefTicket[]
  /** The people at the meeting (matched by email). */
  people: readonly Person[]
}

/** Items per list, and characters overall, the context may take. */
export const BRIEF_CONTEXT_LIMITS = { items: 10, chars: 4000 }

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/** Whether an item's author or assignee is this person (by a handle, or by name). */
function isPerson(person: Person, who: string | undefined): boolean {
  if (!who) return false
  const h = person.handles ?? {}
  return [h.github, h.jira, h.linear, h.slack, person.name].some((x) => same(x, who))
}

const prLine = (p: BriefPullRequest) => `- ${p.title}${p.repo ? ` [${p.repo}]` : ''} ${p.url}`
const ticketLine = (t: BriefTicket) => `- ${t.key} ${t.title} (${t.status})`

/**
 * What Workhub already knows, as plain text for `{context}`: the user's open pull requests and
 * tickets in progress, and for each person at the meeting the items that involve them. Capped.
 */
export function briefContext(input: BriefContextInput, limits = BRIEF_CONTEXT_LIMITS): string {
  const sections: string[] = []
  const cap = <T>(list: readonly T[]) => list.slice(0, limits.items)
  if (input.mine.length) sections.push(`My open pull requests (${input.mine.length}):\n${cap(input.mine).map(prLine).join('\n')}`)
  if (input.tickets.length) sections.push(`My tickets in progress (${input.tickets.length}):\n${cap(input.tickets).map(ticketLine).join('\n')}`)
  for (const person of input.people) {
    const prs = [...input.mine, ...(input.toReview ?? [])].filter((p) => isPerson(person, p.author))
    const tickets = input.tickets.filter((t) => isPerson(person, t.assignee))
    if (!prs.length && !tickets.length) continue
    sections.push(`Involving ${person.name}:\n${[...cap(prs).map(prLine), ...cap(tickets).map(ticketLine)].join('\n')}`)
  }
  const text = sections.join('\n\n') || 'Nothing known.'
  return text.length > limits.chars ? `${text.slice(0, limits.chars)}…` : text
}

/** The people at a meeting with their notes, one per line. */
export function describePeople(people: readonly Person[]): string {
  if (!people.length) return 'None.'
  return people.map((p) => `- ${p.name}${p.emails[0] ? ` <${p.emails[0]}>` : ''}${p.notes?.trim() ? `: ${p.notes.trim().replace(/\s+/g, ' ')}` : ''}`).join('\n')
}

/** The values of a brief's placeholders for an event. `formatTime` words an instant in the user's locale. */
export function briefValues(event: CalendarEvent, input: { people: readonly Person[]; context: string; formatTime: (ms: number) => string }): Record<BriefPlaceholder, string> {
  const attendees = event.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
  return {
    title: event.title || '(untitled)',
    start: input.formatTime(event.start),
    end: input.formatTime(event.end),
    attendees: attendees.length ? attendees.join(', ') : 'None listed.',
    description: event.description?.trim() || 'None.',
    meetingUrl: event.meetingUrl ?? 'None.',
    people: describePeople(peopleAt(event, input.people)),
    context: input.context
  }
}

/** A brief for no particular meeting ("Prepare 1:1" with nobody on the calendar): a placeholder event, one per person and day. */
export function genericOneOnOne(person: Person, now: number, calendarId = ''): CalendarEvent {
  const email = person.emails[0]?.trim().toLowerCase()
  return {
    id: `one-on-one:${person.id}|${startOfLocalDayAt(now)}`,
    uid: `one-on-one:${person.id}`,
    title: `1:1 with ${person.name}`,
    start: now,
    end: now + 30 * 60_000,
    allDay: false,
    attendees: email ? [{ name: person.name, email }] : [],
    calendarId,
    recurring: false
  }
}

/** Brief records of events that started less than `keepMs` ago (or have not started). */
export function pruneBriefs(briefs: Readonly<Record<string, BriefRecord>>, now: number, keepMs = FIRED_KEEP_MS): Record<string, BriefRecord> {
  return Object.fromEntries(Object.entries(briefs).filter(([, b]) => now - b.start < keepMs))
}
