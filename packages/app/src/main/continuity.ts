/**
 * Session continuity across accounts and agents.
 *
 * - Account failover: a Claude session whose account ran out (the agent reported a usage limit,
 *   or Workhub's gate held a prompt past the user's ceiling) continues in another Claude account
 *   of the profile with the same session id: the session stops, its transcript and sidecars are
 *   copied to the other account's folder (never overwriting, never moving), and it resumes there.
 *   Its identity is the agent's session id, so it keeps its sidebar group and position.
 * - Hand-off: a new session of another agent, in the same folder, with a brief of the source
 *   session drafted in its composer (never sent), placed next to the source in the sidebar.
 *
 * The rules live in core (`failoverTargets`, `planFailover`, `buildHandoffBrief`); this service
 * only wires them to the sessions, the budgets and the file copy.
 */
import {
  accountAgentId,
  buildHandoffBrief,
  EMPTY_FACTS,
  effectiveAgentKey,
  failoverMode,
  failoverTargets,
  handoffTargets,
  HANDOFF_SUMMARY_PROMPT,
  knownAgents,
  planFailover,
  resolveEffectiveAgents,
  sessionIdentity,
  type AgentAccount,
  type AgentDefinition,
  type AgentEvent,
  type BudgetStatus,
  type FailoverCandidate,
  type FailoverReason,
  type GitSnapshot,
  type GroupMember,
  type HandoffFacts,
  type Profile,
  type SessionOrigin,
  type WorkhubConfig
} from '@workhub/core'
import type { SessionView, StartSessionInput } from '../shared/api'
import type { ContinuityMoved, ContinuityOffer, ContinuityOptions, FailoverRequest, HandoffRequest, HandoffResult } from '../shared/continuity-api'

/** What the service needs from the session manager. */
export interface ContinuitySessions {
  list(): SessionView[]
  start(input: StartSessionInput, internal?: { origin?: SessionOrigin }): Promise<SessionView>
  stop(id: string): Promise<void>
  prompt(id: string, text: string): Promise<string>
  remove(id: string): boolean
}

export interface ContinuityDeps {
  config: () => Promise<WorkhubConfig>
  sessions: ContinuitySessions
  budgetOf: (agentId: string, accountId: string | null) => BudgetStatus
  /** The resolved Claude config folder a session of this account uses (the default folder for null). */
  claudeConfigDir: (account: AgentAccount | null, config: WorkhubConfig) => string
  /** Copies a session to another account's folder (adapters `copyClaudeSession`); throws on a conflict. */
  copySession: (input: { sessionId: string; cwd: string; sourceConfigDir: string; targetConfigDir: string; dryRun?: boolean }) => Promise<unknown>
  /** The facts of a session's brief, from its agent's transcript. */
  facts: (view: SessionView, agent: AgentDefinition | undefined, account: AgentAccount | null, config: WorkhubConfig) => Promise<HandoffFacts>
  git: (cwd: string) => Promise<GitSnapshot | null>
  /** Puts a session right after another in the sidebar groups (core `placeBeside`). */
  placeBeside: (member: GroupMember, anchorKey: string) => Promise<void>
  emitOffer: (offer: ContinuityOffer) => void
  emitMoved: (moved: ContinuityMoved) => void
  /** Shows a prompt Workhub typed into a session's chat, as the automations do. */
  showPrompt: (sessionId: string, text: string) => void
  /** Shows the end of that prompt's turn in the chat, as for the user's own turns. */
  showTurnEnd?: (sessionId: string, stopReason: string) => void
  now?: () => number
  /** How long a moved session may take to be ready for the held prompt. */
  readyTimeoutMs?: number
  /** How long the source agent gets to write the summary. */
  summaryTimeoutMs?: number
  /** A limit reported while the turn is still finishing is acted on when it ends, or after this. */
  settleMs?: number
}

/**
 * What a session moved by itself after a usage limit is told: the limit cut its last turn, and
 * the transcript it resumes still holds that turn's request.
 */
export const CONTINUE_AFTER_LIMIT_PROMPT = 'The previous account ran out of usage before you could finish. Continue where you left off.'

/** How long an account that reported a limit without a reset time is left out of failover. */
const LIMIT_FALLBACK_MS = 60 * 60_000

