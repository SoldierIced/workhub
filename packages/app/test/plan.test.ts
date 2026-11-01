import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  briefKey,
  DEFAULT_PLANNER_SETTINGS,
  emptyConfig,
  newAutomation,
  type CalendarEvent,
  type CalendarReadRequest,
  type CalendarReadResult,
  type CalendarSource,
  type CalendarState,
  type Connection,
  type DrivenSession,
  type PlannerSettings,
  type Profile,
  type SecretStore,
  type WorkhubConfig
} from '@workhub/core'
import { CalendarService, PLAN_MIN_GAP_MS } from '../src/main/calendar-service'
import { CalendarStateStore, CalendarWatcher } from '../src/main/calendar-watcher'
import { BriefService, type BriefServiceDeps } from '../src/main/plan-briefs'
import { meetingReminderWords } from '../src/main/plan-ipc'
import { StateFile } from '../src/main/state-file'
import { briefLabel, clampLead, clampRefresh, formToCalendar, formToPerson, formToRule, looksLikeCalendarUrl, personId, personToForm, ruleToForm, textToList } from '../src/renderer/lib/plan'
import type { StartSessionInput } from '../src/shared/api'

const NOW = Date.UTC(2026, 4, 12, 13, 0)
const MIN = 60_000

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `standup|${NOW + 30 * MIN}`,
  uid: 'standup',
  title: 'Standup',
  start: NOW + 30 * MIN,
  end: NOW + 45 * MIN,
  allDay: false,
  attendees: [{ email: 'ana@example.com' }, { email: 'bo@example.com' }],
  calendarId: 'cal',
  recurring: true,
  ...over
})

const calendar: Connection = { id: 'cal', kind: 'calendar', provider: 'ics', name: 'Work', secretRef: 'connection/cal', settings: {} }

const profile = (planner: Partial<PlannerSettings> = {}, on = true): Profile => ({
  id: 'work',
  name: 'Work',
  connections: {},
  accountIds: [],
  modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: on },
  planner: { ...DEFAULT_PLANNER_SETTINGS, calendarIds: ['cal'], ...planner }
})

const secrets = (values: Record<string, string>): SecretStore => ({
  get: async (ref) => values[ref] ?? null,
  set: async () => {},
  delete: async () => {},
  has: async (ref) => ref in values
})

function fakeSource(results: CalendarReadResult[]) {
  const reads: CalendarReadRequest[] = []
  const source: CalendarSource = {
    read: async (req) => {
      reads.push(req)
      return results[Math.min(reads.length - 1, results.length - 1)]!
    }
  }
  return { source, reads }
}

function calendarService(opts: { profile?: Profile; source: CalendarSource; secrets?: Record<string, string>; now?: () => number }) {
  const config: WorkhubConfig = { ...emptyConfig(), connections: [calendar], profiles: [opts.profile ?? profile()], activeProfileId: 'work' }
  return new CalendarService({ configuration: { current: async () => config } as never, secrets: secrets(opts.secrets ?? { 'connection/cal': 'https://calendar.example.com/private.ics' }), source: opts.source, demo: null, now: opts.now ?? (() => NOW) })
}

const memoryFile = () => {
  let saved: CalendarState | null = null
  return { file: { load: (fallback: CalendarState) => saved ?? fallback, save: (v: CalendarState) => (saved = v), flush: () => {} } as unknown as StateFile<CalendarState>, saved: () => saved }
}

