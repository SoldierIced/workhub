/**
 * Automations and History over the control endpoint: what an agent in a Workhub session may read
 * and change of the user's automations, and what it may read of past sessions.
 *
 * An agent never turns an automation on: one it adds starts off, and one it edits is turned off
 * until the user turns it back on in Automations. An automation runs prompts unattended, so the
 * user checks what an agent wrote before it runs. Removing one stays a human action in the UI.
 */
import { automationSchema, automationsForProfile, matchesHistory, type AutomationDefinition, type AutomationRun, type HistoryMessage, type Result, type WorkhubConfig } from '@workhub/core'
import type { HistoryItem, HistoryResult } from '../shared/api'
import type { AutomationsSnapshot, AutomationStatus } from '../shared/chat-api'
import type { ControlReply } from './control-server'
import { resolveControlProfile, type ControlProfileDeps } from './plan-control'

/** Past sessions `GET /v1/history` returns by default and at most. */
export const CONTROL_HISTORY_LIMIT = { default: 30, max: 200 } as const
/** Messages `GET /v1/history/:agent/:session` returns by default and at most (the last ones). */
export const CONTROL_MESSAGES_LIMIT = { default: 50, max: 500 } as const
/** Characters of a title, a first prompt and a message in an answer. */
export const CONTROL_HISTORY_CAP = { title: 200, prompt: 500, message: 4000 } as const
/** Runs `GET /v1/automations` returns, newest first. */
export const CONTROL_RUNS_LIMIT = 20

/** Fields an agent may set on an automation; `id` and `profileId` are Workhub's, `enabled` may only go off. */
const WRITABLE = new Set(Object.keys(automationSchema.shape).filter((k) => k !== 'id' && k !== 'profileId'))
/** Fields that are objects: a change merges into the stored value instead of replacing it. */
const NESTED = new Set(['triggers', 'window', 'limits'])
const AUTOMATION_ID = /^[\w.:-]{1,200}$/
const AGENT_ID = /^[\w.-]{1,100}$/
const AGENT_SESSION_ID = /^[\w.:-]{1,200}$/

export interface AutomationControlDeps extends ControlProfileDeps {
  snapshot: () => AutomationsSnapshot
  save: (automation: AutomationDefinition) => Promise<Result<WorkhubConfig>>
  /** The agent keys (`agentId[:accountId]`) a profile offers. */
  agentKeys: (profileId: string) => Promise<string[]>
  history: () => Promise<HistoryResult>
  /** The messages of a past session (its agent's transcript). */
  messages: (entry: HistoryItem) => Promise<HistoryMessage[]>
  newId: () => string
}

export interface AutomationControl {
  list(params: URLSearchParams): Promise<ControlReply>
  create(body: unknown, params: URLSearchParams): Promise<ControlReply>
  update(id: string, body: unknown, params: URLSearchParams): Promise<ControlReply>
  history(params: URLSearchParams): Promise<ControlReply>
  session(agentId: string, agentSessionId: string, params: URLSearchParams): Promise<ControlReply>
}

const fail = (status: number, error: string): ControlReply => ({ status, body: { ok: false, error } })
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())
const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function askOf(params: URLSearchParams, body?: unknown) {
  const b = isRecord(body) ? body : {}
  return { session: b['session'] ?? params.get('session') ?? undefined, profile: b['profile'] ?? params.get('profile') ?? undefined, cwd: b['cwd'] ?? params.get('cwd') ?? undefined }
}

function limitOf(raw: string | null, limits: { default: number; max: number }): number | string {
  if (raw === null || raw === '') return limits.default
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return '"limit" must be a positive whole number'
  return Math.min(n, limits.max)
}

/** One automation as an agent sees it: its definition and what it is doing now. */
export function automationAnswer(s: AutomationStatus): Record<string, unknown> {
  return {
    ...s.definition,
    health: s.health,
    active: s.active,
    startedToday: s.startedToday,
    ...(s.waitReason ? { waitReason: s.waitReason } : {}),
    ...(s.lastError ? { lastError: s.lastError } : {}),
    ...(s.pausedUntil ? { pausedUntil: iso(s.pausedUntil) } : {}),
    ...(s.nextIntervalAt ? { nextIntervalAt: iso(s.nextIntervalAt) } : {})
  }
}