const isLive = (v: SessionView): boolean => v.state === 'ready' || v.state === 'busy' || v.state === 'starting'

interface PendingLimit {
  window?: string
  resetsAt?: number
  timer: ReturnType<typeof setTimeout>
}

interface Context {
  config: WorkhubConfig
  view: SessionView
  profile: Profile | undefined
  agent: AgentDefinition | undefined
  account: AgentAccount | null
}

export class ContinuityService {
  private readonly pending = new Map<string, PendingLimit>()
  /** Session id -> when its last limit was handled, so the several signals of one refusal count once. */
  private readonly handled = new Map<string, number>()
  /** `EffectiveAgent.key` -> until when that account is known to be out of usage. */
  private readonly limitedUntil: Record<string, number> = {}
  private readonly moving = new Set<string>()
  private readonly waiters = new Map<string, ((v: SessionView) => void)[]>()
  /** Agent text collected while a source writes its hand-off summary. */
  private readonly collecting = new Map<string, string[]>()

  constructor(private readonly deps: ContinuityDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // Event streams of the session manager

  onEvent(e: AgentEvent): void {
    if (e.type === 'message' && e.role === 'agent') this.collecting.get(e.sessionId)?.push(e.text)
    if (e.type !== 'usageLimit' || e.sessionId.includes(':')) return
    const last = this.handled.get(e.sessionId)
    if (last !== undefined && this.now() - last < 60_000) return
    const p = this.pending.get(e.sessionId)
    if (p) {
      p.window ??= e.window
      p.resetsAt ??= e.resetsAt
      return
    }
    const timer = setTimeout(() => void this.settle(e.sessionId), this.deps.settleMs ?? 3_000)
    timer.unref?.()
    this.pending.set(e.sessionId, { window: e.window, resetsAt: e.resetsAt, timer })
  }

  onChanged(view: SessionView): void {
    if (view.state !== 'busy' && view.state !== 'starting' && this.pending.has(view.id)) void this.settle(view.id)
    const waiting = this.waiters.get(view.id)
    if (waiting && view.state !== 'starting') {
      this.waiters.delete(view.id)
      for (const w of waiting) w(view)
    }
  }

  // What a session can do

  async options(sessionId: string): Promise<ContinuityOptions> {
    const ctx = await this.context(sessionId)
    return {
      sessionId,
      mode: failoverMode(ctx.profile),
      failover: this.failoverCandidates(ctx).map((t) => ({ key: t.key, label: t.label, budget: t.budget })),
      handoff: this.handoffCandidates(ctx).map((e) => ({ key: e.key, label: e.label })),
      canSummarize: ctx.view.state === 'ready' && ctx.view.mode === 'app' && !ctx.view.readOnly
    }
  }

  /** Continues a Claude session in another account; returns the session that runs there. */
  async failover(sessionId: string, request: FailoverRequest): Promise<SessionView> {
    if (this.moving.has(sessionId)) throw new Error('This session is already moving to another account.')
    this.moving.add(sessionId)
    try {
      return await this.move(await this.context(sessionId), request)
    } finally {
      this.moving.delete(sessionId)
    }
  }

  /** Opens a session of another agent in the same folder with a brief of this one. */
  async handoff(sessionId: string, request: HandoffRequest): Promise<HandoffResult> {
    const ctx = await this.context(sessionId)
    const target = this.handoffCandidates(ctx).find((e) => e.key === request.targetKey)
    if (!target) throw new Error(`${request.targetKey} cannot take this session over in this profile.`)

    let summary: string | undefined
    let summaryFailed = false
    if (request.summarize) {
      summary = await this.askSummary(ctx).catch(() => undefined)
      summaryFailed = !summary
    }
    const [facts, git] = await Promise.all([
      this.deps.facts(ctx.view, ctx.agent, ctx.account, ctx.config).catch(() => EMPTY_FACTS),
      this.deps.git(ctx.view.cwd).catch(() => null)
    ])
    const brief = buildHandoffBrief(facts, { sourceLabel: ctx.view.label, cwd: ctx.view.cwd, git, ...(summary ? { summary } : {}) })
    const origin: SessionOrigin = { kind: 'handoff', fromLabel: ctx.view.label, fromIdentity: sessionIdentity(ctx.view) }
    const view = await this.deps.sessions.start({ profileId: ctx.view.profileId, agentKey: target.key, cwd: ctx.view.cwd, mode: 'app', cols: 100, rows: 30 }, { origin })
    // Next to the source in the sidebar, under the new session's provisional identity: an agent that
    // reports its real id later moves the place with it (replaceSessionIdentity).
    await this.deps
      .placeBeside({ key: sessionIdentity(view), title: view.agentName, agentKey: effectiveAgentKey(view.agentId, view.accountId), cwd: view.cwd }, sessionIdentity(ctx.view))
      .catch(() => undefined)
    return { view, brief, ...(summaryFailed ? { summaryFailed: true } : {}) }
  }

  // Internals

  private async context(sessionId: string): Promise<Context> {
    const view = this.deps.sessions.list().find((v) => v.id === sessionId)
    if (!view) throw new Error(`unknown session ${sessionId}`)
    const config = await this.deps.config()
    return {
      config,
      view,
      profile: config.profiles.find((p) => p.id === view.profileId),
      agent: knownAgents(config).find((a) => a.id === view.agentId),
      account: view.accountId ? (config.accounts.find((a) => a.id === view.accountId) ?? null) : null
    }
  }

  /** Only the native Claude adapter resumes a session by id in another account. */
  private failoverCandidates(ctx: Context): FailoverCandidate[] {
    if (!ctx.agent || ctx.agent.id !== 'claude' || ctx.agent.adapter !== 'native' || !ctx.view.agentSessionId) return []
    return failoverTargets({
      profile: ctx.profile,
      candidates: resolveEffectiveAgents(ctx.config, ctx.view.profileId),
      source: { agentId: ctx.agent.id, accountId: ctx.view.accountId, configDir: this.deps.claudeConfigDir(ctx.account, ctx.config) },
      configDirOf: (a) => this.deps.claudeConfigDir(a, ctx.config),
      budgetOf: this.deps.budgetOf,
      limitedUntil: this.limitedUntil,
      now: this.now()
    })
  }

  private handoffCandidates(ctx: Context) {
    return handoffTargets(ctx.profile, resolveEffectiveAgents(ctx.config, ctx.view.profileId), {
      agentId: ctx.view.agentId,
      accountId: ctx.view.accountId,
      family: ctx.agent ? accountAgentId(ctx.agent) : ctx.view.agentId
    })
  }

  private async settle(sessionId: string): Promise<void> {
    const p = this.pending.get(sessionId)
    if (!p) return
    this.pending.delete(sessionId)
    clearTimeout(p.timer)
    this.handled.set(sessionId, this.now())
    let ctx: Context
    try {
      ctx = await this.context(sessionId)
    } catch {
      return
    }
    // That account is out until it resets: no failover goes back to it meanwhile.
    this.limitedUntil[effectiveAgentKey(ctx.view.agentId, ctx.view.accountId)] = p.resetsAt ?? this.now() + LIMIT_FALLBACK_MS
    const targets = this.failoverCandidates(ctx)
    const plan = planFailover(failoverMode(ctx.profile), 'limit', targets)
    if (plan.kind === 'none') return
    if (plan.kind === 'switch') {
      try {
        await this.failover(sessionId, { targetKey: plan.target.key, reason: 'limit', window: p.window, prompt: CONTINUE_AFTER_LIMIT_PROMPT })
        return
      } catch {
        // Fall back to asking: the user still gets the choices.
      }
    }
    const handoff = this.handoffCandidates(ctx)[0]
    const target = plan.kind === 'ask' ? plan.target : undefined
    this.deps.emitOffer({
      sessionId,
      reason: 'limit',
      accountLabel: ctx.view.accountName ?? ctx.view.label,
      ...(p.window ? { window: p.window } : {}),
      ...(p.resetsAt !== undefined ? { resetsAt: p.resetsAt } : {}),
      ...(target ? { target: { key: target.key, label: target.label, budget: target.budget } } : {}),
      ...(handoff ? { handoff: { key: handoff.key, label: handoff.label } } : {})
    })
  }

  private async move(ctx: Context, request: FailoverRequest): Promise<SessionView> {
    const { view } = ctx
    if (view.state === 'busy') throw new Error('The session is working: wait for the turn to end, or interrupt it, before moving it.')
    const targets = this.failoverCandidates(ctx)
    const target = request.targetKey ? targets.find((t) => t.key === request.targetKey) : targets[0]
    if (!target) throw new Error(targets.length || !request.targetKey ? 'No other Claude account in this profile is under its ceiling.' : `${request.targetKey} cannot take this session now.`)
    const targetAccount = target.accountId ? (ctx.config.accounts.find((a) => a.id === target.accountId) ?? null) : null
    const copy = {
      sessionId: view.agentSessionId!,
      cwd: view.cwd,
      sourceConfigDir: this.deps.claudeConfigDir(ctx.account, ctx.config),
      targetConfigDir: this.deps.claudeConfigDir(targetAccount, ctx.config)
    }
    // Plan first (throws on a conflict or a missing transcript) so a refused move leaves the session running.
    await this.deps.copySession({ ...copy, dryRun: true })
    // Stop before copying: Claude ends cleanly and nothing writes to the transcript while it is copied.
    if (isLive(view)) await this.deps.sessions.stop(view.id)
    const sourceKey = effectiveAgentKey(view.agentId, view.accountId)
    const restart = (key: string, origin?: SessionOrigin) =>
      this.deps.sessions.start(
        { profileId: view.profileId, agentKey: key, cwd: view.cwd, mode: 'app', resumeAgentSessionId: view.agentSessionId, cols: 100, rows: 30, ...(view.currentModelId ? { model: view.currentModelId } : {}) },
        origin ? { origin } : {}
      )
    try {
      await this.deps.copySession(copy)
    } catch (err) {
      // Back where it was: the same conversation in its own account.
      const back = await restart(sourceKey).catch(() => null)
      if (back) {
        this.deps.sessions.remove(view.id)
        this.deps.emitMoved({ fromId: view.id, toId: back.id, origin: view.origin ?? { kind: 'failover', fromLabel: view.label, fromIdentity: sessionIdentity(view) } })
      }
      throw err
    }
    const origin: SessionOrigin = { kind: 'failover', fromLabel: view.label, fromIdentity: sessionIdentity(view), reason: request.reason, ...(request.window ? { window: request.window } : {}) }
    const moved = await restart(target.key, origin)
    this.deps.sessions.remove(view.id)
    this.deps.emitMoved({ fromId: view.id, toId: moved.id, origin })
    if (request.prompt) void this.sendWhenReady(moved.id, request.prompt)
    return moved
  }

  private waitReady(id: string, timeoutMs: number): Promise<SessionView | null> {
    const now = this.deps.sessions.list().find((v) => v.id === id)
    if (now && now.state !== 'starting') return Promise.resolve(now)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      timer.unref?.()
      const list = this.waiters.get(id) ?? []
      list.push((v) => {
        clearTimeout(timer)
        resolve(v)
      })
      this.waiters.set(id, list)
    })
  }

  private async sendWhenReady(id: string, text: string): Promise<void> {
    const view = await this.waitReady(id, this.deps.readyTimeoutMs ?? 120_000)
    if (view?.state !== 'ready') return
    this.deps.showPrompt(id, text)
    const stopReason = await this.deps.sessions.prompt(id, text).catch(() => undefined)
    if (stopReason) this.deps.showTurnEnd?.(id, stopReason)
  }

  /** One turn of the source agent with the fixed summary prompt; its reply is the summary. */
  private async askSummary(ctx: Context): Promise<string | undefined> {
    const { view } = ctx
    if (view.state !== 'ready' || view.mode !== 'app' || view.readOnly) return undefined
    const family = ctx.agent ? accountAgentId(ctx.agent) : view.agentId
    if (this.deps.budgetOf(family, view.accountId).action === 'block') return undefined
    this.collecting.set(view.id, [])
    this.deps.showPrompt(view.id, HANDOFF_SUMMARY_PROMPT)
    try {
      const turn = this.deps.sessions.prompt(view.id, HANDOFF_SUMMARY_PROMPT)
      const timeout = new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), this.deps.summaryTimeoutMs ?? 180_000)
        t.unref?.()
      })
      const stop = await Promise.race([turn, timeout])
      const text = (this.collecting.get(view.id) ?? []).join('').trim()
      return stop === 'end_turn' && text ? text : undefined
    } finally {
      this.collecting.delete(view.id)
    }
  }
}
