import { describe, expect, it } from 'vitest'
import { DemoTracker } from '@workhub/adapters/tracker-demo'
import { automationSchema, DEFAULT_PLANNER_SETTINGS, type AutomationDefinition, type Profile, type StateStore } from '@workhub/core'
import { AGENT_CHANGE_CAPS, AgentChangeJournal, createAgentChanges, journalControl, keepAgentChange, revertAgentChange, saveAgentFlowMap, type AgentChangeState } from '../src/main/agent-changes'
import { createAutomationControl } from '../src/main/automation-control'
import type { ControlDeps } from '../src/main/control-server'
import type { FlowMapRows } from '../src/main/flow-maps'
import { createPlanControl } from '../src/main/plan-control'
import { PlannerService, type PlannerState } from '../src/main/planner-service'
import { REMOTE_EVENTS, REMOTE_INVOKES, REMOTE_MESSAGES } from '../src/main/remote/allowlist'
import type { AutomationsSnapshot } from '../src/shared/chat-api'

const NOW = new Date(2026, 10, 6, 12).getTime()

function memoryStore(): StateStore<AgentChangeState> & { saved: AgentChangeState | null } {
  const s = {
    saved: null as AgentChangeState | null,
    load: (fallback: AgentChangeState) => s.saved ?? fallback,
    save: (v: AgentChangeState) => void (s.saved = JSON.parse(JSON.stringify(v)) as AgentChangeState),
    flush: () => undefined
  }
  return s
}

function memoryMaps(): FlowMapRows & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return { rows, list: () => [...rows].map(([id, json]) => ({ id, json })), get: (id) => rows.get(id) ?? null, put: (id, json) => void rows.set(id, json), remove: (id) => rows.delete(id) }
}

const profile: Profile = {
  id: 'work',
  name: 'Work',
  connections: {},
  accountIds: [],
  modules: { flows: false, health: false, chatWatcher: false, automations: true, flowMaps: true, planner: true, boards: false },
  planner: { ...DEFAULT_PLANNER_SETTINGS, agentMilestones: 'allow' }
}

const map = (over: Record<string, unknown> = {}) => ({
  id: 'orders',
  name: 'Orders',
  version: 1,
  lanes: [{ id: 'app', label: 'App' }],
  nodes: [{ id: 'bff', lane: 'app', label: 'shop-bff', measure: { type: 'apm.transaction', service: 'shop-bff', transaction: 'POST /orders' } }],
  ...over
})

/** The app's services in memory: automations, flow maps, Plan, one open session `s1`, and the journal around the control handlers. */
function setup(mode: 'allow' | 'ask' = 'allow') {
  const profiles = [{ ...profile, planner: { ...profile.planner!, agentMilestones: mode } }]
  let n = 0
  const planner = new PlannerService({
    profiles: async () => profiles,
    store: { load: (fallback: PlannerState) => fallback, save: () => undefined },
    tracker: async () => ({ tracker: new DemoTracker() }),
    changed: () => undefined,
    now: () => NOW,
    newId: () => `id${++n}`
  })
  const defs = new Map<string, AutomationDefinition>()
  const automations = {
    snapshot: (): AutomationsSnapshot => ({ automations: [...defs.values()].map((definition) => ({ definition, health: 'off', active: true, startedToday: 0, startedInWindow: 0 })), runs: [] }) as unknown as AutomationsSnapshot,
    save: async (a: AutomationDefinition) => (defs.set(a.id, automationSchema.parse(a) as AutomationDefinition), { ok: true as const, value: {} as never }),
    remove: async (id: string) => (defs.delete(id), { ok: true as const, value: {} as never })
  }
  const maps = memoryMaps()
  const store = memoryStore()
  const changes = createAgentChanges({ store, changed: () => undefined, automations, flowMaps: maps, planner, sessions: () => [{ id: 's1', label: 'Fix checkout', agentName: 'Claude', profileId: 'work' }] })
  const profileDeps = { sessionProfile: (id: string) => (id === 's1' ? 'work' : undefined), profiles: async () => ({ ids: ['work'], active: 'work' }) }
  const control = journalControl(
    {
      auth: {} as ControlDeps['auth'],
      openReview: () => ({ ok: true }),
      saveFlowMap: () => ({ ok: false, errors: ['replaced by the journal'] }),
      addInboxItems: async (body) => {
        const r = await planner.propose('work', (body as { items: never[] }).items, { type: 'agent' })
        return 'error' in r ? { ok: false, status: 409, error: r.error } : { ok: true, ...r }
      },
      plan: createPlanControl({ ...profileDeps, planner, agenda: async () => ({}) as never, profile: async () => profiles[0], newId: () => `m${++n}` }),
      automations: createAutomationControl({ ...profileDeps, snapshot: automations.snapshot, save: automations.save, agentKeys: async () => ['claude'], history: async () => ({ entries: [], errors: [] }), messages: async () => [], newId: () => `a${++n}` })
    },
    changes
  )
  const q = new URLSearchParams()
  return { planner, defs, maps, store, journal: changes.journal, targets: changes.targets, control, q }
}

