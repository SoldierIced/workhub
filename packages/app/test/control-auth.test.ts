import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DemoTracker } from '@workhub/adapters/tracker-demo'
import { DEFAULT_PLANNER_SETTINGS, type Profile } from '@workhub/core'
import { ControlTokens } from '../src/main/control-auth'
import { controlSocketPath, startControlServer } from '../src/main/control-server'
import { createPlanControl } from '../src/main/plan-control'
import { PlannerService, type PlannerState } from '../src/main/planner-service'

const NOW = new Date(2026, 10, 6, 12).getTime()

const profile = (id: string): Profile => ({
  id,
  name: id,
  connections: {},
  accountIds: [],
  modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: true, boards: false },
  planner: { ...DEFAULT_PLANNER_SETTINGS, people: [] }
})

describe('ControlTokens', () => {
  it('mints a token per session, finds it, and forgets it when revoked or minted again', () => {
    const tokens = new ControlTokens()
    const a = tokens.mint('s1')
    const b = tokens.mint('s2')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
    expect(tokens.sessionOf(a)).toBe('s1')
    expect(tokens.sessionOf(b)).toBe('s2')
    expect(tokens.sessionOf('')).toBeUndefined()
    expect(tokens.sessionOf('nope')).toBeUndefined()
    const again = tokens.mint('s1')
    expect(tokens.sessionOf(a)).toBeUndefined()
    expect(tokens.sessionOf(again)).toBe('s1')
    tokens.revoke('s1')
    expect(tokens.sessionOf(again)).toBeUndefined()
    expect(tokens.sessionOf(b)).toBe('s2')
  })

  it('refuses a token whose session left the list, and reports reviewers as read-only', () => {
    const tokens = new ControlTokens()
    let listed = [{ id: 's1' }, { id: 'r1', readOnly: true }]
    const auth = tokens.auth(() => listed)
    const t = tokens.mint('s1')
    expect(auth.sessionOf(t)).toBe('s1')
    expect(auth.readOnly('s1')).toBe(false)
    expect(auth.readOnly('r1')).toBe(true)
    listed = [{ id: 'r1', readOnly: true }]
    expect(auth.sessionOf(t)).toBeUndefined()
  })
})

