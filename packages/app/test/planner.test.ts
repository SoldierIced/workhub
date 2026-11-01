import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DemoTracker } from '@workhub/adapters/tracker-demo'
import { DEFAULT_PLANNER_SETTINGS, TrackerError, type MetricAlert, type PlannerSettings, type Profile, type TicketTracker } from '@workhub/core'
import { controlSocketPath, startControlServer } from '../src/main/control-server'
import { addControlInboxItems, parseBulkPatch, parseInboxEdit } from '../src/main/planner-ipc'
import { PLANNER_ERRORS, PlannerService, type PlannerState } from '../src/main/planner-service'
import { formToInboxSettings, formToMilestone, formToProposal, inboxActionLabel, inboxSettingsToForm, milestoneFormProblem, milestoneId, milestonesAtRisk, milestoneToForm } from '../src/renderer/lib/planner'
import { en } from '../src/renderer/i18n/en'
import { es } from '../src/renderer/i18n/es'

// 2026-11-06 is day 5 of a milestone from 11-01 to 11-11 (50 % of the time gone).
const NOW = new Date(2026, 10, 6, 12).getTime()

const profile = (planner: Partial<PlannerSettings> = {}, on = true): Profile => ({
  id: 'work',
  name: 'Work',
  connections: {},
  accountIds: [],
  modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: on },
  planner: { ...DEFAULT_PLANNER_SETTINGS, people: [{ id: 'ana', name: 'Ana Costa', emails: ['ana@example.com'] }], ...planner }
})

function setup(over: { profiles?: Profile[]; tracker?: TicketTracker | { error: string } } = {}) {
  let saved: PlannerState = { profiles: {} }
  const changed: string[] = []
  const lookups: (string | undefined)[] = []
  const tracker = over.tracker ?? new DemoTracker()
  let n = 0
  let now = NOW
  const service = new PlannerService({
    profiles: async () => over.profiles ?? [profile({ inbox: { ...formToInboxSettings(inboxSettingsToForm(undefined, 10)), project: 'PAY', criticalities: [{ name: 'Critical', priority: 1 }] } })],
    store: { load: (fallback) => fallback, save: (v) => void (saved = JSON.parse(JSON.stringify(v))) },
    tracker: async (_p, connectionId) => {
      lookups.push(connectionId)
      return 'error' in tracker ? tracker : { tracker }
    },
    changed: (p) => void changed.push(p),
    now: () => now,
    newId: () => `id${++n}`
  })
  return { service, saved: () => saved, changed, lookups, tracker, setNow: (ms: number) => void (now = ms) }
}