describe('the journal of agents’ changes', () => {
  it('records an automation an agent adds and one it edits, with the session and the changed fields', async () => {
    const { control, journal, q } = setup()
    const created = await control.automations!.create({ session: 's1', automation: { name: 'Triage', prompt: '/triage' } }, q)
    expect(created.status).toBe(200)
    const id = (created.body['automation'] as { id: string }).id
    await control.automations!.update(id, { session: 's1', automation: { prompt: '/triage --all' } }, q)
    const [edit, add] = journal.unreviewed()
    expect(add).toMatchObject({ kind: 'automation', action: 'create', object: { id, name: 'Triage' }, session: { id: 's1', name: 'Fix checkout', agent: 'Claude' }, profileId: 'work' })
    expect(add!.after).toMatchObject({ name: 'Triage', prompt: '/triage', enabled: false })
    expect(edit).toMatchObject({ kind: 'automation', action: 'update', fields: ['prompt'], before: { prompt: '/triage' }, after: { prompt: '/triage --all' } })
    // A refused change is not recorded.
    await control.automations!.update(id, { session: 's1', automation: { enabled: true } }, q)
    expect(journal.unreviewed()).toHaveLength(2)
  })

  it('records inbox items an agent proposes and the note it adds to one', async () => {
    const { control, journal, q } = setup()
    const added = await control.addInboxItems!({ session: 's1', items: [{ kind: 'task', title: 'Send the rollout plan' }] })
    expect(added.ok).toBe(true)
    const itemId = (added as { added: string[] }).added[0]!
    await control.plan!.updateItem(itemId, { session: 's1', note: 'Agreed in the sync' }, q)
    const [note, proposal] = journal.unreviewed()
    expect(proposal).toMatchObject({ kind: 'inboxItem', action: 'create', object: { id: itemId, name: 'Send the rollout plan' }, after: { status: 'pending' } })
    expect(note).toMatchObject({ kind: 'inboxItem', action: 'update', fields: ['detail'], after: { detail: 'Agreed in the sync' } })
  })

  it('records a milestone change applied at once, not one that waits as a proposal', async () => {
    const allow = setup('allow')
    const r = await allow.control.plan!.changeMilestone(null, 'POST', { session: 's1', name: 'Beta', start: '2026-11-01', end: '2026-11-30', progress: 10 }, allow.q)
    expect(r.status).toBe(200)
    expect(allow.journal.unreviewed()[0]).toMatchObject({ kind: 'milestone', action: 'create', object: { name: 'Beta' }, after: { name: 'Beta', start: '2026-11-01' } })
    const ask = setup('ask')
    expect((await ask.control.plan!.changeMilestone(null, 'POST', { session: 's1', name: 'Beta', start: '2026-11-01', end: '2026-11-30', progress: 10 }, ask.q)).status).toBe(202)
    expect(ask.journal.unreviewed()).toEqual([])
  })

  it('holds a flow map’s new alert limits until Keep', async () => {
    const { control, maps, journal, targets } = setup()
    maps.put('orders', JSON.stringify(map({ alerts: { p95Ms: 900 } })))
    const saved = control.saveFlowMap!(map({ name: 'Orders v2', alerts: { p95Ms: 100 } }), { session: 's1', readOnly: false })
    expect(saved).toMatchObject({ ok: true, id: 'orders', note: expect.stringContaining('wait') })
    // The redrawn map is in effect, its old limits too.
    expect(JSON.parse(maps.get('orders')!)).toMatchObject({ name: 'Orders v2', alerts: { p95Ms: 900 } })
    const entry = journal.unreviewed()[0]!
    expect(entry).toMatchObject({ kind: 'flowMap', action: 'update', held: ['alerts'], before: { name: 'Orders', alerts: { p95Ms: 900 } }, after: { name: 'Orders v2', alerts: { p95Ms: 100 } } })
    expect(await keepAgentChange(journal, targets, entry.id)).toEqual({ ok: true })
    expect(JSON.parse(maps.get('orders')!).alerts).toMatchObject({ p95Ms: 100 })
    expect(journal.unreviewed()).toEqual([])
  })

  it('applies new limits at once when the old ones no longer fit the redrawn map, and says so', () => {
    const maps = memoryMaps()
    const journal = new AgentChangeJournal({ store: memoryStore() })
    maps.put('orders', JSON.stringify(map({ alerts: { parts: { bff: { p95Ms: 800 } } } })))
    const redrawn = map({ nodes: [{ id: 'api', lane: 'app', label: 'api', measure: { type: 'apm.transaction', service: 'api', transaction: 'GET /' } }], alerts: { p95Ms: 300 } })
    const saved = saveAgentFlowMap(maps, redrawn, journal, {})
    expect(saved.ok && saved.note).toBeFalsy()
    expect(JSON.parse(maps.get('orders')!).alerts).toMatchObject({ p95Ms: 300 })
    expect(journal.unreviewed()[0]!.held).toBeUndefined()
  })
})

