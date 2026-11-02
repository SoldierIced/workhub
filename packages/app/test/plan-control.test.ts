import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DemoTracker } from '@workhub/adapters/tracker-demo'
import { DEFAULT_PLANNER_SETTINGS, INBOX_LIMITS, type CalendarEvent, type Profile } from '@workhub/core'
import { controlSocketPath, startControlServer } from '../src/main/control-server'
import { CONTROL_INBOX_LIMIT, CONTROL_NOTE_MAX, createPlanControl, parseInboxQuery, parseInboxUpdate, resolveControlProfile, todayAnswer } from '../src/main/plan-control'
import { PlannerService, type PlannerState } from '../src/main/planner-service'
import type { PlanView } from '../src/shared/plan-api'

// Friday 2026-11-06, noon local time.
const NOW = new Date(2026, 10, 6, 12).getTime()
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime()

const profile = (id = 'work', on = true): Profile => ({
  id,
  name: id,
  connections: {},
  accountIds: [],
  modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: on },
  planner: { ...DEFAULT_PLANNER_SETTINGS, people: [{ id: 'ana', name: 'Ana Costa', emails: ['ana@example.com'], handles: { github: 'ana-gh' }, notes: 'Owns checkout; private notes' }] }
})

const event = (id: string, start: number, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  uid: id,
  title: `Meeting ${id}`,
  start,
  end: start + 30 * 60_000,
  allDay: false,
  attendees: [{ name: 'Ana Costa', email: 'ana@example.com', status: 'accepted' }],
  calendarId: 'cal',
  recurring: false,
  ...over
})

const view = (over: Partial<PlanView> = {}): PlanView => ({ state: 'ready', events: [], calendars: [{ id: 'cal', name: 'Work', ok: true, count: 0 }], briefs: {}, people: [], refreshMinutes: 15, ...over })

function setup(profiles: Profile[] = [profile(), profile('home', false)], agenda: PlanView = view()) {
  const changed: string[] = []
  let n = 0
  const planner = new PlannerService({
    profiles: async () => profiles,
    store: { load: (fallback: PlannerState) => fallback, save: () => undefined },
    tracker: async () => ({ tracker: new DemoTracker() }),
    changed: (p) => void changed.push(p),
    now: () => NOW,
    newId: () => `id${++n}`
  })
  const control = createPlanControl({
    planner,
    agenda: async () => agenda,
    profile: async (id) => profiles.find((p) => p.id === id),
    sessionProfile: (id) => ({ s1: 'work', s2: 'home', s3: null })[id as 's1'],
    profiles: async () => ({ ids: profiles.map((p) => p.id), active: 'work' }),
    now: () => NOW
  })
  return { planner, control, changed }
}

const q = (s = '') => new URLSearchParams(s)

describe('resolveControlProfile', () => {
  const deps = { sessionProfile: (id: string) => ({ s1: 'work', s3: null })[id as 's1'], profiles: async () => ({ ids: ['work', 'home'], active: 'home' }) }
  it("takes the session's profile, else the named one, else the active one", async () => {
    expect(await resolveControlProfile(deps, { session: 's1', profile: 'home' })).toEqual({ ok: true, profileId: 'work', session: 's1' })
    expect(await resolveControlProfile(deps, { session: 's3', profile: 'work' })).toEqual({ ok: true, profileId: 'work', session: 's3' })
    expect(await resolveControlProfile(deps, { profile: 'work' })).toEqual({ ok: true, profileId: 'work', session: null })
    expect(await resolveControlProfile(deps, {})).toEqual({ ok: true, profileId: 'home', session: null })
    expect(await resolveControlProfile(deps, { session: 'zz' })).toEqual({ ok: false, status: 404, error: 'unknown session' })
    expect(await resolveControlProfile(deps, { profile: 'nope' })).toEqual({ ok: false, status: 404, error: 'unknown profile' })
    expect(await resolveControlProfile({ ...deps, profiles: async () => ({ ids: [], active: null }) }, {})).toEqual({ ok: false, status: 409, error: 'no profile' })
  })
})