describe('Plan renderer helpers', () => {
  it('turns typed lists into clean lists and back into forms', () => {
    expect(textToList(' a@x.com, b@x.com\nA@x.com,, a@x.com ')).toEqual(['a@x.com', 'b@x.com', 'A@x.com'])
    const person = formToPerson({ ...personToForm({ id: 'ana', name: 'Ana', emails: [] }), name: ' Ana ', emails: 'Ana@Example.com', github: ' ana-gh ', notes: '' })
    expect(person).toEqual({ id: 'ana', name: 'Ana', emails: ['ana@example.com'], handles: { github: 'ana-gh' } })
    expect(personId('Ana López', ['ana-lopez'])).toBe('ana-lopez-2')
  })

  it('keeps a rule through its form and clamps the numbers it allows', () => {
    const rule = { id: 'r1', name: 'Reviews', enabled: true, action: 'brief' as const, leadMinutes: 15, match: { titleContains: ['review'], minAttendees: 3 }, automationId: 'a1' }
    expect(formToRule(ruleToForm(rule))).toEqual(rule)
    expect([clampLead(-5), clampLead(1000), clampRefresh(1), clampRefresh(Number.NaN)]).toEqual([0, 240, 5, 5])
  })

  it('accepts only https or webcal calendar addresses and stores no address in the connection', () => {
    expect(looksLikeCalendarUrl('webcal://calendar.example.com/x.ics')).toBe(true)
    expect(looksLikeCalendarUrl('http://calendar.example.com/x.ics')).toBe(false)
    const c = formToCalendar({ id: null, name: ' Work ', ownerEmail: 'Ana@Example.com', secret: 'https://calendar.example.com/private.ics' }, 'cal')
    expect(c).toEqual({ id: 'cal', kind: 'calendar', provider: 'ics', name: 'Work', settings: { ownerEmail: 'ana@example.com' } })
    expect(JSON.stringify(c)).not.toContain('private.ics')
  })

  it('labels the brief control by where the brief is', () => {
    expect(briefLabel(undefined)).toBe('plan.brief.prepare')
    expect(briefLabel({ eventId: 'e', phase: 'ready', at: 0 })).toBe('plan.brief.ready')
    expect(briefLabel({ eventId: 'e', phase: 'failed', at: 0 })).toBe('plan.brief.retry')
  })
})

describe('CalendarService', () => {
  it('reports the module off and a profile without calendars', async () => {
    const { source } = fakeSource([{ ok: true, events: [] }])
    expect((await calendarService({ profile: profile({}, false), source }).view('work')).state).toBe('moduleOff')
    expect((await calendarService({ profile: profile({ calendarIds: [] }), source }).view('work')).state).toBe('noConnection')
  })

  it('reads with the stored address, caches for the refresh interval and rereads when forced after the gap', async () => {
    let now = NOW
    const { source, reads } = fakeSource([{ ok: true, events: [event()] }])
    const s = calendarService({ source, now: () => now })
    const first = await s.view('work')
    expect(first).toMatchObject({ state: 'ready', calendars: [{ id: 'cal', name: 'Work', ok: true, count: 1 }] })
    expect(reads[0]!.url).toBe('https://calendar.example.com/private.ics')
    await s.view('work', true)
    expect(reads).toHaveLength(1)
    now += PLAN_MIN_GAP_MS
    await s.view('work', true)
    expect(reads).toHaveLength(2)
    now += DEFAULT_PLANNER_SETTINGS.refreshMinutes * MIN
    await s.view('work')
    expect(reads).toHaveLength(3)
  })

  it('shares one read between callers asking at once', async () => {
    const { source, reads } = fakeSource([{ ok: true, events: [] }])
    const s = calendarService({ source })
    await Promise.all([s.read('work'), s.read('work'), s.read('work')])
    expect(reads).toHaveLength(1)
  })

  it('keeps the last good events of a calendar that fails, and never puts the address in the view', async () => {
    let now = NOW
    const { source } = fakeSource([{ ok: true, events: [event()] }, { ok: false, failure: 'unauthorized' }])
    const s = calendarService({ source, now: () => now })
    await s.view('work')
    now += DEFAULT_PLANNER_SETTINGS.refreshMinutes * MIN
    const view = await s.view('work')
    expect(view.state).toBe('error')
    expect(view.calendars[0]).toMatchObject({ ok: false, failure: 'unauthorized' })
    expect(view.events).toHaveLength(1)
    expect(JSON.stringify(view)).not.toContain('private.ics')
  })

  it('says noSecret for a calendar without a stored address', async () => {
    const { source, reads } = fakeSource([{ ok: true, events: [] }])
    const view = await calendarService({ source, secrets: {} }).view('work')
    expect(view.calendars[0]).toMatchObject({ ok: false, failure: 'noSecret' })
    expect(reads).toHaveLength(0)
  })

  it('tests a typed address and counts the upcoming events', async () => {
    const { source, reads } = fakeSource([{ ok: true, events: [event({ start: NOW - 60 * MIN }), event()] }])
    const r = await calendarService({ source }).test({ ...calendar, id: 'new', secretRef: undefined }, { action: 'set', value: 'https://calendar.example.com/other.ics' })
    expect(r).toEqual({ ok: true, total: 2, upcoming: 1 })
    expect(reads[0]!.url).toBe('https://calendar.example.com/other.ics')
  })
})