describe('Keep and Revert', () => {
  it('reverts an automation edit through the automations service', async () => {
    const { control, journal, targets, defs, q } = setup()
    const id = ((await control.automations!.create({ session: 's1', automation: { name: 'Triage', prompt: '/triage' } }, q)).body['automation'] as { id: string }).id
    await control.automations!.update(id, { session: 's1', automation: { prompt: '/rm -rf' } }, q)
    const edit = journal.unreviewed()[0]!
    expect(await revertAgentChange(journal, targets, edit.id)).toEqual({ ok: true })
    expect(defs.get(id)!.prompt).toBe('/triage')
    expect(journal.get(edit.id)!.reviewed).toMatchObject({ outcome: 'reverted' })
    // Reverting the creation removes it.
    const add = journal.unreviewed()[0]!
    expect(await revertAgentChange(journal, targets, add.id)).toEqual({ ok: true })
    expect(defs.has(id)).toBe(false)
  })

  it('reverts a note on an inbox item and discards a proposed item', async () => {
    const { control, journal, targets, planner, q } = setup()
    const itemId = ((await control.addInboxItems!({ session: 's1', items: [{ kind: 'task', title: 'Send the plan', detail: 'From the sync' }] })) as { added: string[] }).added[0]!
    await control.plan!.updateItem(itemId, { session: 's1', note: 'More text' }, q)
    const [note, proposal] = journal.unreviewed()
    expect(await revertAgentChange(journal, targets, note!.id)).toEqual({ ok: true })
    expect(planner.findItem(itemId)!.item).toMatchObject({ detail: 'From the sync', updatedBy: 'user' })
    expect(await revertAgentChange(journal, targets, proposal!.id)).toEqual({ ok: true })
    expect(planner.findItem(itemId)!.item.status).toBe('discarded')
  })

  it('reverts a milestone the agent deleted', async () => {
    const { control, journal, targets, planner, q } = setup()
    await planner.saveMilestone('work', { id: 'm-beta', name: 'Beta', start: '2026-11-01', end: '2026-11-30', source: { kind: 'manual', progress: 40 } })
    expect((await control.plan!.changeMilestone('m-beta', 'DELETE', { session: 's1' }, q)).status).toBe(200)
    const entry = journal.unreviewed()[0]!
    expect(entry).toMatchObject({ kind: 'milestone', action: 'delete', object: { id: 'm-beta', name: 'Beta' } })
    expect(await revertAgentChange(journal, targets, entry.id)).toEqual({ ok: true })
    expect(planner.findMilestone('m-beta')!.milestone).toMatchObject({ name: 'Beta', source: { kind: 'manual', progress: 40 } })
  })

  it('refuses to revert when the object changed again since, and leaves it as it is', async () => {
    const { control, journal, targets, defs, maps, q } = setup()
    const id = ((await control.automations!.create({ session: 's1', automation: { name: 'Triage', prompt: '/triage' } }, q)).body['automation'] as { id: string }).id
    await control.automations!.update(id, { session: 's1', automation: { prompt: '/agent' } }, q)
    const edit = journal.unreviewed()[0]!
    defs.set(id, { ...defs.get(id)!, prompt: '/user' })
    expect(await revertAgentChange(journal, targets, edit.id)).toEqual({ ok: false, error: 'changed' })
    expect(defs.get(id)!.prompt).toBe('/user')
    expect(journal.unreviewed().some((e) => e.id === edit.id)).toBe(true)
    // A held limit is not applied over limits the user changed since.
    maps.put('orders', JSON.stringify(map({ alerts: { p95Ms: 900 } })))
    control.saveFlowMap!(map({ alerts: { p95Ms: 100 } }), { session: 's1', readOnly: false })
    const held = journal.unreviewed()[0]!
    maps.put('orders', JSON.stringify(map({ alerts: { p95Ms: 500 } })))
    expect(await keepAgentChange(journal, targets, held.id)).toEqual({ ok: false, error: 'changed' })
    expect(JSON.parse(maps.get('orders')!).alerts).toEqual({ p95Ms: 500 })
    // A change already reviewed, or unknown, is gone.
    expect(await revertAgentChange(journal, targets, 'nope')).toEqual({ ok: false, error: 'gone' })
  })
})