describe('session tokens on the control endpoint', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'wh-auth-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const profiles = [profile('work'), profile('home')]
    let n = 0
    const planner = new PlannerService({
      profiles: async () => profiles,
      store: { load: (fallback: PlannerState) => fallback, save: () => undefined },
      tracker: async () => ({ tracker: new DemoTracker() }),
      changed: () => undefined,
      now: () => NOW,
      newId: () => `id${++n}`
    })
    await planner.propose('work', [{ kind: 'task', title: 'Work item', detail: '' }], { type: 'agent' })
    await planner.propose('home', [{ kind: 'task', title: 'Home item', detail: '' }], { type: 'agent' })
    // s1 runs in work (the active profile), s2 in home, r1 is a reviewer in home.
    const sessions = [{ id: 's1', profileId: 'work' }, { id: 's2', profileId: 'home' }, { id: 'r1', profileId: 'home', readOnly: true }]
    const listed = new Set(sessions.map((s) => s.id))
    const live = () => sessions.filter((s) => listed.has(s.id))
    const deps = {
      sessionProfile: (id: string) => live().find((s) => s.id === id)?.profileId,
      sessionReadOnly: (id: string) => live().find((s) => s.id === id)?.readOnly === true,
      profiles: async () => ({ ids: profiles.map((p) => p.id), active: 'work' })
    }
    const agendas: string[] = []
    const plan = createPlanControl({
      ...deps,
      planner,
      agenda: async (id) => (agendas.push(id), { state: 'ready', events: [], calendars: [], briefs: {}, people: [], refreshMinutes: 15 }),
      profile: async (id) => profiles.find((p) => p.id === id),
      now: () => NOW
    })
    const tokens = new ControlTokens()
    const token = { s1: tokens.mint('s1'), s2: tokens.mint('s2'), r1: tokens.mint('r1') }
    const proposals: unknown[] = []
    const flowMaps: unknown[] = []
    const logs: string[] = []
    const server = await startControlServer(socket, {
      auth: tokens.auth(live),
      openReview: () => ({ ok: true }),
      saveFlowMap: (map) => (flowMaps.push(map), { ok: true, file: 'm.json', id: 'm' }),
      addInboxItems: async (body) => (proposals.push(body), { ok: true, added: [], duplicates: [] }),
      plan,
      log: (m) => logs.push(m)
    })
    const call = (method: string, path: string, body?: unknown, as?: string) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const req = request({ socketPath: socket, method, path, headers: { 'content-type': 'application/json', ...(as ? { 'x-workhub-token': as } : {}) } }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
        })
        req.on('error', reject)
        req.end(body === undefined ? undefined : JSON.stringify(body))
      })
    return { server, call, token, tokens, listed, agendas, proposals, flowMaps, logs, planner }
  }

  it("routes a token to its session and that session's profile only", async () => {
    const t = await setup()
    try {
      expect((await t.call('GET', '/v1/plan/today', undefined, t.token.s2)).status).toBe(200)
      // Naming another profile does not move a session out of its own.
      expect((await t.call('GET', '/v1/plan/today?profile=work', undefined, t.token.s2)).status).toBe(200)
      expect(t.agendas).toEqual(['home', 'home'])
      expect(await t.call('GET', '/v1/inbox', undefined, t.token.s2)).toMatchObject({ status: 200, json: { items: [{ id: 'id2', title: 'Home item' }] } })
      expect(await t.call('PATCH', '/v1/inbox/id2', { status: 'local' }, t.token.s2)).toMatchObject({ status: 200, json: { item: { status: 'local' } } })
      // An item of another profile is not found from this session, even when the body names that profile.
      expect((await t.call('PATCH', '/v1/inbox/id1', { status: 'local', profile: 'work' }, t.token.s2)).status).toBe(404)
      // The proven session is bound into the body a handler reads.
      expect((await t.call('POST', '/v1/inbox', { items: [{ title: 'x' }] }, t.token.s2)).status).toBe(200)
      expect(t.proposals).toEqual([{ items: [{ title: 'x' }], session: 's2' }])
    } finally {
      t.server?.close()
    }
  })

  it("refuses a reviewer's token every change, and lets it read", async () => {
    const t = await setup()
    try {
      expect((await t.call('GET', '/v1/inbox', undefined, t.token.r1)).status).toBe(200)
      expect((await t.call('PATCH', '/v1/inbox/id2', { status: 'done' }, t.token.r1)).status).toBe(403)
      expect((await t.call('POST', '/v1/inbox', { items: [{ title: 'x' }] }, t.token.r1)).status).toBe(403)
      expect((await t.call('POST', '/v1/milestones', { name: 'GA', start: '2026-11-01', end: '2026-11-30', progress: 0 }, t.token.r1)).status).toBe(403)
      expect((await t.call('POST', '/v1/flow-maps', { id: 'm' }, t.token.r1)).status).toBe(403)
      expect((await t.call('POST', '/v1/sessions/r1/review', {}, t.token.r1)).status).toBe(403)
      expect(t.proposals).toEqual([])
      expect(t.flowMaps).toEqual([])
      expect((await t.planner.view('home')).inbox.find((i) => i.id === 'id2')?.status).toBe('pending')
    } finally {
      t.server?.close()
    }
  })

  it('refuses a session that names another session than its token', async () => {
    const t = await setup()
    try {
      expect((await t.call('GET', '/v1/inbox?session=s1', undefined, t.token.s2)).status).toBe(403)
      expect((await t.call('PATCH', '/v1/inbox/id1', { session: 's1', status: 'done' }, t.token.s2)).status).toBe(403)
      expect((await t.call('POST', '/v1/inbox', { session: 's1', items: [{ title: 'x' }] }, t.token.s2)).status).toBe(403)
      expect((await t.call('POST', '/v1/sessions/s1/review', {}, t.token.s2)).status).toBe(403)
      // A reviewer cannot borrow a writer's id either.
      expect((await t.call('PATCH', '/v1/inbox/id2', { session: 's2', status: 'done' }, t.token.r1)).status).toBe(403)
      expect(t.proposals).toEqual([])
      expect((await t.planner.view('work')).inbox.find((i) => i.id === 'id1')?.status).toBe('pending')
      // Naming itself is fine.
      expect((await t.call('GET', '/v1/inbox?session=s2', undefined, t.token.s2)).status).toBe(200)
    } finally {
      t.server?.close()
    }
  })

  it("refuses the token of a removed session, and one that was never minted", async () => {
    const t = await setup()
    try {
      expect((await t.call('GET', '/v1/inbox', undefined, t.token.s2)).status).toBe(200)
      t.tokens.revoke('s2')
      t.listed.delete('s2')
      expect(await t.call('GET', '/v1/inbox', undefined, t.token.s2)).toMatchObject({ status: 401, json: { error: 'unknown or revoked session token' } })
      // A session that left the list is refused even if its token was not revoked yet.
      t.listed.delete('s1')
      expect((await t.call('GET', '/v1/inbox', undefined, t.token.s1)).status).toBe(401)
      expect((await t.call('GET', '/v1/inbox', undefined, 'f'.repeat(64))).status).toBe(401)
    } finally {
      t.server?.close()
    }
  })

  it('refuses every write without a token', async () => {
    const t = await setup()
    try {
      expect((await t.call('PATCH', '/v1/inbox/id1', { session: 's1', status: 'done' })).status).toBe(401)
      expect((await t.call('PATCH', '/v1/inbox/id1', { status: 'done' })).status).toBe(401)
      expect((await t.call('POST', '/v1/inbox', { items: [{ title: 'x' }] })).status).toBe(401)
      expect((await t.call('POST', '/v1/milestones', { name: 'GA', start: '2026-11-01', end: '2026-11-30', progress: 0 })).status).toBe(401)
      expect((await t.call('POST', '/v1/flow-maps', { id: 'm' })).status).toBe(401)
      expect((await t.call('POST', '/v1/sessions/s1/review', {})).status).toBe(401)
      expect(t.proposals).toEqual([])
      expect(t.flowMaps).toEqual([])
      expect((await t.planner.view('work')).inbox.find((i) => i.id === 'id1')?.status).toBe('pending')
    } finally {
      t.server?.close()
    }
  })

  it('answers a read of the active profile without a token, with a warning that holds no token', async () => {
    const t = await setup()
    try {
      expect((await t.call('GET', '/v1/plan/today')).status).toBe(200)
      expect(t.agendas).toEqual(['work'])
      expect(await t.call('GET', '/v1/inbox')).toMatchObject({ status: 200, json: { items: [{ id: 'id1' }] } })
      expect(t.logs.some((m) => m.includes('without a session token'))).toBe(true)
      // Without a token a caller cannot pick a session, a profile or a folder, nor read across profiles.
      expect((await t.call('GET', '/v1/inbox?session=s2')).status).toBe(401)
      expect((await t.call('GET', '/v1/inbox?profile=home')).status).toBe(401)
      expect((await t.call('GET', '/v1/inbox?cwd=%2Fw%2Fhome')).status).toBe(401)
      expect((await t.call('GET', '/v1/history')).status).toBe(401)
      expect((await t.call('GET', '/v1/analytics/schema')).status).toBe(401)
      // A token never reaches the log.
      await t.call('GET', '/v1/inbox', undefined, t.token.s1)
      await t.call('GET', '/v1/inbox', undefined, 'not-a-token')
      for (const secret of [...Object.values(t.token), 'not-a-token']) expect(t.logs.join('\n')).not.toContain(secret)
    } finally {
      t.server?.close()
    }
  })
})
