import {
  briefContext,
  briefKey,
  briefValues,
  DEFAULT_BRIEF_TEMPLATE,
  genericOneOnOne,
  meetingsWith,
  peopleAt,
  pickAgent,
  plannerSettings,
  profileDefaultFolder,
  renderBriefTemplate,
  resolveEffectiveAgents,
  type BriefContextInput,
  type BriefRecord,
  type CalendarEvent,
  type DrivenSession,
  type Profile,
  type WorkhubConfig
} from '@workhub/core'
import type { SessionView, StartSessionInput } from '../shared/api'
import type { BriefResult, PlanBrief } from '../shared/plan-api'
import type { CalendarStateStore } from './calendar-watcher'

/** How long a new brief session may take to be ready for its prompt. */
export const BRIEF_START_WAIT_MS = 60_000
/** How long the prompt may wait for the session to take it. */
export const BRIEF_DELIVERY_WAIT_MS = 180_000

/** Where and with what a brief runs: the rule's automation, else the profile's preferred agent in its default folder. */
export interface BriefTarget {
  agentKey: string
  cwd: string
  model?: string
  effort?: string
  modeId?: string
  /** Automatic briefs wait while the account's 5 h usage is at or above this percentage. */
  usageThreshold: number
}

export interface BriefServiceDeps {
  config: () => Promise<WorkhubConfig>
  startSession: (input: StartSessionInput) => Promise<SessionView>
  /** The session driver: the live sessions and typing a prompt into one. */
  sessions: { list(): DrivenSession[]; deliver(sessionId: string, text: string): Promise<'delivered' | 'waiting'> }
  /** Names the brief session after its meeting. */
  rename?: (sessionId: string, name: string) => void
  store: CalendarStateStore
  /** Why a brief with this agent must not start now (a usage ceiling, the 5 h guard); null when it may. */
  gate: (config: WorkhubConfig, target: BriefTarget, origin: 'rule' | 'user') => string | null
  /** The user's open pull requests and tickets in progress, for `{context}`; empty lists when unknown. */
  context: (profileId: string) => Promise<Omit<BriefContextInput, 'people'>>
  /** Words an instant for the prompt, in the user's language. */
  formatTime: (ms: number) => string
  /** `~` expanded; whether a folder exists. */
  resolveFolder: (folder: string) => Promise<string | null>
  home: string
  /** A brief changed (started, failed, its session moved on). */
  changed: (profileId: string) => void
  /** Whether the agent of an agent key resumes by its session id (Claude). */
  resumes: (config: WorkhubConfig, agentKey: string) => boolean
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

/**
 * Starts meeting briefs: a dedicated session of the profile's agent (or a rule's automation's agent
 * and folder) that gets the profile's brief prompt filled for the event. One brief per event
 * instance, ever: a second ask opens the session of the first. The automations' usage guards apply.
 */
export class BriefService {
  private readonly starting = new Set<string>()
  private readonly now: () => number
  private readonly wait: (ms: number) => Promise<void>