describe('caps', () => {
  // A fixed id: a random UUID could itself contain the hex letters the redaction test looks for.
  const journal = () => new AgentChangeJournal({ store: memoryStore(), now: () => NOW, newId: () => 'change-1' })

  it('keeps a long value shortened and never restores it', async () => {
    const j = journal()
    const long = 'x'.repeat(AGENT_CHANGE_CAPS.value + 10)
    const e = j.record({ kind: 'automation', object: { id: 'a1', name: 'Triage' }, before: { prompt: long }, after: { prompt: 'short' } })!
    expect(e.cut).toEqual(['prompt'])
    expect(String(e.before['prompt']).length).toBeLessThanOrEqual(AGENT_CHANGE_CAPS.preview + 1)
    expect(e.after['prompt']).toBe('short')
    const targets = { automations: { get: () => ({ id: 'a1', prompt: 'short' }) as unknown as AutomationDefinition, save: async () => ({ ok: true }) as never, remove: async () => ({ ok: true }) as never } } as never
    expect(await revertAgentChange(j, targets, e.id)).toEqual({ ok: false, error: 'cut' })
  })

  it('keeps no secret: a secret-like field or a token-like string is redacted', () => {
    const e = journal().record({ kind: 'automation', object: { id: 'a1', name: 'x' }, before: { prompt: 'a', env: { API_TOKEN: 'abc' } }, after: { prompt: 'use ghp_abcdefghijklmnopqrstuvwxyz0123', env: { API_TOKEN: 'def' } } })!
    expect(e.after).toEqual({ prompt: '[redacted]', env: '[redacted]' })
    expect(e.cut).toEqual(expect.arrayContaining(['prompt', 'env']))
    expect(JSON.stringify(e)).not.toMatch(/ghp_|def|abc/)
  })

  it('keeps at most the capped number of entries, dropping reviewed ones first, and caps names and fields', () => {
    const store = memoryStore()
    const j = new AgentChangeJournal({ store, now: () => NOW })
    const first = j.record({ kind: 'inboxItem', object: { id: 'i0', name: 'n'.repeat(500) }, before: null, after: { title: 'x' } })!
    expect(first.object.name.length).toBe(AGENT_CHANGE_CAPS.name)
    const second = j.record({ kind: 'inboxItem', object: { id: 'i1', name: 'one' }, before: null, after: { title: 'y' } })!
    j.markReviewed(second.id, 'kept')
    for (let i = 2; i <= AGENT_CHANGE_CAPS.entries; i++) j.record({ kind: 'inboxItem', object: { id: `i${i}`, name: 'x' }, before: null, after: { title: `t${i}` } })
    expect(store.saved!.entries).toHaveLength(AGENT_CHANGE_CAPS.entries)
    expect(j.get(second.id)).toBeUndefined()
    expect(j.get(first.id)).toBeDefined()
    const wide = Object.fromEntries(Array.from({ length: AGENT_CHANGE_CAPS.fields + 5 }, (_, i) => [`f${i}`, i]))
    const e = j.record({ kind: 'automation', object: { id: 'a', name: 'a' }, before: {}, after: wide })!
    expect(e.fields).toHaveLength(AGENT_CHANGE_CAPS.fields)
    expect(e.cut).toContain('…')
    // Nothing changed: nothing recorded.
    expect(j.record({ kind: 'automation', object: { id: 'a', name: 'a' }, before: { a: 1, updatedAt: 1 }, after: { a: 1, updatedAt: 2 } })).toBeNull()
  })
})

describe('reach', () => {
  it('is never offered to paired devices', () => {
    for (const table of [REMOTE_INVOKES, REMOTE_MESSAGES, REMOTE_EVENTS]) expect(Object.keys(table).filter((c) => c.startsWith('agentChanges:'))).toEqual([])
  })
})
