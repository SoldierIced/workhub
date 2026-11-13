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
import { BULK_CLEAR, bulkChangeCount, createsTicket, bulkFormToPatch, EMPTY_BULK_FORM, formToInboxSettings, formToMilestone, formToProposal, inboxActionLabel, inboxSettingsToForm, linksToRows, milestoneFormProblem, milestoneId, milestonesAtRisk, milestoneToForm, pieceTaskChoices, plainPreview, rowsToLinks } from '../src/renderer/lib/planner'
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

describe('PlannerService links and history', () => {
  const links = [{ label: 'Runbook', url: 'https://example.com/runbook' }]

  it('loads state stored before links and history existed', async () => {
    const old = {
      profiles: {
        work: {
          milestones: [{ id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual', progress: 30 }, notes: 'n', link: 'https://example.com' }],
          counts: {},
          errors: {},
          inbox: [{ id: 'i1', kind: 'task', title: 'Old item', detail: 'x', source: { type: 'manual' }, status: 'local', createdAt: NOW - 1000 }],
          proposals: []
        }
      }
    }
    const service = new PlannerService({ profiles: async () => [profile()], store: { load: () => old as unknown as PlannerState, save: () => undefined }, tracker: async () => ({ error: 'none' }), changed: () => undefined, now: () => NOW })
    const view = await service.view('work')
    expect(view.inbox).toEqual(old.profiles.work.inbox)
    expect(view.milestones[0]!.milestone).toEqual(old.profiles.work.milestones[0])
    expect(await service.editItem('work', 'i1', { links })).toEqual({ ok: true })
    expect((await service.view('work')).inbox[0]).toMatchObject({ title: 'Old item', links, updatedAt: NOW, updatedBy: 'user' })
  })

  it('hands the menu bar panel the tasks due today or overdue, and nothing while Plan is off', async () => {
    const task = (id: string, due?: string) => ({ id, kind: 'task', title: id, detail: '', source: { type: 'manual' }, status: 'local', createdAt: NOW - 1000, ...(due ? { due } : {}) })
    const stored = { profiles: { work: { milestones: [], counts: {}, errors: {}, tickets: {}, inbox: [task('later', '2026-11-07'), task('today', '2026-11-06'), task('old', '2026-11-01'), task('none')], proposals: [] } } }
    const make = (on: boolean) =>
      new PlannerService({ profiles: async () => [profile({}, on)], store: { load: () => stored as unknown as PlannerState, save: () => undefined }, tracker: async () => ({ error: 'none' }), changed: () => undefined, now: () => NOW })
    expect((await make(true).dueToday('work')).map((i) => i.id)).toEqual(['old', 'today'])
    expect(await make(false).dueToday('work')).toEqual([])
    expect(await make(true).dueToday('missing')).toEqual([])
  })

  it('marks edits in Workhub as the user\'s and changes through the endpoint as an agent\'s', async () => {
    const { service, setNow } = setup()
    await service.addItem('work', { kind: 'task', title: 'a', detail: '', links })
    expect((await service.view('work')).inbox[0]).toMatchObject({ links, createdAt: NOW })
    expect((await service.view('work')).inbox[0]).not.toHaveProperty('updatedAt')
    setNow(NOW + 1000)
    await service.editItem('work', 'id1', { detail: '# Plan\n- one', due: '2026-11-12', area: 'Docs', criticality: null, links: [] })
    let item = (await service.view('work')).inbox[0]!
    expect(item).toMatchObject({ detail: '# Plan\n- one', due: '2026-11-12', area: 'Docs', updatedAt: NOW + 1000, updatedBy: 'user' })
    expect(item).not.toHaveProperty('links')
    setNow(NOW + 2000)
    const r = await service.updateItem('work', 'id1', { links, area: null })
    expect(r).toMatchObject({ ok: true, item: { links, updatedAt: NOW + 2000, updatedBy: 'agent' } })
    item = (await service.view('work')).inbox[0]!
    expect(item).not.toHaveProperty('area')
    setNow(NOW + 3000)
    await service.bulkEdit('work', ['id1'], { due: null })
    expect((await service.view('work')).inbox[0]).toMatchObject({ updatedAt: NOW + 3000, updatedBy: 'user' })
  })

  it('keeps when a milestone was created and marks who changed it last', async () => {
    const { service, setNow } = setup()
    const beta = { id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual' as const, progress: 30 }, links }
    await service.saveMilestone('work', beta)
    setNow(NOW + 5000)
    await service.saveMilestone('work', { ...beta, notes: '**Shipped** the beta' })
    expect((await service.view('work')).milestones[0]!.milestone).toEqual({ ...beta, notes: '**Shipped** the beta', createdAt: NOW, updatedAt: NOW + 5000, updatedBy: 'user' })
  })
})

describe('Plan IPC parsers', () => {
  it('checks links and fields of a single item edit', () => {
    expect(parseInboxEdit({ links: [{ label: ' Doc ', url: 'https://example.com/doc' }], due: '', area: 'Docs', criticality: null })).toEqual({ links: [{ label: 'Doc', url: 'https://example.com/doc' }], due: null, area: 'Docs', criticality: null })
    expect(parseInboxEdit({ links: [{ url: 'javascript:alert(1)' }] })).toBeNull()
    expect(parseInboxEdit({ links: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`) })).toBeNull()
    expect(parseInboxEdit({ due: 'tomorrow' })).toBeNull()
  })

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
    await addControlInboxItems(deps(proposed), { session: 's1', title: 'd', detail: '## Steps\n1. Open it', links: [{ label: 'Board', url: 'https://example.com/board' }] })
    expect(proposed[3]![1]).toEqual([{ kind: 'task', title: 'd', detail: '## Steps\n1. Open it', links: [{ label: 'Board', url: 'https://example.com/board' }] }])
  })

  it('refuses bad bodies, unknown sessions and profiles', async () => {
    const proposed: unknown[][] = []
    expect(await addControlInboxItems(deps(proposed), { items: [] })).toEqual({ ok: false, status: 400, error: 'no items' })
    expect(await addControlInboxItems(deps(proposed), { session: 'zz', title: 'a' })).toEqual({ ok: false, status: 404, error: 'unknown session' })
    expect(await addControlInboxItems(deps(proposed), { profile: 'nope', title: 'a' })).toEqual({ ok: false, status: 404, error: 'unknown profile' })
    expect(await addControlInboxItems(deps(proposed), { title: 'a', links: [{ label: 'x', url: 'ftp://example.com' }] })).toMatchObject({ ok: false, status: 400 })
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

  it('turns link rows into links and names a bad row', () => {
    const m = { id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual' as const, progress: 0 }, links: [{ label: 'Spec', url: 'https://example.com/spec' }, { label: 'https://example.com/b', url: 'https://example.com/b' }] }
    const form = milestoneToForm(m, '2026-11-06')
    expect(form.links).toEqual([{ label: 'Spec', url: 'https://example.com/spec' }, { label: '', url: 'https://example.com/b' }])
    expect(formToMilestone(form, 'beta')).toEqual(m)
    expect(rowsToLinks([{ label: '', url: '' }, { label: ' A ', url: ' https://example.com/a ' }])).toEqual([{ label: 'A', url: 'https://example.com/a' }])
    expect(rowsToLinks([{ label: 'A', url: '' }])).toBeNull()
    expect(rowsToLinks([{ label: 'A', url: 'example.com' }])).toBeNull()
    expect(milestoneFormProblem({ ...form, links: [{ label: 'A', url: 'example.com' }] })).toBe('planner.links.problem')
    expect(linksToRows(undefined)).toEqual([])
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

  it('sends only what the bulk edit bar changes, and counts the items it would change', () => {
    expect(bulkFormToPatch(EMPTY_BULK_FORM)).toEqual({})
    expect(bulkFormToPatch({ ...EMPTY_BULK_FORM, area: 'Payments', criticality: BULK_CLEAR })).toEqual({ area: 'Payments', criticality: null })
    expect(bulkFormToPatch({ ...EMPTY_BULK_FORM, due: 'clear', dueDate: '2026-11-20' })).toEqual({ due: null })
    expect(bulkFormToPatch({ ...EMPTY_BULK_FORM, due: 'set', dueDate: '2026-11-20' })).toEqual({ due: '2026-11-20' })
    // A date to set but not picked yet changes nothing.
    expect(bulkFormToPatch({ ...EMPTY_BULK_FORM, due: 'set', dueDate: '' })).toEqual({})

    const items = [{ area: 'Payments', due: '2026-11-20' }, { criticality: 'High' }, {}]
    expect(bulkChangeCount(items, {})).toBe(0)
    expect(bulkChangeCount(items, { area: 'Payments' })).toBe(2)
    expect(bulkChangeCount(items, { area: null })).toBe(1)
    expect(bulkChangeCount(items, { criticality: null, due: null })).toBe(2)
    expect(bulkChangeCount([items[0]!], { area: 'Payments', due: '2026-11-20' })).toBe(0)
  })
})

describe('plainPreview', () => {
  it('drops Markdown marks and keeps the words and lines', () => {
    expect(plainPreview('**What happens**\n- The `callback` times out\n- See [the run](https://ci.example.com/1), *pending*')).toBe('What happens\n- The callback times out\n- See the run, pending')
    expect(plainPreview('## Title\n\n> quoted')).toBe('Title\n\nquoted')
    expect(plainPreview('snake_case_name stays')).toBe('snake_case_name stays')
  })
})

/** A tracker whose tickets' states the test sets; every read by key is recorded (one call per connection). */
function fakeTracker(states: Record<string, 'todo' | 'inProgress' | 'done'>, over: { noRead?: boolean } = {}) {
  const tracker = new DemoTracker()
  const reads: string[][] = []
  if (over.noRead) Object.assign(tracker, { readTickets: undefined })
  else
    tracker.readTickets = async (keys) => {
      reads.push([...keys])
      return keys.filter((k) => states[k]).map((k) => ({ key: k, title: `Title ${k}`, status: states[k] === 'done' ? 'Done' : states[k] === 'todo' ? 'To Do' : 'In Review', category: states[k]!, url: `https://tracker.example.com/${k}` }))
    }
  return { tracker, reads }
}

describe('PlannerService pieces and linked tickets', () => {
  const HALF_HOUR = 30 * 60_000
  const pieces = { id: 'p', name: 'Pieces', start: '2026-11-01', end: '2026-11-11', source: { kind: 'items' as const, items: [] as import('@workhub/core').MilestonePiece[] } }

  it('reads the tickets of a pieces milestone in one call per connection, and weighs its progress', async () => {
    const { tracker, reads } = fakeTracker({ 'ABC-1': 'done', 'ABC-2': 'inProgress', 'ABC-3': 'done' })
    const { service, lookups, setNow } = setup({ tracker })
    await service.addItem('work', { kind: 'task', title: 'Local piece', detail: '' })
    const items = [
      { kind: 'ticket' as const, key: 'ABC-1', weight: 2 },
      { kind: 'ticket' as const, key: 'ABC-2', weight: 3 },
      { kind: 'ticket' as const, key: 'ABC-9', weight: 1 },
      { kind: 'ticket' as const, key: 'ABC-3', connectionId: 'jira-2', weight: 2 },
      { kind: 'task' as const, itemId: 'id1', weight: 1 },
      { kind: 'link' as const, url: 'https://docs.example.com/spec', label: 'Spec', done: true, weight: 1 }
    ]
    expect(await service.saveMilestone('work', { ...pieces, source: { kind: 'items', items } })).toEqual({ ok: true })
    expect(reads.map((r) => r.sort())).toEqual([['ABC-1', 'ABC-2', 'ABC-9'], ['ABC-3']])
    expect(lookups).toContain('jira-2')
    let row = (await service.view('work')).milestones[0]!
    expect(row.pieces!.map((v) => [v.piece.kind, v.state, v.share])).toEqual([
      ['ticket', 'done', 20],
      ['ticket', 'inProgress', 30],
      ['ticket', 'unknown', 10],
      ['ticket', 'done', 20],
      ['task', 'todo', 10],
      ['link', 'done', 10]
    ])
    expect(row.pieces![0]).toMatchObject({ title: 'Title ABC-1', status: 'Done', url: 'https://tracker.example.com/ABC-1', checkedAt: NOW })
    expect(row.pieces![2]!.error).toBe('missing')
    // Done: 2 + 2 + 1 of 10.
    expect(row).toMatchObject({ progress: 50, elapsed: 50, status: 'onTrack' })
    // A local task's state counts at once.
    await service.act('work', 'id1', 'keep')
    await service.act('work', 'id1', 'done')
    expect((await service.view('work')).milestones[0]!.progress).toBe(60)
    // Fresh reads are not repeated; after the refresh period they are, and "Count again" forces them.
    await service.tick()
    expect(reads).toHaveLength(2)
    setNow(NOW + HALF_HOUR)
    await service.tick()
    expect(reads).toHaveLength(4)
    await service.refreshMilestones('work')
    expect(reads).toHaveLength(6)
    row = (await service.view('work')).milestones[0]!
    expect(row.pieces![0]!.checkedAt).toBe(NOW + HALF_HOUR)
  })

  it('leaves the state unknown when the tracker cannot read by key, and keeps the last good one on a failure', async () => {
    const { tracker } = fakeTracker({}, { noRead: true })
    const { service, saved } = setup({ tracker })
    await service.saveMilestone('work', { ...pieces, source: { kind: 'items', items: [{ kind: 'ticket', key: 'ABC-1', weight: 5 }] } })
    expect((await service.view('work')).milestones[0]!.pieces![0]).toMatchObject({ state: 'unknown', error: 'unsupported' })
    expect((await service.view('work')).milestones[0]).toMatchObject({ progress: 0, status: 'atRisk' })
    expect(saved().profiles.work!.tickets['|ABC-1']).toMatchObject({ unsupported: true })

    const good = fakeTracker({ 'ABC-1': 'done' })
    const second = setup({ tracker: good.tracker })
    await second.service.saveMilestone('work', { ...pieces, source: { kind: 'items', items: [{ kind: 'ticket', key: 'ABC-1', weight: 5 }] } })
    good.tracker.readTickets = async () => {
      throw new TrackerError('Jira answered 500')
    }
    const view = await second.service.refreshMilestones('work')
    expect(view.milestones[0]!.pieces![0]).toMatchObject({ state: 'done', error: 'Jira answered 500' })
    expect(view.milestones[0]!.status).toBe('done')
  })

  it('marks a linked local task done when its ticket is done, once', async () => {
    const states: Record<string, 'todo' | 'inProgress' | 'done'> = { 'ABC-5': 'inProgress' }
    const { tracker, reads } = fakeTracker(states)
    const { service, setNow } = setup({ tracker })
    await service.addItem('work', { kind: 'task', title: 'Follow the rollout', detail: '' })
    await service.act('work', 'id1', 'keep')
    expect(await service.linkItemTicket('work', 'id1', { key: 'ABC-5' })).toEqual({ ok: true })
    // The tracker group of the inbox shows it with its state.
    let view = await service.view('work')
    expect(view.inbox[0]).toMatchObject({ status: 'local', ticket: { key: 'ABC-5' } })
    expect(view.itemTickets['id1']).toMatchObject({ category: 'inProgress', title: 'Title ABC-5' })
    // The inbox's tracker (none set here: the profile's) was read.
    expect(reads).toEqual([['ABC-5']])
    states['ABC-5'] = 'done'
    setNow(NOW + HALF_HOUR)
    await service.tick()
    view = await service.view('work')
    expect(view.inbox[0]).toMatchObject({ status: 'done', closedAt: NOW + HALF_HOUR, updatedBy: 'tracker' })
    // Reopened by hand, it stays open while the ticket stays done.
    await service.act('work', 'id1', 'reopen')
    await service.refreshMilestones('work')
    expect((await service.view('work')).inbox[0]!.status).toBe('local')
    // Unlinked, it is a plain local task again.
    expect(await service.linkItemTicket('work', 'id1', null)).toEqual({ ok: true })
    expect((await service.view('work')).inbox[0]!.ticket).toBeUndefined()
    expect((await service.view('work')).itemTickets).toEqual({})
  })

  it('marks a task done at once when it is linked to a ticket already done, and refuses to link a pending item', async () => {
    const { tracker } = fakeTracker({ 'ABC-6': 'done' })
    const { service } = setup({ tracker })
    await service.addItem('work', { kind: 'task', title: 'Already shipped', detail: '' })
    expect(await service.linkItemTicket('work', 'id1', { key: 'ABC-6' })).toEqual({ ok: false, error: PLANNER_ERRORS.noLink })
    await service.act('work', 'id1', 'keep')
    expect(await service.linkItemTicket('work', 'id1', { key: 'ABC-6' })).toEqual({ ok: true })
    expect((await service.view('work')).inbox[0]).toMatchObject({ status: 'done', updatedBy: 'tracker' })
  })

  it('keeps an approved item open with its ticket, and marks it done when the ticket is', async () => {
    const tracker = new DemoTracker()
    const { service, setNow } = setup({ tracker })
    await service.addItem('work', { kind: 'bug', title: 'Crash on save', detail: '' })
    await service.act('work', 'id1', 'approve')
    let item = (await service.view('work')).inbox[0]!
    expect(item).toMatchObject({ status: 'ticket', ticket: { key: 'PAY-900' } })
    expect(item.closedAt).toBeUndefined()
    expect((await service.view('work')).itemTickets['id1']).toMatchObject({ category: 'todo' })
    const read = tracker.readTickets.bind(tracker)
    tracker.readTickets = async (keys) => (await read(keys)).map((t) => ({ ...t, status: 'Done', category: 'done' as const }))
    setNow(NOW + HALF_HOUR)
    await service.tick()
    item = (await service.view('work')).inbox[0]!
    expect(item).toMatchObject({ status: 'done', closedAt: NOW + HALF_HOUR, updatedBy: 'tracker' })
  })

  it('loads a state file from before pieces, and follows its old approved items', async () => {
    const { tracker } = fakeTracker({ 'PAY-1': 'done', 'PAY-2': 'inProgress' })
    const old = {
      profiles: {
        work: {
          milestones: [{ id: 'm', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual', progress: 30 } }],
          counts: {},
          errors: {},
          proposals: [],
          inbox: [
            // Sent to the tracker three weeks ago: closed then, kept now that it is followed.
            { id: 'a', kind: 'task', title: 'Old one', detail: '', source: { type: 'manual' }, status: 'ticket', ticket: { key: 'PAY-1' }, createdAt: NOW - 30 * 86_400_000, closedAt: NOW - 21 * 86_400_000 },
            { id: 'b', kind: 'task', title: 'Still open', detail: '', source: { type: 'manual' }, status: 'ticket', ticket: { key: 'PAY-2' }, createdAt: NOW - 30 * 86_400_000, closedAt: NOW - 21 * 86_400_000 }
          ]
        }
      }
    }
    const service = new PlannerService({
      profiles: async () => [profile()],
      store: { load: () => old as unknown as PlannerState, save: () => undefined },
      tracker: async () => ({ tracker }),
      changed: () => undefined,
      now: () => NOW
    })
    let view = await service.view('work')
    expect(view.milestones[0]).toMatchObject({ status: 'atRisk', progress: 30 })
    expect(view.inbox.map((i) => [i.id, i.status])).toEqual([['a', 'ticket'], ['b', 'ticket']])
    expect(view.itemTickets).toEqual({})
    await service.tick()
    view = await service.view('work')
    expect(view.inbox.map((i) => [i.id, i.status])).toEqual([['a', 'done'], ['b', 'ticket']])
    expect(view.itemTickets['b']).toMatchObject({ category: 'inProgress' })
  })

  it('keeps a done task a milestone is made of past the inbox retention', async () => {
    const { service, setNow } = setup()
    await service.addItem('work', { kind: 'task', title: 'Piece', detail: '' })
    await service.addItem('work', { kind: 'task', title: 'Other', detail: '' })
    for (const id of ['id1', 'id2']) {
      await service.act('work', id, 'keep')
      await service.act('work', id, 'done')
    }
    await service.saveMilestone('work', { ...pieces, source: { kind: 'items', items: [{ kind: 'task', itemId: 'id1', weight: 5 }] } })
    setNow(NOW + 8 * 86_400_000)
    await service.addItem('work', { kind: 'task', title: 'New', detail: '' })
    const view = await service.view('work')
    expect(view.inbox.map((i) => i.id)).toEqual(['id1', 'id3'])
    expect(view.milestones[0]!.pieces![0]!.state).toBe('done')
  })

  it('looks a ticket up for the editor', async () => {
    const { tracker } = fakeTracker({ 'ABC-1': 'todo' })
    const { service } = setup({ tracker })
    expect(await service.lookupTicket('work', 'ABC-1')).toEqual({ ok: true, ticket: expect.objectContaining({ key: 'ABC-1', title: 'Title ABC-1' }) })
    expect(await service.lookupTicket('work', 'ABC-2')).toEqual({ ok: true, ticket: null })
    const none = setup({ tracker: fakeTracker({}, { noRead: true }).tracker })
    expect(await none.service.lookupTicket('work', 'ABC-1')).toEqual({ ok: false, error: PLANNER_ERRORS.noRead })
  })

  it('edits pieces in the renderer form and converts between sources', () => {
    const form = milestoneToForm({ ...pieces, source: { kind: 'items', items: [{ kind: 'ticket', key: 'ABC-1', weight: 7 }] } }, '2026-11-06')
    expect(form).toMatchObject({ kind: 'items', pieces: [{ kind: 'ticket', key: 'ABC-1', weight: 7 }] })
    expect(formToMilestone(form, 'p').source).toEqual({ kind: 'items', items: [{ kind: 'ticket', key: 'ABC-1', weight: 7 }] })
    expect(formToMilestone({ ...form, kind: 'manual', progress: '40' }, 'p').source).toEqual({ kind: 'manual', progress: 40 })
    expect(milestoneFormProblem({ ...form, pieces: [{ kind: 'ticket', key: 'ABC-1', weight: 7 }, { kind: 'ticket', key: 'ABC-1', weight: 2 }] })).toBe('planner.milestone.problem.pieces')
    expect(milestoneFormProblem({ ...form, pieces: [] })).toBeNull()
  })

  it('offers the open tasks and bugs not already pieces, searched by title', () => {
    const base = { detail: '', source: { type: 'manual' as const } }
    const inbox = [
      { ...base, id: 'a', kind: 'task' as const, title: 'Write the spec', status: 'local' as const, createdAt: 1 },
      { ...base, id: 'b', kind: 'bug' as const, title: 'Fix the invite', status: 'pending' as const, createdAt: 2 },
      { ...base, id: 'c', kind: 'decision' as const, title: 'Use cursors', status: 'local' as const, createdAt: 3 },
      { ...base, id: 'd', kind: 'task' as const, title: 'Old one', status: 'done' as const, createdAt: 4 },
      { ...base, id: 'e', kind: 'task' as const, title: 'Taken', status: 'local' as const, createdAt: 5 }
    ]
    expect(pieceTaskChoices(inbox, [{ kind: 'task', itemId: 'e', weight: 5 }], '').map((i) => i.id)).toEqual(['b', 'a'])
    expect(pieceTaskChoices(inbox, [], 'SPEC').map((i) => i.id)).toEqual(['a'])
  })
})

describe('PlannerService moving a milestone between profiles', () => {
  const two = (homeOn = true): Profile[] => [
    { ...profile(), connections: { tracker: 'jira-a' } },
    { ...profile({}, homeOn), id: 'home', name: 'Home', connections: {} }
  ]
  const milestone = { id: 'm1', name: 'Launch', start: '2026-11-01', end: '2026-11-30', source: { kind: 'items' as const, items: [] } }

  it('moves it with its task to the other profile and keeps its tickets on the first tracker', async () => {
    const { service, changed } = setup({ profiles: two() })
    const added = await service.addItem('work', { kind: 'task', title: 'Write the spec', detail: '' })
    if (!added.ok) throw new Error(added.error)
    await service.saveMilestone('work', { ...milestone, source: { kind: 'items', items: [{ kind: 'task', itemId: added.item.id, weight: 5 }, { kind: 'ticket', key: 'PAY-9', weight: 5 }] } })
    expect(await service.moveMilestonePreview('work', 'm1', 'home')).toEqual({ moved: 1, copied: 0, pinned: 1 })
    const r = await service.moveMilestone('work', 'm1', 'home')
    expect(r).toEqual({ ok: true, id: 'm1', moved: 1, copied: 0, pinned: 1 })
    const [work, home] = await Promise.all([service.view('work'), service.view('home')])
    expect(work.milestones).toEqual([])
    expect(work.inbox.map((i) => i.title)).not.toContain('Write the spec')
    expect(home.milestones.map((m) => m.milestone.name)).toEqual(['Launch'])
    expect(home.inbox.map((i) => i.title)).toContain('Write the spec')
    const source = home.milestones[0]!.milestone.source
    expect(source.kind === 'items' && source.items[1]).toEqual({ kind: 'ticket', key: 'PAY-9', connectionId: 'jira-a', weight: 5 })
    expect(changed).toEqual(expect.arrayContaining(['work', 'home']))
  })

  it('refuses the same profile, a profile with Plan off and an unknown milestone', async () => {
    const { service } = setup({ profiles: two(false) })
    await service.saveMilestone('work', milestone)
    expect(await service.moveMilestone('work', 'm1', 'work')).toEqual({ ok: false, error: PLANNER_ERRORS.sameProfile })
    expect(await service.moveMilestone('work', 'm1', 'home')).toEqual({ ok: false, error: PLANNER_ERRORS.moduleOff })
    const on = setup({ profiles: two() }).service
    expect(await on.moveMilestone('work', 'nope', 'home')).toEqual({ ok: false, error: PLANNER_ERRORS.unknownMilestone })
  })
})

describe('createsTicket', () => {
  it('asks only for an approve that makes a tracker issue', () => {
    expect(createsTicket({ kind: 'task' }, 'approve')).toBe(true)
    expect(createsTicket({ kind: 'bug' }, 'approve')).toBe(true)
    expect(createsTicket({ kind: 'decision' }, 'approve')).toBe(false)
    expect(createsTicket({ kind: 'task' }, 'keep')).toBe(false)
  })
})
