// Types of the Plan bridge (window.hub.plan), shared by main, preload and renderer.
import type { CalendarEvent, CalendarFailure, Connection, Person, SecretChange } from '@workhub/core'

/**
 * - ready: the profile's calendars were read (some may have failed: see `calendars`).
 * - demo: synthetic meetings (WORKHUB_DEMO_CALENDAR=1), no calendar address needed.
 * - moduleOff: the profile has the Plan module turned off.
 * - noConnection: the profile reads no calendar yet.
 * - error: every calendar of the profile failed.
 */
export type PlanState = 'ready' | 'demo' | 'moduleOff' | 'noConnection' | 'error'

/** Why one calendar could not be read: a read failure, or no stored address. */
export type PlanCalendarFailure = CalendarFailure | 'noSecret'

export interface PlanCalendarStatus {
  id: string
  name: string
  ok: boolean
  failure?: PlanCalendarFailure
  /** The host's answer or the network error, worded without the address. */
  detail?: string
  /** Events read in the window. */
  count?: number
}

/**
 * A brief for one event:
 * - preparing: its session is starting or working on the brief.
 * - ready: the session finished its turn: the brief is there to read.
 * - closed: the session is no longer open; opening it resumes it.
 * - failed: it could not start (`error` says why); "Prepare brief" tries again.
 */
export type PlanBriefPhase = 'preparing' | 'ready' | 'closed' | 'failed'

export interface PlanBrief {
  eventId: string
  phase: PlanBriefPhase
  sessionId?: string
  error?: string
  /** Epoch ms it was started. */
  at: number
}

export interface PlanView {
  state: PlanState
  /** Events from a day ago to two weeks ahead, sorted by start. */
  events: CalendarEvent[]
  calendars: PlanCalendarStatus[]
  /** Briefs by event id. */
  briefs: Record<string, PlanBrief>
  people: Person[]
  refreshMinutes: number
  /** Epoch ms of the last read. */
  updatedAt?: number
}

export type CalendarTestResult = { ok: true; total: number; upcoming: number } | { ok: false; failure: PlanCalendarFailure; detail?: string }

/** A brief started or opened: the session to show, or why there is none. */
export type BriefResult = { ok: true; sessionId: string; existing: boolean } | { ok: false; error: string }

export interface PlanApi {
  /** The profile's agenda; the calendars are read again when their interval passed or `force` is set (never more than every 30 s). */
  get(profileId: string | null, force?: boolean): Promise<PlanView>
  /** Checks a calendar connection as typed in the form: fetches, parses and counts the upcoming events. */
  test(connection: Connection, secret: SecretChange): Promise<CalendarTestResult>
  /** Starts the brief of an event, or opens the one already started (a brief never starts twice). */
  brief(profileId: string, eventId: string): Promise<BriefResult>
  /** "Prepare 1:1": the brief of the next meeting with this person, or a generic one when there is none. */
  oneOnOne(profileId: string, personId: string): Promise<BriefResult>
  /** Fires when a profile's agenda or briefs changed. */
  onChanged(cb: (profileId: string) => void): () => void
  /** Fires when a reminder without a call link was clicked: the Plan screen should come up. */
  onFocus(cb: () => void): () => void
}