function runAnswer(r: AutomationRun): Record<string, unknown> {
  return {
    id: r.id,
    automationId: r.automationId,
    automationName: r.automationName,
    trigger: r.trigger,
    outcome: r.outcome,
    queuedAt: iso(r.queuedAt),
    ...(r.startedAt ? { startedAt: iso(r.startedAt) } : {}),
    ...(r.endedAt ? { endedAt: iso(r.endedAt) } : {}),
    ...(r.detail ? { detail: cap(r.detail, CONTROL_HISTORY_CAP.prompt) } : {}),
    ...(r.cost ? { cost: r.cost } : {}),
    ...(r.tokens !== undefined ? { tokens: r.tokens } : {})
  }
}

/**
 * The fields of a create or edit body (`{ "automation": { ... } }`), checked by name; a string
 * when the body is not one. `enabled: true` is refused: only the user turns an automation on.
 */
export function parseAutomationFields(body: unknown): Record<string, unknown> | string {
  if (!isRecord(body)) return 'the body must be a JSON object'
  const fields = body['automation']
  if (!isRecord(fields)) return '"automation" must be an object with the fields to set'
  for (const key of Object.keys(fields)) {
    if (key === 'id' || key === 'profileId') return `"${key}" is set by Workhub`
    if (!WRITABLE.has(key)) return `unknown field "${key}"`
  }
  if (fields['enabled'] === true) return 'an agent cannot turn an automation on: the user does it in Automations'
  for (const key of NESTED) if (fields[key] !== undefined && !isRecord(fields[key])) return `"${key}" must be an object`
  return fields
}

/** The stored automation with the fields merged in (`triggers`, `window`, `limits` one level deep), always off. */
export function mergeAutomation(base: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(fields)) out[key] = NESTED.has(key) && isRecord(base[key]) ? { ...(base[key] as Record<string, unknown>), ...(value as Record<string, unknown>) } : value
  out['enabled'] = false
  return out
}

/** One past session as an agent sees it. */
export function historyAnswer(e: HistoryItem): Record<string, unknown> {
  return {
    agentId: e.agentId,
    agentName: e.agentName,
    ...(e.accountId ? { accountId: e.accountId } : {}),
    ...(e.accountName ? { accountName: e.accountName } : {}),
    agentSessionId: e.agentSessionId,
    title: cap(e.title, CONTROL_HISTORY_CAP.title),
    ...(e.firstPrompt ? { firstPrompt: cap(e.firstPrompt, CONTROL_HISTORY_CAP.prompt) } : {}),
    ...(e.cwd ? { cwd: e.cwd } : {}),
    ...(e.gitBranch ? { gitBranch: e.gitBranch } : {}),
    lastModified: iso(e.lastModified),
    ...(e.createdAt ? { createdAt: iso(e.createdAt) } : {}),
    ...(e.automationId ? { automationId: e.automationId, automationName: e.automationName } : {}),
    resumable: e.resumable
  }
}

/** One message of a past session: text capped, images and tool output left out. */
export function messageAnswer(m: HistoryMessage): Record<string, unknown> {
  const at = m.at ? { at: iso(m.at) } : {}
  switch (m.kind) {
    case 'user':
      return { kind: 'user', ...at, text: cap(m.text, CONTROL_HISTORY_CAP.message), ...(m.images ? { images: m.images } : {}) }
    case 'agent':
      return { kind: 'agent', ...at, text: cap(m.text, CONTROL_HISTORY_CAP.message) }
    case 'notice':
      return { kind: 'notice', ...at, title: m.title, text: cap(m.text, CONTROL_HISTORY_CAP.prompt) }
    case 'compaction':
      return { kind: 'compaction', ...at, ...(m.summary ? { summary: cap(m.summary, CONTROL_HISTORY_CAP.message) } : {}) }
    case 'interrupted':
      return { kind: 'interrupted', ...at }
    case 'tool':
      return { kind: 'tool', ...at, title: cap(m.title, CONTROL_HISTORY_CAP.title), ...(m.failed ? { failed: true } : {}) }
  }
}

