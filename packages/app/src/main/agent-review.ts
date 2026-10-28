/**
 * "Review with another agent" in the main process. The session's own agent (the author) gets the
 * brief prompt in its chat and writes a review brief; Workhub starts the reviewer the user picked
 * as a read-only session linked to it, sends it the brief, and then relays between the two: the
 * reviewer's findings to the author, the author's answer back for a re-review, until the reviewer
 * approves or the round limit is reached. Every message goes through the sessions' own prompt
 * path, so both chats show the whole exchange. Unlike the review loop (`ai-review.ts`), nothing is
 * parsed into findings: the texts go from one chat to the other as they are.
 */
import {
  afterVerdict,
  aiReviewSettings,
  briefPromptOf,
  buildAuthorFixPrompt,
  buildLoopReviewerPrompt,
  buildReReviewPrompt,
  defaultReviewer,
  effectiveAgentKey,
  extractReviewBrief,
  gatePrompt,
  MAX_REVIEW_ROUNDS,
  MIN_REVIEW_ROUNDS,
  parseReviewVerdict,
  pushBlockEnv,
  rejectOption,
  resolveEffectiveAgents,
  sessionIdentity,
  type AgentEvent,
  type BudgetStatus,
  type EffectiveAgent,
  type SessionOrigin,
  type WorkhubConfig
} from '@workhub/core'
import type { SessionView, StartSessionInput } from '../shared/api'
import type { AgentReviewOptions, AgentReviewRequest, AgentReviewStartResult, ReviewLoopFailure, ReviewLoopView } from '../shared/ai-review-api'
import type { IpcRegistrar } from './ipc-guard'

export interface AgentReviewDeps {
  config: () => Promise<WorkhubConfig>
  sessions: {
    list(): SessionView[]
    start(input: StartSessionInput, internal?: { env?: Record<string, string>; origin?: SessionOrigin }): Promise<SessionView>
    prompt(id: string, text: string): Promise<string>
    cancel(id: string): Promise<void>
    respondPermission(id: string, requestId: string, optionId: string | null): void
  }
  /** The remotes of a repository, for the reviewer's push block. */
  remotes: (root: string) => Promise<string[]>
  /** Agent id -> whether its executable is installed. */
  availability: (config: WorkhubConfig) => Promise<Record<string, boolean>>
  /** The usage budget of an agent key (`agentId[:accountId]`); every prompt is allowed when unset. */
  budget?: (config: WorkhubConfig, agentKey: string) => BudgetStatus
  /** Shows a prompt Workhub typed as a user message in the session's chat. */
  showPrompt: (sessionId: string, text: string) => void
  /** Shows the end of that prompt's turn in the chat, as for the user's own turns. */
  showTurnEnd?: (sessionId: string, stopReason: string) => void
  /** Puts the reviewer next to the reviewed session in the sidebar. */
  placeBeside?: (member: { key: string; title: string; agentKey: string; cwd: string }, anchorKey: string) => Promise<void>
  emit: (loops: ReviewLoopView[]) => void
  now?: () => number
  /** How long a reviewer may take to start, and an agent to finish a turn. */
  startTimeoutMs?: number
  turnTimeoutMs?: number
  /** How often a waiting turn checks that its session is still alive. */
  pollMs?: number
}

const isLive = (v: SessionView) => v.state !== 'stopped' && v.state !== 'error'
const isEnded = (l: ReviewLoopView) => l.phase === 'approved' || l.phase === 'maxRounds' || l.phase === 'stopped' || l.phase === 'failed'

/** Ends a loop from inside a turn: a failure, or a stop. */
class LoopEnd extends Error {
  constructor(
    readonly end: { failure: ReviewLoopFailure; detail?: string } | { stoppedBy: 'user' | 'cancelled' }
  ) {
    super('failure' in end ? end.failure : 'stopped')
  }
}

interface LoopRun {
  view: ReviewLoopView
  /** The session whose turn the loop waits on, so Stop can interrupt it. */
  waitingOn?: string
  /** Prompts the user allowed past a usage budget ("Run anyway"). */
  override: boolean
}

export class AgentReviewService {
  /** Reviewer session ids: every permission they ask for is refused. */
  private readonly reviewers = new Set<string>()
  private readonly titles = new Map<string, string>()
  private readonly loops = new Map<string, LoopRun>()
  /** Session id -> the agent text of the turn the loop waits on. */
  private readonly replies = new Map<string, string>()
  private seq = 0
  private emitQueued = false

