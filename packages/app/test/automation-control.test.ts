import { newAutomation, type AutomationDefinition, type HistoryMessage } from '@workhub/core'
import { describe, expect, it } from 'vitest'
import { createAutomationControl, mergeAutomation, parseAutomationFields, type AutomationControlDeps } from '../src/main/automation-control'
import type { HistoryItem } from '../src/shared/api'
import type { AutomationsSnapshot } from '../src/shared/chat-api'

const DAY = Date.UTC(2026, 10, 5, 12)

function entry(fields: Partial<HistoryItem>): HistoryItem {
  return { agentId: 'claude', accountId: null, agentSessionId: 's-1', title: 'Fix the login', lastModified: DAY, agentName: 'Claude', resumable: true, ...fields }
}

function setup(over: Partial<AutomationControlDeps> = {}) {
  let defs: AutomationDefinition[] = [
    newAutomation('a1', { name: 'Triage', prompt: '/triage', profileId: 'work', agentKey: 'claude', enabled: true, triggers: { chatChannelIds: [], prOwner: '', intervalMinutes: 10 } }),
    newAutomation('a2', { name: 'Home chores', profileId: 'home', agentKey: 'claude' }),
    newAutomation('a3', { name: 'Everywhere', profileId: null, agentKey: 'claude' })
  ]
  const snapshot = (): AutomationsSnapshot => ({
    automations: defs.map((definition) => ({ definition, health: 'healthy', startedInWindow: 0, startedToday: 0, active: true })) as unknown as AutomationsSnapshot['automations'],
    runs: [
      { id: 'r1', automationId: 'a1', automationName: 'Triage', trigger: 'interval', queuedAt: DAY, outcome: 'ok', merged: 0 },
      { id: 'r2', automationId: 'a2', automationName: 'Home chores', trigger: 'manual', queuedAt: DAY, outcome: 'error', merged: 0 }
    ]
  })
  const messages: HistoryMessage[] = [
    { kind: 'user', text: 'Fix the login', at: DAY },
    { kind: 'tool', id: 't1', title: 'Read src/login.ts', detail: 'secret file body' },
    { kind: 'agent', text: 'x'.repeat(5000) }
  ]
  const deps: AutomationControlDeps = {
    sessionProfile: (id) => (id === 'sess-work' ? 'work' : id === 'sess-review' ? 'work' : undefined),
    sessionReadOnly: (id) => id === 'sess-review',
    profiles: async () => ({ ids: ['work', 'home'], active: 'home' }),
    snapshot,
    save: async (a) => {
      defs = defs.some((d) => d.id === a.id) ? defs.map((d) => (d.id === a.id ? a : d)) : [...defs, a]
      return { ok: true, value: {} as never }
    },
    agentKeys: async () => ['claude', 'claude:acct-2'],
    history: async () => ({
      entries: [entry({}), entry({ agentSessionId: 's-2', title: 'Deploy notes', cwd: '/w/acme/api', automationId: 'a1', automationName: 'Triage' }), entry({ agentId: 'codex', agentSessionId: 's-3', title: 'Other', resumable: false })],
      errors: []
    }),
    messages: async () => messages,
    newId: () => 'new1',
    ...over
  }
  return { control: createAutomationControl(deps), defs: () => defs }
}

const q = (s: string) => new URLSearchParams(s)

describe('automation fields from an agent', () => {
  it('accepts known fields, refuses ids, unknown fields and turning one on', () => {
    expect(parseAutomationFields({ automation: { name: 'x', triggers: { intervalMinutes: 5 } } })).toEqual({ name: 'x', triggers: { intervalMinutes: 5 } })
    expect(parseAutomationFields({ automation: { id: 'x' } })).toMatch(/set by Workhub/)
    expect(parseAutomationFields({ automation: { profileId: 'x' } })).toMatch(/set by Workhub/)
    expect(parseAutomationFields({ automation: { colour: 'red' } })).toMatch(/unknown field "colour"/)
    expect(parseAutomationFields({ automation: { enabled: true } })).toMatch(/cannot turn an automation on/)
    expect(parseAutomationFields({ automation: { window: 3 } })).toMatch(/"window" must be an object/)
    expect(parseAutomationFields({})).toMatch(/"automation" must be an object/)
  })

  it('merges nested objects one level deep and always leaves it off', () => {
    const base = newAutomation('a', { enabled: true }) as unknown as Record<string, unknown>
    const merged = mergeAutomation(base, { triggers: { intervalMinutes: 15 }, prompt: '/x' })
    expect(merged['enabled']).toBe(false)
    expect(merged['prompt']).toBe('/x')
    expect(merged['triggers']).toEqual({ chatChannelIds: [], prOwner: '', intervalMinutes: 15 })
  })
})