describe('CalendarWatcher', () => {
  it('fires each reminder once, persists it, and survives a restart without repeating', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-watch-'))
    const path = join(dir, 'calendar-state.json')
    let now = NOW + 21 * MIN // the default 10 min reminder of a meeting at +30 is due
    const reminded: string[] = []
    const make = () => {
      const store = new CalendarStateStore(new StateFile<CalendarState>(path, 0), () => now)
      return new CalendarWatcher({
        profiles: async () => [{ id: 'work' }],
        read: async () => ({ events: [event()], settings: DEFAULT_PLANNER_SETTINGS }),
        store,
        remind: (_p, a) => reminded.push(a.key),
        brief: async () => undefined,
        now: () => now
      })
    }
    const w = make()
    await w.tick()
    await w.tick()
    expect(reminded).toEqual([`remind|default|${event().id}`])
    w.stop()
    expect(Object.keys((JSON.parse(readFileSync(path, 'utf8')) as CalendarState).fired)).toEqual([`work|remind|default|${event().id}`])
    now += MIN
    await make().tick()
    expect(reminded).toHaveLength(1)
  })

  it('starts the brief of a matching brief rule once', async () => {
    const { file } = memoryFile()
    const briefs: string[] = []
    const settings: PlannerSettings = { ...DEFAULT_PLANNER_SETTINGS, reminderLeadMinutes: 0, rules: [{ id: 'b', name: 'Prep', enabled: true, action: 'brief', leadMinutes: 60, match: {} }] }
    const w = new CalendarWatcher({ profiles: async () => [{ id: 'work' }], read: async () => ({ events: [event()], settings }), store: new CalendarStateStore(file, () => NOW), remind: () => {}, brief: async (_p, a) => void briefs.push(a.ruleId), now: () => NOW })
    await w.tick()
    await w.tick()
    expect(briefs).toEqual(['b'])
  })
})