describe('PlannerService milestones', () => {
  it('saves a manual milestone and reports its status against time', async () => {
    const { service, saved, changed } = setup()
    expect(await service.saveMilestone('work', { id: 'm', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual', progress: 30 } })).toEqual({ ok: true })
    const view = await service.view('work')
    expect(view.milestones).toEqual([{ milestone: expect.objectContaining({ id: 'm' }), status: 'atRisk', progress: 30, elapsed: 50 }])
    expect(view.today).toBe('2026-11-06')
    expect(saved().profiles.work!.milestones).toHaveLength(1)
    expect(changed).toContain('work')
  })

  it('counts a tracker milestone on save, caches the count and refreshes on demand', async () => {
    const counting = new DemoTracker()
    let searches = 0
    const search = counting.searchByQuery.bind(counting)
    counting.searchByQuery = async (q, o) => (searches++, search(q, o))
    const { service } = setup({ tracker: counting })
    await service.saveMilestone('work', { id: 't', name: 'Launch', start: '2026-11-01', end: '2026-11-30', source: { kind: 'tracker', query: 'project = DEMO' } })
    const row = (await service.view('work')).milestones[0]!
    expect(row.counts?.total).toBeGreaterThan(0)
    expect(row.counts?.key).toBe('|project = DEMO')
    await service.tick()
    expect(searches).toBe(1)
    await service.refreshMilestones('work')
    expect(searches).toBe(2)
  })

  it('keeps the last good count and says why a count failed', async () => {
    const failing = new DemoTracker()
    const { service } = setup({ tracker: failing })
    await service.saveMilestone('work', { id: 't', name: 'Launch', start: '2026-11-01', end: '2026-11-30', source: { kind: 'tracker', query: 'project = DEMO', connectionId: 'jira-2' } })
    failing.searchByQuery = async () => {
      throw new TrackerError('Jira answered 500')
    }
    const view = await service.refreshMilestones('work')
    expect(view.milestones[0]!.counts).toBeDefined()
    expect(view.milestones[0]!.error).toBe('Jira answered 500')
  })

  it('says when the tracker cannot search, and drops counts of a deleted milestone', async () => {
    const plain = new DemoTracker()
    Object.assign(plain, { capabilities: { ...plain.capabilities, search: false } })
    const { service, saved } = setup({ tracker: plain })
    await service.saveMilestone('work', { id: 't', name: 'Launch', start: '2026-11-01', end: '2026-11-30', source: { kind: 'tracker', query: 'x' } })
    expect((await service.view('work')).milestones[0]!.error).toBe(PLANNER_ERRORS.noSearch)
    await service.deleteMilestone('work', 't')
    expect(saved().profiles.work).toMatchObject({ milestones: [], errors: {} })
  })

  it('refuses work for a profile with Plan off', async () => {
    const { service } = setup({ profiles: [profile({}, false)] })
    expect(await service.saveMilestone('work', { id: 'm', name: 'x', start: '2026-11-01', end: '2026-11-02', source: { kind: 'manual', progress: 0 } })).toEqual({ ok: false, error: PLANNER_ERRORS.moduleOff })
    expect((await service.view('work')).enabled).toBe(false)
  })
})

describe('PlannerService inbox', () => {
  it('adds items, refuses a duplicate open title unless forced, and matches people', async () => {
    const { service } = setup()
    const first = await service.addItem('work', { kind: 'task', title: 'Send the rollout plan', detail: '', people: ['ana@example.com'] })
    expect(first).toMatchObject({ ok: true, item: { id: 'id1', status: 'pending', people: ['ana'], source: { type: 'manual' } } })
    expect(await service.addItem('work', { kind: 'task', title: 'send the rollout plan!', detail: '' })).toEqual({ ok: false, error: 'An open item has the same title', duplicateOf: 'id1' })
    expect((await service.addItem('work', { kind: 'task', title: 'send the rollout plan!', detail: '' }, true)).ok).toBe(true)
  })

  it('approves a task into a tracker issue with the profile settings, once', async () => {
    const { service, tracker } = setup()
    await service.addItem('work', { kind: 'bug', title: 'Crash on save', detail: 'Steps', criticality: 'Critical' })
    const [a, b] = await Promise.all([service.act('work', 'id1', 'approve'), service.act('work', 'id1', 'approve')])
    expect(a).toEqual({ ok: true, ticket: { key: 'PAY-900', url: 'https://demo.example.com/browse/PAY-900' } })
    expect(b.ok).toBe(false)
    const created = (tracker as DemoTracker).created
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ project: 'PAY', issueType: 'Bug', title: 'Crash on save', priority: 1, description: 'Steps\n\nSource: Added by hand' })
    expect((await service.view('work')).inbox[0]).toMatchObject({ status: 'ticket', ticket: { key: 'PAY-900' } })
  })

  it('records decisions, keeps and closes local tasks, and explains a missing project', async () => {
    const { service } = setup({ profiles: [profile()] })
    await service.addItem('work', { kind: 'decision', title: 'Use cursor pagination', detail: '' })
    await service.addItem('work', { kind: 'task', title: 'Write the docs', detail: '' })
    expect(await service.act('work', 'id1', 'approve')).toEqual({ ok: true })
    expect(await service.act('work', 'id2', 'approve')).toEqual({ ok: false, error: PLANNER_ERRORS.noProject })
    expect(await service.act('work', 'id2', 'keep')).toEqual({ ok: true })
    expect(await service.act('work', 'id2', 'done')).toEqual({ ok: true })
    expect(await service.act('work', 'id2', 'approve')).toEqual({ ok: false, error: PLANNER_ERRORS.notAllowed })
    const inbox = (await service.view('work')).inbox
    expect(inbox.map((i) => [i.id, i.status])).toEqual([
      ['id1', 'local'],
      ['id2', 'done']
    ])
  })

  it('reports a tracker that cannot create, and a failed create leaves the item pending', async () => {
    const plain = new DemoTracker()
    Object.assign(plain, { capabilities: { ...plain.capabilities, create: false } })
    const a = setup({ tracker: plain })
    await a.service.addItem('work', { kind: 'task', title: 'x', detail: '' })
    expect(await a.service.act('work', 'id1', 'approve')).toEqual({ ok: false, error: PLANNER_ERRORS.noCreate })
    expect((await a.service.view('work')).tracker).toEqual({ search: true, create: false })
    const broken = new DemoTracker()
    broken.createIssue = async () => {
      throw new TrackerError('Jira denied access to this resource')
    }
    const b = setup({ tracker: broken })
    await b.service.addItem('work', { kind: 'task', title: 'x', detail: '' })
    expect(await b.service.act('work', 'id1', 'approve')).toEqual({ ok: false, error: 'Jira denied access to this resource' })
    expect((await b.service.view('work')).inbox[0]!.status).toBe('pending')
  })

  it('bulk edits and edits single items', async () => {
    const { service } = setup()
    await service.addItem('work', { kind: 'task', title: 'a', detail: '' })
    await service.addItem('work', { kind: 'task', title: 'b', detail: '' })
    await service.bulkEdit('work', ['id1', 'id2'], { area: 'Backend', due: '2026-11-10' })
    await service.editItem('work', 'id2', { title: 'b2', kind: 'bug', people: [] })
    expect((await service.view('work')).inbox).toMatchObject([
      { id: 'id1', area: 'Backend', due: '2026-11-10' },
      { id: 'id2', title: 'b2', kind: 'bug', area: 'Backend' }
    ])
  })

  it('files a metric alert once while its item is open', async () => {
    const { service } = setup()
    const alert = { key: 'acme|orders.errors|checkout-api|', kind: 'jump', severity: 'high', status: 'new', firstSeenDay: '2026-11-05', lastSeenDay: '2026-11-06', metric: 'orders.errors', label: 'Order errors', subject: 'checkout-api', source: 'acme', lastValue: 90, baseline: 40, history: [] } as MetricAlert
    const first = await service.fromAlert('work', alert)
    const again = await service.fromAlert('work', alert)
    expect(first).toMatchObject({ ok: true, item: { kind: 'bug', status: 'pending', source: { type: 'alert', ref: alert.key } } })
    expect(again.ok && again.item.id).toBe(first.ok && first.item.id)
    expect((await service.view('work')).inbox).toHaveLength(1)
  })

  it('prunes closed items a week after they closed', async () => {
    const { service, setNow } = setup()
    await service.addItem('work', { kind: 'task', title: 'a', detail: '' })
    await service.act('work', 'id1', 'discard')
    setNow(NOW + 8 * 86_400_000)
    await service.addItem('work', { kind: 'task', title: 'b', detail: '' })
    expect((await service.view('work')).inbox.map((i) => i.id)).toEqual(['id2'])
  })
})

describe('Plan IPC parsers', () => {
  it('checks bulk patches and edits field by field', () => {
    expect(parseBulkPatch({ area: 'Mobile', criticality: null, due: '2026-11-10' })).toEqual({ area: 'Mobile', criticality: null, due: '2026-11-10' })
    expect(parseBulkPatch({ due: 'soon' })).toBeNull()
    expect(parseBulkPatch(null)).toBeNull()
    expect(parseInboxEdit({ title: '  New\ttitle ', kind: 'bug' })).toEqual({ title: 'New title', kind: 'bug' })
    expect(parseInboxEdit({ title: '' })).toBeNull()
    expect(parseInboxEdit({ kind: 'epic' })).toBeNull()
    expect(parseInboxEdit({ people: ['ana', 3] })).toBeNull()
  })
})

describe('POST /v1/inbox', () => {
  const deps = (proposed: unknown[][], sessions: Record<string, string | null> = { s1: 'work' }) => ({
    service: {
      propose: async (profileId: string, items: readonly unknown[], source: unknown) => {
        proposed.push([profileId, items, source])
        return { added: items.map((_, i) => `id${i + 1}`), duplicates: [] }
      }
    },
    sessionProfile: (id: string) => (id in sessions ? sessions[id] : undefined),
    profiles: async () => ({ ids: ['work', 'home'], active: 'home' })
  })

  it("adds to the session's profile, else the named one, else the active one", async () => {
    const proposed: unknown[][] = []
    expect(await addControlInboxItems(deps(proposed), { session: 's1', source: 'Weekly sync', items: [{ title: 'Follow up' }] })).toEqual({ ok: true, added: ['id1'], duplicates: [] })
    expect(proposed[0]).toEqual(['work', [{ kind: 'task', title: 'Follow up', detail: '' }], { type: 'agent', ref: 's1', label: 'Weekly sync' }])
    await addControlInboxItems(deps(proposed), { profile: 'work', sourceType: 'meeting', items: [{ title: 'b' }] })
    expect(proposed[1]![0]).toBe('work')
    expect(proposed[1]![2]).toEqual({ type: 'meeting' })
    await addControlInboxItems(deps(proposed), { title: 'c', kind: 'decision' })
    expect(proposed[2]![0]).toBe('home')
  })

  it('refuses bad bodies, unknown sessions and profiles', async () => {
    const proposed: unknown[][] = []
    expect(await addControlInboxItems(deps(proposed), { items: [] })).toEqual({ ok: false, status: 400, error: 'no items' })
    expect(await addControlInboxItems(deps(proposed), { session: 'zz', title: 'a' })).toEqual({ ok: false, status: 404, error: 'unknown session' })
    expect(await addControlInboxItems(deps(proposed), { profile: 'nope', title: 'a' })).toEqual({ ok: false, status: 404, error: 'unknown profile' })
    expect(proposed).toEqual([])
  })

  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('is served over the control socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-inbox-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const proposed: unknown[][] = []
    const server = await startControlServer(socket, { openReview: () => ({ ok: true }), addInboxItems: (body) => addControlInboxItems(deps(proposed), body) })
    const call = (method: string, body?: unknown) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const req = request({ socketPath: socket, method, path: '/v1/inbox', headers: { 'content-type': 'application/json' } }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
        })
        req.on('error', reject)
        req.end(body === undefined ? undefined : JSON.stringify(body))
      })
    try {
      expect(await call('POST', { title: 'From an agent' })).toEqual({ status: 200, json: { ok: true, added: ['id1'], duplicates: [] } })
      expect((await call('GET')).status).toBe(404)
      expect((await call('PUT')).status).toBe(405)
      expect(await call('POST', { title: '' })).toEqual({ status: 400, json: { ok: false, error: 'every item needs a "title"' } })
    } finally {
      server?.close()
    }
  })
})