  constructor(private readonly deps: BriefServiceDeps) {
    this.now = deps.now ?? Date.now
    this.wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** The briefs of a profile by event id, with where each one is now. */
  views(profileId: string): Record<string, PlanBrief> {
    const live = this.deps.sessions.list()
    const out: Record<string, PlanBrief> = {}
    for (const b of Object.values(this.deps.store.get().briefs)) {
      if (b.profileId !== profileId) continue
      const session = live.find((s) => (b.sessionId && s.id === b.sessionId) || (b.identity && s.identity === b.identity))
      const open = session && session.state !== 'stopped' && session.state !== 'error'
      const phase: PlanBrief['phase'] = b.status === 'failed' ? 'failed' : b.status === 'starting' ? 'preparing' : !open ? 'closed' : session.state === 'ready' && session.turnsEnded > 0 ? 'ready' : 'preparing'
      out[b.eventId] = { eventId: b.eventId, phase, at: b.at, ...(open ? { sessionId: session.id } : {}), ...(b.error ? { error: b.error } : {}) }
    }
    return out
  }

  /** Where a brief runs for this profile (and rule automation, when named); null when no agent can. */
  async target(config: WorkhubConfig, profile: Profile, automationId?: string): Promise<BriefTarget | { error: string }> {
    const automation = automationId ? config.automations?.find((a) => a.id === automationId) : undefined
    if (automation) {
      const cwd = await this.deps.resolveFolder(automation.folder || '~')
      if (!cwd) return { error: `folder not found: ${automation.folder}` }
      return { agentKey: automation.agentKey, cwd, usageThreshold: automation.usageThreshold, ...(automation.model ? { model: automation.model } : {}), ...(automation.effort ? { effort: automation.effort } : {}), ...(automation.permissionMode ? { modeId: automation.permissionMode } : {}) }
    }
    const agent = pickAgent(profile, resolveEffectiveAgents(config, profile.id), 'appMode')
    if (!agent) return { error: 'no agent with a chat is available in this profile' }
    const cwd = await this.deps.resolveFolder(profileDefaultFolder(profile, this.deps.home) ?? '~')
    return { agentKey: agent.key, cwd: cwd ?? this.deps.home, usageThreshold: 85 }
  }

  /**
   * The brief of an event: opens the one already started, else starts it. `ruleId` marks a brief a
   * rule started (it waits behind the usage guards instead of asking).
   */
  async brief(profileId: string, event: CalendarEvent, options: { ruleId?: string; automationId?: string } = {}): Promise<BriefResult> {
    const key = briefKey(profileId, event.id)
    const existing = this.deps.store.get().briefs[key]
    if (existing && existing.status !== 'failed') return this.open(existing)
    if (this.starting.has(key)) return { ok: false, error: 'The brief is starting' }
    this.starting.add(key)
    try {
      return await this.start(profileId, event, options)
    } finally {
      this.starting.delete(key)
    }
  }

  /** The session of a brief already started for an event no longer read (a generic 1:1, a past meeting). */
  async openById(profileId: string, eventId: string): Promise<BriefResult> {
    const record = this.deps.store.get().briefs[briefKey(profileId, eventId)]
    return record && record.status !== 'failed' ? this.open(record) : { ok: false, error: 'This meeting is no longer on the calendar' }
  }

  /** "Prepare 1:1": the next meeting with the person, else a generic 1:1 brief (kept like any other). */
  async oneOnOne(profileId: string, personId: string, events: readonly CalendarEvent[]): Promise<BriefResult> {
    const config = await this.deps.config()
    const person = plannerSettings(config.profiles.find((p) => p.id === profileId)).people.find((p) => p.id === personId)
    if (!person) return { ok: false, error: 'This person is no longer in the list' }
    const next = meetingsWith(person, events, this.now())[0]
    return this.brief(profileId, next ?? genericOneOnOne(person, this.now()))
  }

  private record(key: string, record: BriefRecord): void {
    this.deps.store.update((s) => ({ ...s, briefs: { ...s.briefs, [key]: record } }))
    this.deps.changed(record.profileId)
  }

  private async start(profileId: string, event: CalendarEvent, options: { ruleId?: string; automationId?: string }): Promise<BriefResult> {
    const key = briefKey(profileId, event.id)
    const config = await this.deps.config()
    const profile = config.profiles.find((p) => p.id === profileId)
    const base: BriefRecord = { profileId, eventId: event.id, title: event.title, start: event.start, at: this.now(), status: 'starting', ...(options.ruleId ? { ruleId: options.ruleId } : {}) }
    const fail = (error: string): BriefResult => {
      this.record(key, { ...base, status: 'failed', error })
      return { ok: false, error }
    }
    if (!profile) return fail('The profile no longer exists')
    const target = await this.target(config, profile, options.automationId)
    if ('error' in target) return fail(target.error)
    const blocked = this.deps.gate(config, target, options.ruleId ? 'rule' : 'user')
    if (blocked) return fail(blocked)

    const settings = plannerSettings(profile)
    const people = peopleAt(event, settings.people)
    const known = await this.deps.context(profileId).catch(() => ({ mine: [], tickets: [] }))
    const prompt = renderBriefTemplate(settings.briefTemplate.trim() || DEFAULT_BRIEF_TEMPLATE, briefValues(event, { people: settings.people, context: briefContext({ ...known, people }), formatTime: this.deps.formatTime }))
    const running: BriefRecord = { ...base, agentKey: target.agentKey, cwd: target.cwd }
    this.record(key, running)
    try {
      const view = await this.deps.startSession({
        profileId,
        agentKey: target.agentKey,
        cwd: target.cwd,
        mode: 'app',
        cols: 120,
        rows: 32,
        ...(target.model ? { model: target.model } : {}),
        ...(target.effort ? { effort: target.effort } : {}),
        ...(target.modeId ? { modeId: target.modeId } : {})
      })
      this.deps.rename?.(view.id, `Brief: ${event.title || 'meeting'}`.slice(0, 80))
      const session = await this.ready(view.id)
      if (!session) return fail('The brief session did not start in time')
      const delivered = await this.deliver(view.id, prompt)
      if (!delivered) return fail('The brief session did not take the prompt in time')
      const identity = this.deps.sessions.list().find((s) => s.id === view.id)?.identity ?? session.identity
      this.record(key, { ...running, status: 'started', sessionId: view.id, identity })
      return { ok: true, sessionId: view.id, existing: false }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  /** Waits for a new session to be ready for its prompt. */
  private async ready(sessionId: string): Promise<DrivenSession | null> {
    const until = this.now() + BRIEF_START_WAIT_MS
    for (;;) {
      const s = this.deps.sessions.list().find((x) => x.id === sessionId)
      if (!s || s.state === 'stopped' || s.state === 'error') return null
      if (s.state === 'ready') return s
      if (this.now() >= until) return null
      await this.wait(250)
    }
  }

  private async deliver(sessionId: string, prompt: string): Promise<boolean> {
    const until = this.now() + BRIEF_DELIVERY_WAIT_MS
    for (;;) {
      if ((await this.deps.sessions.deliver(sessionId, prompt)) === 'delivered') return true
      if (this.now() >= until) return false
      await this.wait(500)
    }
  }

  /** The session of a brief already started: the open one, else resumed (Claude) or reopened under its identity. */
  private async open(record: BriefRecord): Promise<BriefResult> {
    if (record.status === 'starting') return { ok: false, error: 'The brief is starting' }
    const live = this.deps.sessions.list().find((s) => ((record.sessionId && s.id === record.sessionId) || (record.identity && s.identity === record.identity)) && s.state !== 'stopped' && s.state !== 'error')
    if (live) return { ok: true, sessionId: live.id, existing: true }
    if (!record.identity || !record.agentKey) return { ok: false, error: 'The brief session is closed' }
    const config = await this.deps.config()
    const cwd = (record.cwd && (await this.deps.resolveFolder(record.cwd))) || this.deps.home
    const resume = this.deps.resumes(config, record.agentKey) ? { resumeAgentSessionId: record.identity } : { identity: record.identity }
    try {
      const view = await this.deps.startSession({ profileId: record.profileId, agentKey: record.agentKey, cwd, mode: 'app', cols: 120, rows: 32, ...resume })
      this.record(briefKey(record.profileId, record.eventId), { ...record, sessionId: view.id })
      return { ok: true, sessionId: view.id, existing: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
