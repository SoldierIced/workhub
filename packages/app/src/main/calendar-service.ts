import { createHash } from 'node:crypto'
import {
  calendarWindow,
  CALENDAR_CONNECTION_SETTINGS,
  mergeCalendars,
  moduleScreens,
  plannerSettings,
  secretForConnectionTest,
  type CalendarEvent,
  type CalendarReadResult,
  type CalendarSource,
  type ConfigurationService,
  type Connection,
  type PlannerSettings,
  type Profile,
  type SecretChange,
  type SecretStore
} from '@workhub/core'
import type { CalendarTestResult, PlanCalendarStatus, PlanState, PlanView } from '../shared/plan-api'

/** The least time between two real reads of a profile's calendars, however often the screen asks. */
export const PLAN_MIN_GAP_MS = 30_000
/** A read where every calendar failed may be retried this soon. */
export const PLAN_RETRY_GAP_MS = 5_000
/** The calendar id the demo serves under. */
export const DEMO_CALENDAR_ID = 'demo-calendar'

/** What one profile's calendars gave, with the setup it was read for. */
export interface CalendarRead {
  profile: Profile
  settings: PlannerSettings
  state: PlanState
  events: CalendarEvent[]
  calendars: PlanCalendarStatus[]
  updatedAt?: number
}

interface Cached {
  key: string
  at: number
  events: CalendarEvent[]
  calendars: PlanCalendarStatus[]
}

export interface CalendarServiceDeps {
  configuration: ConfigurationService
  secrets: SecretStore
  source: CalendarSource
  /** WORKHUB_DEMO_CALENDAR=1: synthetic meetings instead of the profile's calendars. */
  demo: CalendarSource | null
  now?: () => number
}

/**
 * Reads each profile's calendars (Settings → Plan), keeps what they gave for the profile's refresh
 * interval and shares one read between callers asking at once. The private addresses are read from
 * the secret store for each read and never leave the main process.
 */
export class CalendarService {
  private readonly cache = new Map<string, Cached>()
  private readonly inflight = new Map<string, Promise<CalendarRead | null>>()
  private readonly now: () => number