describe('Plan renderer helpers', () => {
  it('round-trips milestone forms and names the first problem', () => {
    const m = { id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'tracker' as const, query: 'label = beta', connectionId: 'jira' }, link: 'https://example.com/beta' }
    expect(formToMilestone(milestoneToForm(m, '2026-11-06'), 'beta')).toEqual(m)
    const blank = milestoneToForm(undefined, '2026-11-06')
    expect(milestoneFormProblem(blank)).toBe('planner.milestone.problem.name')
    expect(milestoneFormProblem({ ...blank, name: 'x', end: '2026-11-01' })).toBe('planner.milestone.problem.order')
    expect(milestoneFormProblem({ ...blank, name: 'x', progress: '150' })).toBe('planner.milestone.problem.progress')
    expect(milestoneFormProblem({ ...blank, name: 'x' })).toBeNull()
    expect(milestoneId('Beta launch', ['beta-launch'])).toBe('beta-launch-2')
  })

  it('lists late and at-risk milestones for Home', () => {
    const row = (status: 'late' | 'atRisk' | 'onTrack') => ({ milestone: { id: status } as never, status, progress: 0, elapsed: 0 })
    expect(milestonesAtRisk([row('late'), row('onTrack'), row('atRisk')]).map((r) => r.status)).toEqual(['late', 'atRisk'])
  })

  it('builds proposals and settings from their forms', () => {
    expect(formToProposal({ kind: 'bug', title: '  a  b ', detail: ' d ', area: '', criticality: 'High', due: 'nope', people: [] })).toEqual({ kind: 'bug', title: 'a b', detail: 'd', criticality: 'High' })
    const form = { ...inboxSettingsToForm(undefined, 10), areas: 'Backend, Mobile, Backend', criticalities: [{ name: 'High', priority: 2 as const }, { name: '', priority: 3 as const }], project: ' PAY ' }
    expect(formToInboxSettings(form)).toMatchObject({ areas: ['Backend', 'Mobile'], criticalities: [{ name: 'High', priority: 2 }], project: 'PAY' })
  })

  it('has every action label in both languages', () => {
    for (const action of ['approve', 'keep', 'discard', 'done', 'reopen'] as const) {
      expect(en[inboxActionLabel(action, 'task')]).toBeTruthy()
      expect(es[inboxActionLabel(action, 'decision')]).toBeTruthy()
    }
    for (const p of [1, 2, 3, 4]) expect(es[`planner.settings.priority.${p}` as keyof typeof es]).toBeTruthy()
  })
})