describe('GET /v1/automations', () => {
  it("lists the session profile's automations and those of every profile, with their runs", async () => {
    const { control } = setup()
    const r = await control.list(q('session=sess-work'))
    expect(r.status).toBe(200)
    const body = r.body as { automations: { id: string; prompt: string }[]; runs: { id: string; queuedAt: string }[] }
    expect(body.automations.map((a) => a.id)).toEqual(['a1', 'a3'])
    expect(body.automations[0]!.prompt).toBe('/triage')
    expect(body.runs).toEqual([expect.objectContaining({ id: 'r1', queuedAt: new Date(DAY).toISOString() })])
  })
})

describe('POST and PATCH /v1/automations', () => {
  it('adds an automation off, in the session profile, with the first agent by default', async () => {
    const { control, defs } = setup()
    const r = await control.create({ session: 'sess-work', automation: { name: 'Nightly', prompt: '/nightly', triggers: { intervalMinutes: 60 } } }, q(''))
    expect(r.status).toBe(200)
    const saved = defs().find((d) => d.id === 'new1')!
    expect(saved).toMatchObject({ name: 'Nightly', enabled: false, profileId: 'work', agentKey: 'claude', folder: '~' })
    expect(saved.triggers.intervalMinutes).toBe(60)
    expect(r.body['note']).toMatch(/off until the user/)
  })

  it('refuses a nameless automation, an unknown agent and bad values', async () => {
    const { control } = setup()
    expect((await control.create({ session: 'sess-work', automation: { prompt: '/x' } }, q(''))).status).toBe(400)
    const agent = await control.create({ session: 'sess-work', automation: { name: 'x', agentKey: 'nope' } }, q(''))
    expect(agent).toMatchObject({ status: 400, body: { error: expect.stringMatching(/unknown agent/) } })
    const view = await control.create({ session: 'sess-work', automation: { name: 'x', view: 'tv' } }, q(''))
    expect(view).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^view:/) } })
  })

  it('edits an automation and turns it off; another profile\'s is unknown', async () => {
    const { control, defs } = setup()
    const r = await control.update('a1', { session: 'sess-work', automation: { triggers: { intervalMinutes: 30 } } }, q(''))
    expect(r.status).toBe(200)
    const a1 = defs().find((d) => d.id === 'a1')!
    expect(a1).toMatchObject({ enabled: false, prompt: '/triage', profileId: 'work' })
    expect(a1.triggers.intervalMinutes).toBe(30)
    expect((await control.update('a2', { session: 'sess-work', automation: { prompt: '/x' } }, q(''))).status).toBe(404)
    expect((await control.update('bad id!', { session: 'sess-work', automation: {} }, q(''))).status).toBe(400)
  })

  it('answers 403 to a read-only session and 404 to an unknown one', async () => {
    const { control } = setup()
    expect((await control.create({ session: 'sess-review', automation: { name: 'x' } }, q(''))).status).toBe(403)
    expect((await control.update('a1', { session: 'sess-review', automation: { prompt: '/x' } }, q(''))).status).toBe(403)
    expect((await control.create({ session: 'gone', automation: { name: 'x' } }, q(''))).status).toBe(404)
  })
})

describe('GET /v1/history', () => {
  it('lists past sessions newest first, filtered and capped', async () => {
    const { control } = setup()
    const all = await control.history(q('session=sess-review'))
    expect(all.body).toMatchObject({ ok: true, total: 3 })
    const filtered = await control.history(q('q=deploy&folder=/w/acme'))
    expect(filtered.body['entries']).toEqual([expect.objectContaining({ agentSessionId: 's-2', automationId: 'a1', cwd: '/w/acme/api', lastModified: new Date(DAY).toISOString() })])
    expect((await control.history(q('agent=codex'))).body['total']).toBe(1)
    expect((await control.history(q('automation=a1'))).body['total']).toBe(1)
    expect((await control.history(q('limit=1'))).body).toMatchObject({ total: 3, truncated: true })
    expect((await control.history(q('limit=0'))).status).toBe(400)
  })

  it("reads a past session's messages without tool output, text capped", async () => {
    const { control } = setup()
    const r = await control.session('claude', 's-1', q(''))
    expect(r.status).toBe(200)
    const messages = r.body['messages'] as Record<string, unknown>[]
    expect(messages[0]).toEqual({ kind: 'user', at: new Date(DAY).toISOString(), text: 'Fix the login' })
    expect(messages[1]).toEqual({ kind: 'tool', title: 'Read src/login.ts' })
    expect((messages[2]!['text'] as string).length).toBe(4000)
    expect((await control.session('claude', 's-1', q('limit=1'))).body).toMatchObject({ total: 3, truncated: true })
    expect((await control.session('claude', 'nope', q(''))).status).toBe(404)
    expect((await control.session('claude', 'a/b', q(''))).status).toBe(400)
  })

  it('answers 502 when the transcript cannot be read', async () => {
    const { control } = setup({ messages: async () => Promise.reject(new Error('gone')) })
    expect(await control.session('claude', 's-1', q(''))).toMatchObject({ status: 502, body: { error: expect.stringMatching(/gone/) } })
  })
})