describe('Plan control parsers', () => {
  it('checks inbox filters and caps the limit', () => {
    expect(parseInboxQuery(q())).toEqual({ status: 'open', limit: CONTROL_INBOX_LIMIT.default })
    expect(parseInboxQuery(q('status=local&kind=bug&area=Backend&q=crash&limit=5000'))).toEqual({ status: 'local', kind: 'bug', area: 'Backend', q: 'crash', limit: CONTROL_INBOX_LIMIT.max })
    expect(parseInboxQuery(q('status=closed'))).toMatch(/"status"/)
    expect(parseInboxQuery(q('kind=epic'))).toMatch(/"kind"/)
    expect(parseInboxQuery(q('limit=0'))).toMatch(/"limit"/)
    expect(parseInboxQuery(q('limit=abc'))).toMatch(/"limit"/)
    expect(parseInboxQuery(q(`q=${'x'.repeat(201)}`))).toMatch(/"q"/)
  })

  it('checks an item update field by field and never accepts the tracker', () => {
    expect(parseInboxUpdate({ status: 'done', due: '2026-11-10', area: ' Backend ', criticality: null, note: ' Fixed in the branch ' })).toEqual({ status: 'done', due: '2026-11-10', area: 'Backend', criticality: null, note: 'Fixed in the branch' })
    expect(parseInboxUpdate({ due: null, area: '' })).toEqual({ due: null, area: null })
    expect(parseInboxUpdate({ status: 'ticket' })).toMatch(/approving to the tracker/)
    expect(parseInboxUpdate({ status: 'approve' })).toMatch(/"status"/)
    expect(parseInboxUpdate({ due: '10/11/2026' })).toMatch(/"due"/)
    expect(parseInboxUpdate({ area: 'x'.repeat(201) })).toMatch(/"area"/)
    expect(parseInboxUpdate({ note: 'x'.repeat(CONTROL_NOTE_MAX + 1) })).toMatch(/"note"/)
    expect(parseInboxUpdate({ title: 'renamed' })).toMatch(/nothing to change/)
    expect(parseInboxUpdate([])).toMatch(/JSON object/)
  })
})

describe('GET /v1/plan/today', () => {
  it("lists today's and tomorrow's events with attendees, call link and brief", () => {
    const events = [
      event('yesterday', at(5, 10)),
      event('today', at(6, 9), { meetingUrl: 'https://meet.example.com/abc', description: 'd'.repeat(2000), organizer: { email: 'lead@example.com' } }),
      event('tomorrow', at(7, 23)),
      event('later', at(8, 9))
    ]
    const answer = todayAnswer(view({ events, briefs: { today: { eventId: 'today', phase: 'ready', sessionId: 'brief-1', at: NOW } } }), NOW)
    const listed = answer['events'] as Record<string, unknown>[]
    expect(listed.map((e) => e['id'])).toEqual(['today', 'tomorrow'])
    expect(listed[0]).toMatchObject({
      title: 'Meeting today',
      start: new Date(at(6, 9)).toISOString(),
      meetingUrl: 'https://meet.example.com/abc',
      organizer: { email: 'lead@example.com' },
      attendees: [{ name: 'Ana Costa', email: 'ana@example.com', status: 'accepted' }],
      brief: { phase: 'ready', sessionId: 'brief-1' }
    })
    expect((listed[0]!['description'] as string).length).toBeLessThanOrEqual(500)
    expect(answer).toMatchObject({ ok: true, state: 'ready', calendars: [{ name: 'Work', ok: true }] })
    expect(answer['reason']).toBeUndefined()
  })

  it('answers empty with a reason when Plan is off or there is no calendar', async () => {
    const off = setup(undefined, view({ state: 'moduleOff', calendars: [] }))
    expect((await off.control.today(q('session=s2'))).body).toMatchObject({ ok: true, state: 'moduleOff', reason: 'Plan is off in this profile', events: [] })
    const none = setup(undefined, view({ state: 'noConnection', calendars: [] }))
    expect((await none.control.today(q())).body).toMatchObject({ state: 'noConnection', reason: expect.stringMatching(/No calendar/), events: [] })
    expect((await none.control.today(q('session=zz'))).status).toBe(404)
  })
})