  constructor(private readonly deps: CalendarServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  /** The profile (the active one for null) with its Plan setup; null when there is no such profile. */
  async profileOf(profileId: string | null): Promise<Profile | null> {
    const config = await this.deps.configuration.current()
    return config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId)) ?? null
  }

  /** The profiles with the Plan module on. */
  async plannerProfiles(): Promise<Profile[]> {
    return (await this.deps.configuration.current()).profiles.filter((p) => moduleScreens(p.modules).includes('planner'))
  }

  /** The profile's events, read again when due (or forced, at most every 30 s). Null without a profile. */
  async read(profileId: string | null, force = false): Promise<CalendarRead | null> {
    const key = profileId ?? ''
    const running = this.inflight.get(key)
    if (running) return running
    const run = this.load(profileId, force).finally(() => this.inflight.delete(key))
    this.inflight.set(key, run)
    return run
  }

  /** The Plan screen's view, without briefs (the brief service adds them). */
  async view(profileId: string | null, force = false): Promise<Omit<PlanView, 'briefs'>> {
    const r = await this.read(profileId, force)
    const settings = r?.settings ?? plannerSettings(undefined)
    return { state: r?.state ?? 'moduleOff', events: r?.events ?? [], calendars: r?.calendars ?? [], people: settings.people, refreshMinutes: settings.refreshMinutes, ...(r?.updatedAt ? { updatedAt: r.updatedAt } : {}) }
  }

  private async load(profileId: string | null, force: boolean): Promise<CalendarRead | null> {
    const config = await this.deps.configuration.current()
    const profile = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId))
    if (!profile) return null
    const settings = plannerSettings(profile)
    const base = { profile, settings }
    if (!moduleScreens(profile.modules).includes('planner')) return { ...base, state: 'moduleOff', events: [], calendars: [] }

    const connections = this.deps.demo ? [] : settings.calendarIds.map((id) => config.connections.find((c) => c.id === id && c.kind === 'calendar')).filter((c): c is Connection => c !== undefined)
    if (!this.deps.demo && connections.length === 0) return { ...base, state: 'noConnection', events: [], calendars: [] }

    const secrets = await Promise.all(connections.map((c) => (c.secretRef ? this.deps.secrets.get(c.secretRef) : Promise.resolve(null))))
    // Anything that changes what is read (calendars, owner, addresses) drops the old events.
    const key = JSON.stringify([
      this.deps.demo ? 'demo' : '',
      connections.map((c, i) => [c.id, c.settings[CALENDAR_CONNECTION_SETTINGS.ownerEmail] ?? '', createHash('sha256').update(secrets[i] ?? '').digest('hex')])
    ])
    let cached = this.cache.get(profile.id)
    if (!cached || cached.key !== key) {
      cached = { key, at: 0, events: [], calendars: [] }
      this.cache.set(profile.id, cached)
    }
    const age = this.now() - cached.at
    const failed = cached.calendars.length > 0 && cached.calendars.every((c) => !c.ok)
    const floor = failed ? PLAN_RETRY_GAP_MS : PLAN_MIN_GAP_MS
    const due = cached.at === 0 || age >= settings.refreshMinutes * 60_000 || (force && age >= floor)
    if (due) {
      const now = this.now()
      const window = calendarWindow(now)
      if (this.deps.demo) {
        const r = await this.deps.demo.read({ url: '', calendarId: DEMO_CALENDAR_ID, window })
        cached.events = r.ok ? r.events : []
        cached.calendars = [{ id: DEMO_CALENDAR_ID, name: 'Demo calendar', ok: r.ok, count: r.ok ? r.events.length : 0 }]
      } else {
        const results = await Promise.all(
          connections.map(async (c, i): Promise<{ status: PlanCalendarStatus; events: CalendarEvent[] }> => {
            const name = c.name || c.id
            const url = secrets[i]
            if (!url) return { status: { id: c.id, name, ok: false, failure: 'noSecret' }, events: [] }
            const ownerEmail = c.settings[CALENDAR_CONNECTION_SETTINGS.ownerEmail]?.trim()
            const r = await this.deps.source.read({ url, calendarId: c.id, window, ...(ownerEmail ? { ownerEmail } : {}) }).catch((): CalendarReadResult => ({ ok: false, failure: 'unreachable' }))
            if (!r.ok) {
              // A calendar that failed keeps what its last good read found.
              const previous = cached!.events.filter((e) => e.calendarId === c.id)
              return { status: { id: c.id, name, ok: false, failure: r.failure, ...(r.detail ? { detail: r.detail } : {}) }, events: previous }
            }
            return { status: { id: c.id, name, ok: true, count: r.events.length }, events: r.events }
          })
        )
        cached.events = mergeCalendars(results.map((r) => r.events))
        cached.calendars = results.map((r) => r.status)
      }
      cached.at = now
    }
    const state: PlanState = this.deps.demo ? 'demo' : cached.calendars.every((c) => !c.ok) ? 'error' : 'ready'
    return { ...base, state, events: cached.events, calendars: cached.calendars, updatedAt: cached.at }
  }

  /** Checks a calendar connection as typed in the form: the typed address, or the stored one for that connection. */
  async test(connection: Connection, change: SecretChange): Promise<CalendarTestResult> {
    const now = this.now()
    const window = calendarWindow(now)
    if (this.deps.demo) {
      const r = await this.deps.demo.read({ url: '', calendarId: DEMO_CALENDAR_ID, window })
      return r.ok ? { ok: true, total: r.events.length, upcoming: r.events.filter((e) => e.start >= now).length } : { ok: false, failure: r.failure }
    }
    const resolved = await secretForConnectionTest(await this.deps.configuration.current(), this.deps.secrets, connection, change)
    if (!resolved.ok) return { ok: false, failure: 'noSecret', detail: resolved.error }
    if (!resolved.secret) return { ok: false, failure: 'noSecret' }
    const ownerEmail = connection.settings?.[CALENDAR_CONNECTION_SETTINGS.ownerEmail]?.trim()
    const r = await this.deps.source.read({ url: resolved.secret, calendarId: connection.id, window, ...(ownerEmail ? { ownerEmail } : {}) })
    if (!r.ok) return { ok: false, failure: r.failure, ...(r.detail ? { detail: r.detail } : {}) }
    return { ok: true, total: r.events.length, upcoming: r.events.filter((e) => e.start >= now).length }
  }

  /** Forgets a profile's events (its setup changed), so the next ask reads again. */
  invalidate(profileId: string): void {
    this.cache.delete(profileId)
  }
}