describe('BriefService', () => {
  function setup(opts: { gate?: string | null; template?: string; failStart?: boolean } = {}) {
    const started: StartSessionInput[] = []
    const delivered: string[] = []
    const live: DrivenSession[] = []
    const changed: string[] = []
    const automation = newAutomation('a1', { agentKey: 'claude', folder: '/w/acme', model: 'haiku' })
    const config: WorkhubConfig = { ...emptyConfig(), automations: [automation], profiles: [profile({ briefTemplate: opts.template ?? 'Brief for {title} with {attendees}. People: {people}', people: [{ id: 'ana', name: 'Ana', emails: ['ana@example.com'] }] })], activeProfileId: 'work' }
    let n = 0
    const deps: BriefServiceDeps = {
      config: async () => config,
      startSession: async (input) => {
        if (opts.failStart) throw new Error('no agent')
        started.push(input)
        const id = `s${++n}`
        live.push({ id, identity: `ident-${id}`, state: 'ready', turnsEnded: 0 })
        return { id } as never
      },
      sessions: { list: () => live, deliver: async (_id, text) => (delivered.push(text), 'delivered') },
      store: new CalendarStateStore(memoryFile().file, () => NOW),
      gate: () => opts.gate ?? null,
      context: async () => ({ mine: [], tickets: [] }),
      formatTime: () => '13:30',
      resolveFolder: async (f) => f,
      home: '/home/test',
      changed: (p) => changed.push(p),
      resumes: () => true,
      now: () => NOW,
      wait: async () => {}
    }
    return { service: new BriefService(deps), started, delivered, live, changed, deps }
  }

  it('starts a session with the rule automation, fills the template and records the brief', async () => {
    const { service, started, delivered, deps } = setup()
    const r = await service.brief('work', event(), { ruleId: 'b', automationId: 'a1' })
    expect(r).toEqual({ ok: true, sessionId: 's1', existing: false })
    expect(started[0]).toMatchObject({ profileId: 'work', agentKey: 'claude', cwd: '/w/acme', model: 'haiku', mode: 'app' })
    expect(delivered).toEqual(['Brief for Standup with ana@example.com, bo@example.com. People: - Ana <ana@example.com>'])
    expect(deps.store.get().briefs[briefKey('work', event().id)]).toMatchObject({ status: 'started', sessionId: 's1', identity: 'ident-s1', ruleId: 'b' })
    expect(service.views('work')[event().id]).toMatchObject({ phase: 'preparing', sessionId: 's1' })
  })

  it('never starts the same brief twice: a second ask opens the first session, even while it starts', async () => {
    const { service, started } = setup()
    const [a, b] = await Promise.all([service.brief('work', event(), { automationId: 'a1' }), service.brief('work', event(), { automationId: 'a1' })])
    expect(a.ok).toBe(true)
    expect(b).toEqual({ ok: false, error: 'The brief is starting' })
    expect(await service.brief('work', event(), { automationId: 'a1' })).toEqual({ ok: true, sessionId: 's1', existing: true })
    expect(started).toHaveLength(1)
  })

  it('reopens a closed brief under its identity instead of starting a new one', async () => {
    const { service, started, live } = setup()
    await service.brief('work', event(), { automationId: 'a1' })
    live.splice(0, live.length)
    const r = await service.brief('work', event(), { automationId: 'a1' })
    expect(r).toEqual({ ok: true, sessionId: 's2', existing: true })
    expect(started[1]).toMatchObject({ resumeAgentSessionId: 'ident-s1' })
  })

  it('records a failed brief when a usage guard blocks it, and lets it be retried', async () => {
    const { service, started, deps } = setup({ gate: 'usage ceiling reached' })
    expect(await service.brief('work', event(), { ruleId: 'b', automationId: 'a1' })).toEqual({ ok: false, error: 'usage ceiling reached' })
    expect(started).toHaveLength(0)
    expect(service.views('work')[event().id]).toMatchObject({ phase: 'failed', error: 'usage ceiling reached' })
    deps.gate = () => null
    expect((await service.brief('work', event(), { automationId: 'a1' })).ok).toBe(true)
  })

  it('prepares a 1:1 for the next meeting with the person, else a generic one', async () => {
    const { service, delivered } = setup({ template: '{title}' })
    expect((await service.oneOnOne('work', 'ana', [event({ attendees: [{ email: 'bo@example.com' }] }), event({ id: 'sync|1', title: 'Sync with Ana' })])).ok).toBe(true)
    expect((await service.oneOnOne('work', 'ana', [])).ok).toBe(true)
    expect(delivered).toEqual(['Sync with Ana', '1:1 with Ana'])
    expect(await service.oneOnOne('work', 'nobody', [])).toEqual({ ok: false, error: 'This person is no longer in the list' })
  })
})

describe('meeting reminder words', () => {
  const text = { t: (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`, time: () => '13:30' }

  it('says how soon, where, or the rule message', () => {
    expect(meetingReminderWords({ event: event({ location: 'Room 2' }) }, NOW + 20 * MIN, text as never)).toEqual({ title: 'notify.meeting.soon{"title":"Standup","minutes":10}', body: '13:30 · Room 2' })
    expect(meetingReminderWords({ event: event({ meetingUrl: 'https://meet.example.com/x' }) }, NOW + 30 * MIN, text as never)).toEqual({ title: 'notify.meeting.now{"title":"Standup"}', body: '13:30 · notify.meeting.call' })
    expect(meetingReminderWords({ event: event({ title: '' }), message: 'Bring the numbers' }, NOW, text as never).body).toBe('Bring the numbers')
  })
})
