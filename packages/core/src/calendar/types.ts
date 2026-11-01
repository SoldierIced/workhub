import type { InboxSettings } from '../inbox/types'
import type { AgentMilestoneMode } from '../milestones'

/**
 * The Plan module (optional, per profile): calendar events read from private ICS addresses,
 * reminders, meeting briefs prepared by an agent and the people the user meets. Everything here is
 * data a profile configures; nothing assumes one role or workflow.
 */

/** How an attendee answered the invitation (the ICS `PARTSTAT`). */
export type AttendeeStatus = 'accepted' | 'declined' | 'tentative' | 'needsAction' | 'delegated'

export interface CalendarAttendee {
  /** The `CN` parameter, when the calendar sends one. */
  name?: string
  /** Lower case; the `mailto:` address. */
  email: string
  status?: AttendeeStatus
}

/** One occurrence of a calendar event (a recurring event gives one per instance). */
export interface CalendarEvent {
  /** `<uid>|<instance start>`: stable for an instance, even when that instance was moved. */
  id: string
  uid: string
  title: string
  /** Epoch milliseconds. */
  start: number
  end: number
  /** An all-day event: `start` is local midnight of its first day. */
  allDay: boolean
  location?: string
  url?: string
  /** A video call link found in the location, URL or description (Meet, Zoom, Teams…). */
  meetingUrl?: string
  attendees: CalendarAttendee[]
  organizer?: CalendarAttendee
  /** Plain text, truncated (`MAX_DESCRIPTION_CHARS`). */
  description?: string
  /** The calendar connection it was read from. */
  calendarId: string
  /** Part of a recurring series (an expanded `RRULE` instance or a moved one). */
  recurring: boolean
}

/** A meeting rule: when it matches an event, it reminds or starts a brief `leadMinutes` before. */
export interface MeetingRule {
  id: string
  name: string
  enabled: boolean
  /** Every condition set must hold; an empty match takes every timed event. */
  match: MeetingRuleMatch
  action: 'remind' | 'brief'
  /** Minutes before the start; 0 fires at the start. */
  leadMinutes: number
  /** A reminder's own text instead of the event's time and place. */
  message?: string
  /** A brief run with this automation's agent, folder and model instead of the profile's defaults. */
  automationId?: string
}

export interface MeetingRuleMatch {
  /** Any of these words in the title (case-insensitive). */
  titleContains?: string[]
  /** A regular expression over the title (case-insensitive); an invalid one never matches. */
  titleRegex?: string
  /** Any of these addresses among the attendees or the organizer. */
  attendeeEmails?: string[]
  /** At least this many attendees. */
  minAttendees?: number
  /** Only events of a recurring series. */
  recurringOnly?: boolean
}

/** Someone the user meets: matched to attendees by email. */
export interface Person {
  id: string
  name: string
  emails: string[]
  /** Their names on other services, so Workhub can find the items that involve them. */
  handles?: { github?: string; jira?: string; linear?: string; slack?: string }
  notes?: string
}

/** A profile's Plan setup (Settings → Plan). */
export interface PlannerSettings {
  /** The calendar connections this profile reads (any number). */
  calendarIds: string[]
  /** How often the calendars are read again, in minutes. */
  refreshMinutes: number
  /** A reminder this many minutes before every timed event; 0 turns the default reminder off. */
  reminderLeadMinutes: number
  rules: MeetingRule[]
  /** The brief prompt; empty uses `DEFAULT_BRIEF_TEMPLATE`. */
  briefTemplate: string
  people: Person[]
  /** The inbox: areas, criticality levels and where approved items become issues (see `inboxSettings`). */
  inbox?: InboxSettings
  /** A milestone is at risk when its progress is this many points behind the time gone (default 10). */
  milestoneMargin?: number
  /** Whether an agent's milestone changes wait for the user (`ask`, the default) or apply at once (`allow`). */
  agentMilestones?: AgentMilestoneMode
}

export const DEFAULT_PLANNER_REFRESH_MINUTES = 15
export const MIN_PLANNER_REFRESH_MINUTES = 5
export const MAX_PLANNER_REFRESH_MINUTES = 240
export const DEFAULT_REMINDER_LEAD_MINUTES = 10
export const MAX_LEAD_MINUTES = 240
export const MAX_DESCRIPTION_CHARS = 2000

export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  calendarIds: [],
  refreshMinutes: DEFAULT_PLANNER_REFRESH_MINUTES,
  reminderLeadMinutes: DEFAULT_REMINDER_LEAD_MINUTES,
  rules: [],
  briefTemplate: '',
  people: []
}

/** A profile's Plan setup with the defaults filled in. */
export function plannerSettings(profile: { planner?: Partial<PlannerSettings> } | null | undefined): PlannerSettings {
  return { ...DEFAULT_PLANNER_SETTINGS, ...profile?.planner }
}

/** Keys of a calendar connection's `settings`. The ICS address itself is the secret, never a setting. */
export const CALENDAR_CONNECTION_SETTINGS = {
  /** The calendar owner's address: events this address declined are left out. */
  ownerEmail: 'ownerEmail'
} as const

export type CalendarFailure = 'unreachable' | 'unauthorized' | 'notCalendar' | 'tooLarge'

export type CalendarReadResult = { ok: true; events: CalendarEvent[] } | { ok: false; failure: CalendarFailure; detail?: string }

/** What is read: one calendar's private address, over a window of time. */
export interface CalendarReadRequest {
  /** The private ICS address (a secret: never logged, never shown back). */
  url: string
  calendarId: string
  ownerEmail?: string
  window: { from: number; to: number }
}

/** Port: reads one calendar. Never throws; a failure says why. */
export interface CalendarSource {
  read(request: CalendarReadRequest): Promise<CalendarReadResult>
}

/** A brief started for one event instance, kept so it is never started twice. */
export interface BriefRecord {
  profileId: string
  eventId: string
  title: string
  start: number
  /** Epoch ms of the start. */
  at: number
  /** The rule that started it; absent for "Prepare brief" and "Prepare 1:1". */
  ruleId?: string
  status: 'starting' | 'started' | 'failed'
  /** The session (its id in the session list while it runs) and its stable identity. */
  sessionId?: string
  identity?: string
  /** The agent and folder it ran with, so a closed session can be resumed. */
  agentKey?: string
  cwd?: string
  error?: string
}

/** What the Plan watcher keeps between launches (`calendar-state.json`). */
export interface CalendarState {
  /** Reminder and rule keys already fired, with when. */
  fired: Record<string, number>
  /** Briefs by `briefKey(profileId, eventId)`. */
  briefs: Record<string, BriefRecord>
}

export const EMPTY_CALENDAR_STATE: CalendarState = { fired: {}, briefs: {} }

export function briefKey(profileId: string, eventId: string): string {
  return `${profileId}|${eventId}`
}