describe('GET and PATCH /v1/inbox', () => {
  it('lists open items first with people by name, filters and caps', async () => {
    const { planner, control } = setup()
    await planner.propose('work', [{ kind: 'task', title: 'Send the rollout plan', detail: 'x'.repeat(3000), people: ['ana@example.com'] }, { kind: 'bug', title: 'Crash on save', detail: '' }, { kind: 'decision', title: 'Use cursor pagination', detail: '' }], { type: 'agent' })
    await planner.updateItem('work', 'id2', { status: 'local' })
    await planner.updateItem('work', 'id3', { status: 'discarded' })
    const open = (await control.inbox(q('session=s1'))).body
    expect(open).toMatchObject({ ok: true, enabled: true, total: 2 })
    const items = open['items'] as Record<string, unknown>[]
    expect(items.map((i) => i['id'])).toEqual(['id1', 'id2'])
    expect(items[0]).toMatchObject({ kind: 'task', status: 'pending', people: ['Ana Costa'], source: { type: 'agent' } })
    expect((items[0]!['detail'] as string).length).toBeLessThanOrEqual(1000)
    expect(((await control.inbox(q('status=all'))).body['items'] as unknown[]).length).toBe(3)
    expect((await control.inbox(q('status=discarded'))).body).toMatchObject({ total: 1, items: [{ id: 'id3' }] })
    expect((await control.inbox(q('kind=bug'))).body).toMatchObject({ total: 1, items: [{ id: 'id2' }] })
    expect((await control.inbox(q('q=rollout'))).body).toMatchObject({ total: 1, items: [{ id: 'id1' }] })
    expect((await control.inbox(q('status=all&limit=1'))).body).toMatchObject({ total: 3, truncated: true })
    expect((await control.inbox(q('status=nope'))).status).toBe(400)
    expect((await control.inbox(q('session=s2'))).body).toEqual({ ok: true, enabled: false, reason: 'Plan is off in this profile', items: [], total: 0 })
  })

  it('moves an item, sets fields and appends a note, telling the UI', async () => {
    const { planner, control, changed } = setup()
    await planner.propose('work', [{ kind: 'task', title: 'Write the docs', detail: 'First draft' }], { type: 'agent' })
    changed.length = 0
    const r = await control.updateItem('id1', { session: 's1', status: 'local', due: '2026-11-10', area: 'Docs', note: 'Started in the branch' }, q())
    expect(r).toMatchObject({ status: 200, body: { ok: true, item: { id: 'id1', status: 'local', due: '2026-11-10', area: 'Docs', detail: 'First draft\n\nStarted in the branch' } } })
    expect(changed).toEqual(['work'])
    expect((await control.updateItem('id1', { status: 'done', due: null }, q('session=s1'))).body).toMatchObject({ item: { status: 'done', closedAt: new Date(NOW).toISOString() } })
    expect((await planner.view('work')).inbox[0]).not.toHaveProperty('due')
  })

  it('refuses unknown items, moves with no local path, full details and Plan off', async () => {
    const { planner, control } = setup()
    await planner.propose('work', [{ kind: 'decision', title: 'Use cursor pagination', detail: 'x'.repeat(INBOX_LIMITS.detail - 10) }], { type: 'agent' })
    expect((await control.updateItem('nope', { status: 'done' }, q())).status).toBe(404)
    expect(await control.updateItem('id1', { status: 'done' }, q())).toMatchObject({ status: 409, body: { ok: false, error: expect.stringMatching(/pending → done/) } })
    expect(await control.updateItem('id1', { note: 'a long enough note' }, q())).toMatchObject({ status: 400, body: { error: expect.stringMatching(/longer than/) } })
    expect((await control.updateItem('id1', { status: 'done' }, q('session=s2'))).status).toBe(409)
    expect((await control.updateItem('id1', { status: 'ticket' }, q())).status).toBe(400)
    expect((await control.updateItem('bad id', { status: 'done' }, q())).status).toBe(400)
    expect((await planner.view('work')).inbox[0]!.status).toBe('pending')
  })
})