export function createAutomationControl(deps: AutomationControlDeps): AutomationControl {
  /** Checks the merged automation, its agent and the profile, then stores it. */
  async function store(merged: Record<string, unknown>, profileId: string, created: boolean): Promise<ControlReply> {
    const parsed = automationSchema.safeParse(merged)
    if (!parsed.success) return fail(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'automation'}: ${i.message}`).join('; '))
    const automation = parsed.data as AutomationDefinition
    if (!(await deps.agentKeys(profileId)).includes(automation.agentKey)) return fail(400, `unknown agent "${automation.agentKey}" for this profile`)
    const r = await deps.save(automation)
    if (!r.ok) return fail(400, r.issues.map((i) => i.message).join('; '))
    const status = deps.snapshot().automations.find((s) => s.definition.id === automation.id)
    return { status: 200, body: { ok: true, created, automation: status ? automationAnswer(status) : automation, note: 'The automation is off until the user turns it on in Automations.' } }
  }

  return {
    async list(params) {
      const who = await resolveControlProfile(deps, askOf(params))
      if (!who.ok) return fail(who.status, who.error)
      const snap = deps.snapshot()
      const visible = automationsForProfile(snap.automations.map((s) => s.definition), who.profileId, false)
      const ids = new Set(visible.map((d) => d.id))
      const automations = snap.automations.filter((s) => ids.has(s.definition.id))
      const runs = snap.runs.filter((r) => ids.has(r.automationId)).slice(0, CONTROL_RUNS_LIMIT)
      return { status: 200, body: { ok: true, automations: automations.map(automationAnswer), runs: runs.map(runAnswer) } }
    },
    async create(body, params) {
      const fields = parseAutomationFields(body)
      if (typeof fields === 'string') return fail(400, fields)
      const who = await resolveControlProfile(deps, askOf(params, body), { write: true })
      if (!who.ok) return fail(who.status, who.error)
      if (typeof fields['name'] !== 'string' || !fields['name'].trim()) return fail(400, 'a new automation needs a "name"')
      if (fields['agentKey'] === undefined) {
        const first = (await deps.agentKeys(who.profileId))[0]
        if (!first) return fail(409, 'this profile offers no agent')
        fields['agentKey'] = first
      }
      return store(mergeAutomation({ id: deps.newId(), profileId: who.profileId }, fields), who.profileId, true)
    },
    async update(id, body, params) {
      if (!AUTOMATION_ID.test(id)) return fail(400, 'bad automation id')
      const fields = parseAutomationFields(body)
      if (typeof fields === 'string') return fail(400, fields)
      const who = await resolveControlProfile(deps, askOf(params, body), { write: true })
      if (!who.ok) return fail(who.status, who.error)
      const current = automationsForProfile(deps.snapshot().automations.map((s) => s.definition), who.profileId, false).find((d) => d.id === id)
      if (!current) return fail(404, 'unknown automation')
      return store(mergeAutomation(current as unknown as Record<string, unknown>, fields), current.profileId ?? who.profileId, false)
    },
    async history(params) {
      const who = await resolveControlProfile(deps, askOf(params))
      if (!who.ok) return fail(who.status, who.error)
      const limit = limitOf(params.get('limit'), CONTROL_HISTORY_LIMIT)
      if (typeof limit === 'string') return fail(400, limit)
      const q = params.get('q') ?? ''
      const agent = params.get('agent')
      const automation = params.get('automation')
      const folder = params.get('folder')
      const result = await deps.history()
      const entries = result.entries.filter(
        (e) => matchesHistory(e, q) && (!agent || e.agentId === agent) && (!automation || e.automationId === automation) && (!folder || e.cwd === folder || e.cwd?.startsWith(folder.replace(/[\\/]+$/, '') + '/'))
      )
      return {
        status: 200,
        body: {
          ok: true,
          entries: entries.slice(0, limit).map(historyAnswer),
          total: entries.length,
          ...(entries.length > limit ? { truncated: true } : {}),
          ...(result.errors.length ? { errors: result.errors } : {})
        }
      }
    },
    async session(agentId, agentSessionId, params) {
      if (!AGENT_ID.test(agentId) || !AGENT_SESSION_ID.test(agentSessionId)) return fail(400, 'bad agent or session id')
      const who = await resolveControlProfile(deps, askOf(params))
      if (!who.ok) return fail(who.status, who.error)
      const limit = limitOf(params.get('limit'), CONTROL_MESSAGES_LIMIT)
      if (typeof limit === 'string') return fail(400, limit)
      const account = params.get('account')
      const entry = (await deps.history()).entries.find((e) => e.agentId === agentId && e.agentSessionId === agentSessionId && (!account || e.accountId === account))
      if (!entry) return fail(404, 'unknown past session')
      let messages: HistoryMessage[]
      try {
        messages = await deps.messages(entry)
      } catch (e) {
        return fail(502, `the transcript could not be read: ${e instanceof Error ? e.message : String(e)}`)
      }
      const last = messages.slice(-limit)
      return { status: 200, body: { ok: true, session: historyAnswer(entry), messages: last.map(messageAnswer), total: messages.length, ...(messages.length > limit ? { truncated: true } : {}) } }
    }
  }
}