  constructor(private readonly deps: AgentReviewDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  onEvent(e: AgentEvent): void {
    if (e.type === 'message' && e.role === 'agent' && this.replies.has(e.sessionId)) this.replies.set(e.sessionId, this.replies.get(e.sessionId)! + e.text)
    if (this.reviewers.has(e.sessionId)) {
      if (e.type === 'permission') this.deps.sessions.respondPermission(e.sessionId, e.requestId, rejectOption(e.options) ?? null)
      return
    }
    if (e.type === 'monitor' && e.snapshot.title) this.titles.set(e.sessionId, e.snapshot.title)
  }

  private view(sessionId: string): SessionView | undefined {
    return this.deps.sessions.list().find((v) => v.id === sessionId)
  }

  snapshot(): ReviewLoopView[] {
    return [...this.loops.values()].map((r) => r.view)
  }

  private changed(): void {
    if (this.emitQueued) return
    this.emitQueued = true
    queueMicrotask(() => {
      this.emitQueued = false
      this.deps.emit(this.snapshot())
    })
  }

  private set(run: LoopRun, patch: Partial<ReviewLoopView>): void {
    run.view = { ...run.view, ...patch, updatedAt: this.now() }
    this.changed()
  }

  private chatAgents(config: WorkhubConfig, profileId: string | null): EffectiveAgent[] {
    return resolveEffectiveAgents(config, profileId).filter((a) => a.agent.capabilities.appMode && a.agent.adapter !== 'terminal')
  }

  /** What the dialog offers for a session. */
  async options(sessionId: string): Promise<AgentReviewOptions | null> {
    const view = this.view(sessionId)
    if (!view) return null
    const config = await this.deps.config()
    const profile = config.profiles.find((p) => p.id === (view.profileId ?? config.activeProfileId))
    const installed = await this.deps.availability(config).catch(() => ({}) as Record<string, boolean>)
    const agents = this.chatAgents(config, profile?.id ?? null)
    const settings = aiReviewSettings(profile)
    const fallback = defaultReviewer(agents, view.agentId, installed, [...(settings.reviewerAgent ? [settings.reviewerAgent] : []), ...(profile?.preferredAgents ?? [])])
    return {
      reviewers: agents.map((a) => ({ key: a.key, label: a.label, agentId: a.agent.id, adapter: a.agent.adapter, installed: installed[a.agent.id] !== false })),
      ...(fallback ? { defaultReviewerKey: fallback.key } : {}),
      briefPrompt: briefPromptOf(settings),
      maxRounds: settings.maxRounds
    }
  }

  /** Starts the loop on a session; never throws. The loop itself runs on in the background. */
  async start(sessionId: string, request: AgentReviewRequest): Promise<AgentReviewStartResult> {
    const view = this.view(sessionId)
    if (!view || !isLive(view)) return { ok: false, reason: 'unknownSession' }
    if (view.readOnly || this.reviewers.has(view.id)) return { ok: false, reason: 'reviewerSession' }
    if (!view.modes.includes('app') || view.mode === 'console') return { ok: false, reason: 'notChat' }
    if ([...this.loops.values()].some((r) => r.view.authorSessionId === view.id && !isEnded(r.view))) return { ok: false, reason: 'running' }
    if (view.state !== 'ready') return { ok: false, reason: 'authorBusy' }
    const config = await this.deps.config()
    const profile = config.profiles.find((p) => p.id === (view.profileId ?? config.activeProfileId))
    const reviewer = this.chatAgents(config, profile?.id ?? null).find((a) => a.key === request.reviewerKey)
    if (!reviewer) return { ok: false, reason: 'noReviewer' }
    const installed = await this.deps.availability(config).catch(() => ({}) as Record<string, boolean>)
    if (installed[reviewer.agent.id] === false) return { ok: false, reason: 'reviewerMissing', detail: reviewer.agent.command }
    // Started by the user: a usage budget asks for "Run anyway" once, which then covers the whole loop.
    for (const key of [effectiveAgentKey(view.agentId, view.accountId), reviewer.key]) {
      const status = this.deps.budget?.(config, key)
      if (status && gatePrompt(status, 'user', request.override === true).kind !== 'send') return { ok: false, reason: 'budget', detail: status.window ?? '' }
    }
    // A finished loop of this session gives way to the new one.
    for (const [id, r] of this.loops) if (r.view.authorSessionId === view.id) this.loops.delete(id)
    const at = this.now()
    const run: LoopRun = {
      view: { id: `loop-${at}-${++this.seq}`, authorSessionId: view.id, reviewerLabel: reviewer.label, round: 0, maxRounds: request.maxRounds, phase: 'briefing', startedAt: at, updatedAt: at },
      override: request.override === true
    }
    this.loops.set(run.view.id, run)
    this.changed()
    void this.run(run, config, view, reviewer, request.prompt)
    return { ok: true, loopId: run.view.id }
  }

  private async run(run: LoopRun, config: WorkhubConfig, author: SessionView, reviewer: EffectiveAgent, briefPrompt: string): Promise<void> {
    const authorKey = effectiveAgentKey(author.agentId, author.accountId)
    try {
      const reply = await this.turn(run, config, author.id, authorKey, briefPrompt, 'authorClosed')
      const brief = extractReviewBrief(reply)
      if (!brief) throw new LoopEnd({ failure: 'noBrief' })

      this.set(run, { phase: 'starting' })
      const reviewerId = await this.startReviewer(run, author, reviewer)
      this.set(run, { phase: 'reviewing', round: 1 })
      const title = author.name ?? this.titles.get(author.id)
      let review = await this.turn(run, config, reviewerId, reviewer.key, buildLoopReviewerPrompt({ brief, ...(title ? { sessionTitle: title } : {}), maxRounds: run.view.maxRounds }), 'reviewerClosed')
      for (;;) {
        if (!review.trim()) throw new LoopEnd({ failure: 'emptyReview' })
        const { round, maxRounds } = run.view
        // A reply without a verdict line counts as changes requested: the author gets it and the round limit still ends the loop.
        const next = afterVerdict(parseReviewVerdict(review), round, maxRounds)
        if (next !== 'fixing') return this.set(run, { phase: next })
        this.set(run, { phase: 'fixing' })
        const answer = await this.turn(run, config, author.id, authorKey, buildAuthorFixPrompt({ review, reviewer: reviewer.label, round, maxRounds }), 'authorClosed')
        this.set(run, { phase: 'reviewing', round: round + 1 })
        review = await this.turn(run, config, reviewerId, reviewer.key, buildReReviewPrompt({ reply: answer, round: round + 1, maxRounds }), 'reviewerClosed')
      }
    } catch (e) {
      if (isEnded(run.view)) return // stopped by the user meanwhile
      const end = e instanceof LoopEnd ? e.end : { failure: 'error' as const, detail: e instanceof Error ? e.message : String(e) }
      this.set(run, 'stoppedBy' in end ? { phase: 'stopped', stoppedBy: end.stoppedBy } : { phase: 'failed', failure: end.failure, ...(end.detail ? { detail: end.detail } : {}) })
    } finally {
      run.waitingOn = undefined
    }
  }

  /** Starts the reviewer read-only next to the author and waits until it takes prompts. */
  private async startReviewer(run: LoopRun, author: SessionView, reviewer: EffectiveAgent): Promise<string> {
    // The reviewer cannot push: every remote gets an invalid push URL through its environment.
    const remotes = await this.deps.remotes(author.cwd).catch(() => [])
    const env = pushBlockEnv([...new Set(['origin', ...remotes])], process.env)
    const origin: SessionOrigin = { kind: 'review', fromLabel: author.name ?? author.label, fromIdentity: sessionIdentity(author) }
    let started: SessionView
    try {
      started = await this.deps.sessions.start({ profileId: author.profileId, agentKey: reviewer.key, cwd: author.cwd, mode: 'app', readOnly: true, cols: 120, rows: 32 }, { env, origin })
    } catch (e) {
      throw new LoopEnd({ failure: 'reviewerStart', detail: e instanceof Error ? e.message : String(e) })
    }
    this.reviewers.add(started.id)
    this.set(run, { reviewerSessionId: started.id })
    await this.deps
      .placeBeside?.({ key: sessionIdentity(started), title: started.agentName, agentKey: reviewer.key, cwd: author.cwd }, sessionIdentity(author))
      .catch(() => undefined)
    const until = this.now() + (this.deps.startTimeoutMs ?? 120_000)
    for (;;) {
      if (isEnded(run.view)) throw new LoopEnd({ stoppedBy: 'user' })
      const v = this.view(started.id)
      if (v?.state === 'ready') return started.id
      if (!v || !isLive(v)) throw new LoopEnd({ failure: 'reviewerStart', detail: v?.error ?? 'the reviewer session stopped while starting' })
      if (this.now() > until) throw new LoopEnd({ failure: 'reviewerStart', detail: 'the reviewer session did not start in time' })
      await sleep(this.deps.pollMs ?? 200)
    }
  }

  /**
   * One turn the loop sends: shown in the session's chat, sent through its prompt path, and its
   * agent text returned once it ends. A closed or crashed session, a cancelled turn, a usage
   * budget or the user's Stop end the loop.
   */
  private async turn(run: LoopRun, config: WorkhubConfig, sessionId: string, agentKey: string, text: string, closed: 'authorClosed' | 'reviewerClosed'): Promise<string> {
    if (isEnded(run.view)) throw new LoopEnd({ stoppedBy: 'user' })
    const status = this.deps.budget?.(config, agentKey)
    if (status && gatePrompt(status, 'automation', run.override).kind !== 'send') throw new LoopEnd({ failure: 'budget', detail: status.window ?? '' })
    const v = this.view(sessionId)
    if (!v || !isLive(v)) throw new LoopEnd({ failure: closed, ...(v?.error ? { detail: v.error } : {}) })
    run.waitingOn = sessionId
    this.replies.set(sessionId, '')
    this.deps.showPrompt(sessionId, text)
    const outcome = await this.awaitTurn(sessionId, this.deps.sessions.prompt(sessionId, text))
    const reply = this.replies.get(sessionId) ?? ''
    this.replies.delete(sessionId)
    run.waitingOn = undefined
    if ('stopReason' in outcome) this.deps.showTurnEnd?.(sessionId, outcome.stopReason)
    if (isEnded(run.view)) throw new LoopEnd({ stoppedBy: 'user' })
    if ('closed' in outcome) throw new LoopEnd({ failure: closed, detail: outcome.closed })
    if ('timeout' in outcome) throw new LoopEnd({ failure: 'timeout' })
    if (outcome.stopReason === 'cancelled') throw new LoopEnd({ stoppedBy: 'cancelled' })
    return reply
  }

  /** The turn's end, or the session going away (a prompt may never settle once its agent died), or the time limit. */
  private awaitTurn(sessionId: string, turn: Promise<string>): Promise<{ stopReason: string } | { closed: string } | { timeout: true }> {
    return new Promise((resolve) => {
      let done = false
      const finish = (v: { stopReason: string } | { closed: string } | { timeout: true }) => {
        if (done) return
        done = true
        clearInterval(poll)
        clearTimeout(limit)
        resolve(v)
      }
      turn.then(
        (stopReason) => finish({ stopReason }),
        (e: unknown) => finish({ closed: e instanceof Error ? e.message : String(e) })
      )
      const poll = setInterval(() => {
        const v = this.view(sessionId)
        if (!v || !isLive(v)) finish({ closed: v?.error ?? 'the session was closed' })
      }, this.deps.pollMs ?? 500)
      const limit = setTimeout(() => finish({ timeout: true }), this.deps.turnTimeoutMs ?? 60 * 60_000)
      poll.unref?.()
      limit.unref?.()
    })
  }

  /** The Stop button: the loop ends now and the turn it waits on is interrupted; both chats stay open. */
  async stop(loopId: string): Promise<void> {
    const run = this.loops.get(loopId)
    if (!run || isEnded(run.view)) return
    const waiting = run.waitingOn
    this.set(run, { phase: 'stopped', stoppedBy: 'user' })
    if (waiting) await this.deps.sessions.cancel(waiting).catch(() => undefined)
  }

  dismiss(loopId: string): void {
    const run = this.loops.get(loopId)
    if (!run || !isEnded(run.view)) return
    this.loops.delete(loopId)
    this.changed()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Checks the renderer's request field by field; null when it is not one. */
export function validAgentReviewRequest(input: unknown): AgentReviewRequest | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o['reviewerKey'] !== 'string' || typeof o['prompt'] !== 'string' || !o['prompt'].trim()) return null
  const rounds = typeof o['maxRounds'] === 'number' && Number.isFinite(o['maxRounds']) ? Math.round(o['maxRounds']) : NaN
  if (!Number.isInteger(rounds)) return null
  return {
    reviewerKey: o['reviewerKey'],
    prompt: o['prompt'].slice(0, 50_000),
    maxRounds: Math.min(MAX_REVIEW_ROUNDS, Math.max(MIN_REVIEW_ROUNDS, rounds)),
    ...(o['override'] === true ? { override: true } : {})
  }
}

export function registerAgentReviewIpc(ipc: IpcRegistrar, service: AgentReviewService): void {
  ipc.handle('agentReview:options', (_e, sessionId: string) => service.options(String(sessionId)))
  ipc.handle('agentReview:start', (_e, sessionId: string, request: unknown) => {
    const valid = validAgentReviewRequest(request)
    return valid ? service.start(String(sessionId), valid) : { ok: false, reason: 'badRequest' }
  })
  ipc.handle('agentReview:loops', () => service.snapshot())
  ipc.handle('agentReview:stop', (_e, loopId: string) => service.stop(String(loopId)))
  ipc.handle('agentReview:dismiss', (_e, loopId: string) => service.dismiss(String(loopId)))
}