describe('GET /v1/milestones and /v1/people', () => {
  it('lists milestones with status, progress and time gone', async () => {
    const { planner, control } = setup()
    await planner.saveMilestone('work', { id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual', progress: 30 } })
    expect((await control.milestones(q('session=s1'))).body).toEqual({
      ok: true,
      enabled: true,
      today: '2026-11-06',
      agentChanges: 'ask',
      pending: [],
      milestones: [{ id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11', status: 'atRisk', progress: 30, elapsed: 50, source: 'manual' }]
    })
    expect((await control.milestones(q('session=s2'))).body).toMatchObject({ enabled: false, milestones: [] })
  })

  it('lists people without their notes', async () => {
    const { control } = setup()
    const body = (await control.people(q())).body
    expect(body).toEqual({ ok: true, enabled: true, people: [{ id: 'ana', name: 'Ana Costa', emails: ['ana@example.com'], handles: { github: 'ana-gh' } }] })
    expect(JSON.stringify(body)).not.toContain('private notes')
    expect((await control.people(q('profile=home'))).body).toMatchObject({ enabled: false, people: [] })
  })
})

describe('milestone changes by agents', () => {
  const beta = { id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual' as const, progress: 30 } }
  const allowing = () => {
    const p = profile()
    return [{ ...p, planner: { ...p.planner!, agentMilestones: 'allow' as const } }, profile('home', false)]
  }

  it('keeps every change as a proposal by default, and applies it only when the user does', async () => {
    const { planner, control, changed } = setup()
    await planner.saveMilestone('work', beta)
    changed.length = 0
    const created = await control.changeMilestone(null, 'POST', { session: 's1', name: 'GA', start: '2026-11-10', end: '2026-11-30', progress: 0, reason: 'From the planning call' }, q())
    expect(created).toMatchObject({ status: 202, body: { ok: true, applied: false, pending: true } })
    const updated = await control.changeMilestone('beta', 'PATCH', { session: 's1', progress: 60 }, q())
    expect(updated.status).toBe(202)
    expect((await control.changeMilestone('beta', 'DELETE', { session: 's1' }, q())).status).toBe(202)
    expect(changed).toEqual(['work', 'work', 'work'])
    let view = await planner.view('work')
    expect(view.milestones.map((r) => r.milestone)).toEqual([beta])
    expect(view.proposals.map((p) => [p.action, p.milestoneId, p.source.label])).toEqual([
      ['create', expect.any(String), 'From the planning call'],
      ['update', 'beta', undefined],
      ['delete', 'beta', undefined]
    ])
    expect(view.proposals[0]!.source.session).toBe('s1')
    expect((await control.milestones(q())).body).toMatchObject({ agentChanges: 'ask', pending: [{ action: 'create', name: 'GA' }, { action: 'update', name: 'Beta' }, { action: 'delete', name: 'Beta' }] })

    expect(await planner.resolveProposal('work', view.proposals[1]!.id, true)).toEqual({ ok: true })
    view = await planner.view('work')
    expect(view.milestones[0]!.milestone.source).toEqual({ kind: 'manual', progress: 60 })
    // The delete was asked about Beta at 30 %: it changed since, so it no longer applies.
    const del = view.proposals.find((p) => p.action === 'delete')!
    expect(await planner.resolveProposal('work', del.id, true)).toMatchObject({ ok: false, error: expect.stringMatching(/changed since/) })
    expect(await planner.resolveProposal('work', del.id, false)).toEqual({ ok: true })
    const create = view.proposals.find((p) => p.action === 'create')!
    expect(await planner.resolveProposal('work', create.id, true)).toEqual({ ok: true })
    view = await planner.view('work')
    expect(view.milestones.map((r) => r.milestone.name).sort()).toEqual(['Beta', 'GA'])
    expect(view.proposals).toEqual([])
    expect(await planner.resolveProposal('work', create.id, true)).toMatchObject({ ok: false })
  })

  it('applies changes at once when the profile allows it', async () => {
    const { planner, control } = setup(allowing())
    await planner.saveMilestone('work', beta)
    const created = await control.changeMilestone(null, 'POST', { session: 's1', name: 'GA', start: '2026-11-10', end: '2026-11-30', query: 'labels = launch' }, q())
    expect(created).toMatchObject({ status: 200, body: { ok: true, applied: true } })
    expect((await control.changeMilestone('beta', 'PATCH', { progress: 100, notes: 'Shipped' }, q('session=s1'))).body).toMatchObject({ applied: true })
    let view = await planner.view('work')
    expect(view.proposals).toEqual([])
    expect(view.milestones.find((r) => r.milestone.id === 'beta')).toMatchObject({ status: 'done', milestone: { notes: 'Shipped' } })
    expect(view.milestones.find((r) => r.milestone.name === 'GA')!.milestone.source).toEqual({ kind: 'tracker', query: 'labels = launch' })
    expect((await control.changeMilestone('beta', 'DELETE', {}, q('session=s1'))).body).toMatchObject({ applied: true })
    view = await planner.view('work')
    expect(view.milestones.map((r) => r.milestone.name)).toEqual(['GA'])
  })

  it('refuses bad bodies, unknown milestones, wrong fields for the source and Plan off', async () => {
    const { planner, control } = setup()
    await planner.saveMilestone('work', beta)
    expect((await control.changeMilestone(null, 'POST', { name: 'GA', start: '2026-11-30', end: '2026-11-01', progress: 0 }, q())).body).toMatchObject({ error: expect.stringMatching(/order/) })
    expect((await control.changeMilestone(null, 'POST', { name: 'GA', start: '2026-11-01', end: '2026-11-30', progress: 0, query: 'x' }, q())).status).toBe(400)
    expect((await control.changeMilestone('nope', 'PATCH', { progress: 10 }, q())).status).toBe(404)
    expect((await control.changeMilestone('beta', 'PATCH', { query: 'labels = x' }, q())).body).toMatchObject({ error: expect.stringMatching(/typed by hand/) })
    expect((await control.changeMilestone('beta', 'PATCH', { progress: 140 }, q())).status).toBe(400)
    expect((await control.changeMilestone('beta', 'PATCH', {}, q())).status).toBe(400)
    expect((await control.changeMilestone('bad id!', 'PATCH', { progress: 1 }, q())).status).toBe(400)
    expect((await control.changeMilestone(null, 'POST', { name: 'GA', start: '2026-11-01', end: '2026-11-30', progress: 0 }, q('session=s2'))).status).toBe(409)
    expect((await planner.view('work')).proposals).toEqual([])
  })
})

describe('Plan endpoints over the control socket', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('routes each endpoint and method', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-plan-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const { planner, control } = setup(undefined, view({ events: [event('today', at(6, 15))] }))
    await planner.propose('work', [{ kind: 'task', title: 'Write the docs', detail: '' }], { type: 'agent' })
    const server = await startControlServer(socket, { openReview: () => ({ ok: true }), plan: control })
    const call = (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const req = request({ socketPath: socket, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
        })
        req.on('error', reject)
        req.end(body === undefined ? undefined : JSON.stringify(body))
      })
    try {
      expect(await call('GET', '/v1/plan/today?session=s1')).toMatchObject({ status: 200, json: { ok: true, events: [{ id: 'today' }] } })
      expect(await call('GET', '/v1/inbox?status=pending')).toMatchObject({ status: 200, json: { items: [{ id: 'id1' }] } })
      expect(await call('PATCH', '/v1/inbox/id1', { session: 's1', status: 'done' })).toMatchObject({ status: 200, json: { item: { status: 'done' } } })
      expect(await call('GET', '/v1/milestones')).toMatchObject({ status: 200, json: { milestones: [] } })
      expect(await call('GET', '/v1/people')).toMatchObject({ status: 200, json: { people: [{ id: 'ana' }] } })
      expect((await call('PUT', '/v1/milestones')).status).toBe(405)
      expect((await call('GET', '/v1/milestones/x')).status).toBe(405)
      expect(await call('POST', '/v1/milestones', { session: 's1', name: 'GA', start: '2026-11-01', end: '2026-11-30', progress: 0 })).toMatchObject({ status: 202, json: { pending: true } })
      expect((await call('POST', '/v1/milestones', { session: 's1', name: 'GA' })).status).toBe(400)
      expect((await call('GET', '/v1/inbox/id1')).status).toBe(405)
      expect((await call('DELETE', '/v1/inbox')).status).toBe(405)
      // No POST handler wired: the inbox does not take proposals here.
      expect((await call('POST', '/v1/inbox', { title: 'x' })).status).toBe(404)
      expect((await call('GET', '/v1/constructor')).status).toBe(404)
    } finally {
      server?.close()
    }
  })

  it('says Plan is not available when it is not wired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-plan-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const server = await startControlServer(socket, { openReview: () => ({ ok: true }) })
    try {
      const status = (path: string, method = 'GET') =>
        new Promise<number>((resolve, reject) => {
          const req = request({ socketPath: socket, method, path }, (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          })
          req.on('error', reject)
          req.end()
        })
      expect(await status('/v1/plan/today')).toBe(404)
      expect(await status('/v1/inbox')).toBe(404)
      expect(await status('/v1/inbox/id1', 'PATCH')).toBe(404)
    } finally {
      server?.close()
    }
  })
})
