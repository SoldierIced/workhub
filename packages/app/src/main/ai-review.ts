import { join, relative, resolve, sep } from 'node:path'
import {
  addOpinion,
  aiReviewSettings,
  applyDevReply,
  attachReviewer,
  buildReviewPrompt,
  completeRound,
  cycleRound,
  continueReview,
  decideAutoReview,
  EMPTY_AI_REVIEW_STATE,
  findingsToVerify,
  FINDING_STATUSES,
  gatePrompt,
  manualBlocker,
  markDelivered,
  parseReviewReply,
  pickReviewer,
  pushBlockEnv,
  rejectOption,
  resolveEffectiveAgents,
  reviewKey,
  roundLimit,
  sessionIdentity,
  setFindingStatus,
  startRound,
  stopReview,
  ticketKeysIn,
  type AgentEvent,
  type AiReviewState,
  type BranchReview,
  type BudgetStatus,
  type FindingStatus,
  type Profile,
  type ReviewTrigger,
  type WorkhubConfig
} from '@workhub/core'
import type { GitReview, RepoProbe } from '@workhub/adapters/git-review'
import type { SessionView, StartSessionInput } from '../shared/api'
import type { AiReviewHold, AiReviewNotice, AiReviewSnapshot, AiReviewStartResult, AiReviewView } from '../shared/ai-review-api'
import type { IpcRegistrar } from './ipc-guard'
import type { StateFile } from './state-file'

/** The usage gate's word on starting a reviewer: `ok`, or the budget that holds it. */
export type ReviewGate = { ok: true } | { ok: false; budget: BudgetStatus }

export interface AiReviewDeps {
  config: () => Promise<WorkhubConfig>
  sessions: {
    list(): SessionView[]
    start(input: StartSessionInput, internal?: { env?: Record<string, string> }): Promise<SessionView>
    prompt(id: string, text: string): Promise<string>
    stop(id: string): Promise<void>
    respondPermission(id: string, requestId: string, optionId: string | null): void
  }
  driver: {
    deliver(sessionId: string, text: string): Promise<'delivered' | 'waiting'>
    forget(sessionId: string): Promise<void>
  }
  git: Pick<GitReview, 'probe' | 'refreshBase' | 'resolveBase' | 'remotes' | 'mergeBase' | 'isAncestor' | 'commits' | 'diffStat' | 'diff' | 'checkout' | 'remove'>
  state: StateFile<AiReviewState>
  /** Folder for review worktrees (inside the app's data folder). */
  workDir: string
  emit: (snapshot: AiReviewSnapshot) => void
  notice: (notice: AiReviewNotice) => void
  /** Shows a prompt Workhub typed as a user message in the session's chat. */
  showPrompt: (sessionId: string, text: string) => void
  /** Shows the end of that prompt's turn in the chat, as for the user's own turns. */
  showTurnEnd?: (sessionId: string, stopReason: string) => void
  ticketTitle?: (profileId: string | null, key: string) => Promise<string | undefined>
  /** Ticket project keys of the configured trackers, to find a key in the branch name. */
  ticketPrefixes?: (config: WorkhubConfig) => string[]
  /**
   * Hook point for the usage budget (and any other spend guard): asked before every reviewer
   * start. `override` is the user's "Run anyway". Allows everything when unset.
   */
  canStartReview?: (input: { config: WorkhubConfig; reviewerAgentKey: string; trigger: ReviewTrigger; override: boolean }) => ReviewGate
  now?: () => number
  tickMs?: number
  /** How long a reviewer may take to start, and to answer. */
  startTimeoutMs?: number
  replyTimeoutMs?: number
  /** Diff size cut, in characters. */
  maxDiffChars?: number
}

const PROBE_EVERY_MS = 30_000
const HOLD_RETRY_MS = 5 * 60_000
const isLive = (v: SessionView) => v.state !== 'stopped' && v.state !== 'error'

interface ReviewerRun {
  reviewId: string
  text: string
}

/**
 * The AI review loop in the main process: watches dev sessions, starts reviewer sessions on a
 * separate checkout, reads their reply, sends the findings to the dev session and pauses for the
 * user when the loop asks for it. The decisions are core's (`decideAutoReview`, `completeRound`…);
 * this class only does the I/O.
 */
export class AiReviewService {
  private state: AiReviewState
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private emitQueued = false
  /** When each session's last turn ended (busy → ready); absent while it works or before its first turn. */
  private readonly idleSince = new Map<string, number>()
  private readonly lastState = new Map<string, SessionView['state']>()
  private readonly ticketKeys = new Map<string, string[]>()
  private readonly probes = new Map<string, { at: number; probe: RepoProbe | null }>()
  /** Reviewer session id → its run. */
  private readonly reviewers = new Map<string, ReviewerRun>()
  /** Review ids with a round in flight in this process. */
  private readonly running = new Set<string>()
  /** Dev session id → its reply text since findings were delivered. */
  private readonly devReplies = new Map<string, string>()
  private readonly holds = new Map<string, AiReviewHold>()

  constructor(private readonly deps: AiReviewDeps) {
    const loaded = deps.state.load(EMPTY_AI_REVIEW_STATE)
    // A round that was running when the app quit cannot be picked up again: close it as failed.
    const reviews: AiReviewState['reviews'] = {}
    for (const [id, r] of Object.entries(loaded.reviews ?? {})) reviews[id] = r.status === 'reviewing' ? completeRound(r, { raw: '', parsed: null, error: 'interrupted: Workhub was closed during the review' }, aiReviewSettings(null), this.now()) : r
    this.state = { reviews }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 5_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.deps.state.flush()
  }

  // Session streams (fed by the session manager)

  onChanged(view: SessionView): void {
    const prev = this.lastState.get(view.id)
    this.lastState.set(view.id, view.state)
    if (view.state === 'busy') this.idleSince.delete(view.id)
    if (prev === 'busy' && view.state === 'ready') {
      this.idleSince.set(view.id, this.now())
      this.probes.delete(view.id)
      const reply = this.devReplies.get(view.id)
      if (reply !== undefined) {
        this.devReplies.delete(view.id)
        this.onDevReply(view, reply)
      }
    }
    if (!isLive(view)) {
      this.idleSince.delete(view.id)
      this.devReplies.delete(view.id)
    }
  }

  onEvent(e: AgentEvent): void {
    if (e.sessionId.includes(':')) return
    const run = this.reviewers.get(e.sessionId)
    if (run) {
      if (e.type === 'message' && e.role === 'agent') run.text += e.text
      // A reviewer never gets a tool that changes anything: every permission it asks for is refused.
      if (e.type === 'permission') this.deps.sessions.respondPermission(e.sessionId, e.requestId, rejectOption(e.options) ?? null)
      return
    }
    if (e.type === 'monitor' && e.snapshot.ticketKeys?.length) this.ticketKeys.set(e.sessionId, e.snapshot.ticketKeys)
    if (e.type === 'message' && e.role === 'agent' && this.devReplies.has(e.sessionId)) this.devReplies.set(e.sessionId, this.devReplies.get(e.sessionId)! + e.text)
  }

  // Snapshot

  snapshot(): AiReviewSnapshot {
    const live = this.deps.sessions.list().filter(isLive)
    const devOf = (identity: string) => live.find((v) => sessionIdentity(v) === identity)?.id
    const reviews: AiReviewView[] = Object.values(this.state.reviews).map((r) => {
      const devSessionId = devOf(r.devIdentity)
      return devSessionId ? { ...r, devSessionId } : r
    })
    const holds = [...this.holds.values()].map((h) => {
      const devSessionId = devOf(h.devIdentity)
      return devSessionId ? { ...h, devSessionId } : h
    })
    return { reviews, holds }
  }

  private changed(): void {
    if (this.emitQueued) return
    this.emitQueued = true
    queueMicrotask(() => {
      this.emitQueued = false
      this.deps.emit(this.snapshot())
    })
  }

  /** Stores a review and tells the user when it paused for them or became ready. */
  private put(next: BranchReview, devSessionId?: string): void {
    const prev = this.state.reviews[next.id]
    this.state = { reviews: { ...this.state.reviews, [next.id]: next } }
    this.deps.state.save(this.state)
    this.changed()
    if (prev?.status === next.status) return
    if (next.status === 'paused' && next.escalation) this.deps.notice({ kind: 'paused', reviewId: next.id, devSessionId, branch: next.branch, reason: next.escalation.reason, detail: next.escalation.detail })
    if (next.status === 'ready') this.deps.notice({ kind: 'ready', reviewId: next.id, devSessionId, branch: next.branch })
  }

  // The loop

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const config = await this.deps.config()
      await this.deliverPending()
      for (const view of this.deps.sessions.list()) await this.maybeAutoReview(config, view)
    } finally {
      this.ticking = false
    }
  }

  private isReviewerSession(view: SessionView): boolean {
    if (view.readOnly || this.reviewers.has(view.id)) return true
    const rel = relative(resolve(this.deps.workDir), resolve(view.cwd))
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))
  }

  private profileOf(config: WorkhubConfig, profileId: string | null): Profile | undefined {
    return config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId))
  }

  private async probe(view: SessionView, base: string, force = false): Promise<RepoProbe | null> {
    const cached = this.probes.get(view.id)
    if (!force && cached && this.now() - cached.at < PROBE_EVERY_MS) return cached.probe
    const probe = await this.deps.git.probe(view.cwd, base).catch(() => null)
    this.probes.set(view.id, { at: this.now(), probe })
    return probe
  }

  private async maybeAutoReview(config: WorkhubConfig, view: SessionView): Promise<void> {
    if (!isLive(view) || view.agentId === 'shell') return
    const profile = this.profileOf(config, view.profileId)
    const settings = aiReviewSettings(profile)
    const identity = sessionIdentity(view)
    const since = this.idleSince.get(view.id)
    const base = { settings, isReviewerSession: this.isReviewerSession(view), state: view.state, idleMs: since === undefined ? null : this.now() - since, review: undefined, anyRunning: this.running.size > 0 }
    // Everything that needs no git first, so idle sessions cost nothing until the debounce passed.
    const pre = decideAutoReview({ ...base, repo: { branch: '\0pending', headSha: '', base: settings.baseBranch, baseRef: settings.baseBranch, ahead: 1, dirty: false } })
    if (!pre.start) return
    // A budget hold is asked again every few minutes: the window may have reset or the ceiling moved.
    const hold = this.holds.get(identity)
    if (hold && this.now() - hold.at < HOLD_RETRY_MS) return
    const repo = await this.probe(view, settings.baseBranch)
    const review = repo?.branch ? this.state.reviews[reviewKey(identity, repo.branch)] : undefined
    const decision = decideAutoReview({ ...base, repo, review })
    if (!decision.start || !repo) return
    await this.startRoundFor(config, view, repo, 'auto', false)
  }

  /** "Review before PR". */
  async startManual(sessionId: string, override = false): Promise<AiReviewStartResult> {
    const view = this.deps.sessions.list().find((v) => v.id === sessionId)
    if (!view) return { ok: false, reason: 'unknownSession' }
    if (this.isReviewerSession(view)) return { ok: false, reason: 'reviewerSession' }
    const config = await this.deps.config()
    const settings = aiReviewSettings(this.profileOf(config, view.profileId))
    if (!settings.enabled) return { ok: false, reason: 'disabled' }
    const repo = await this.probe(view, settings.baseBranch, true)
    const review = repo?.branch ? this.state.reviews[reviewKey(sessionIdentity(view), repo.branch)] : undefined
    const blocker = manualBlocker(repo, review)
    if (blocker || !repo) return { ok: false, reason: blocker ?? 'notRepo' }
    return this.startRoundFor(config, view, repo, 'manual', override)
  }

  private async startRoundFor(config: WorkhubConfig, view: SessionView, repo: RepoProbe, trigger: ReviewTrigger, override: boolean): Promise<AiReviewStartResult> {
    const profile = this.profileOf(config, view.profileId)
    const settings = aiReviewSettings(profile)
    const identity = sessionIdentity(view)
    const reviewer = pickReviewer(profile, resolveEffectiveAgents(config, profile?.id ?? null))
    if (!reviewer) return { ok: false, reason: 'noReviewer' }
    const gate = this.deps.canStartReview?.({ config, reviewerAgentKey: reviewer.key, trigger, override }) ?? { ok: true }
    if (!gate.ok) {
      const known = this.holds.has(identity)
      this.holds.set(identity, { devIdentity: identity, reviewerAgentKey: reviewer.key, budget: gate.budget, at: this.now() })
      this.changed()
      if (!known) this.deps.notice({ kind: 'held', devSessionId: view.id, budget: gate.budget })
      return { ok: false, reason: 'budget', detail: gate.budget.window }
    }
    this.holds.delete(identity)
    const key = reviewKey(identity, repo.branch!)
    const review = startRound(
      this.state.reviews[key],
      { devIdentity: identity, profileId: view.profileId, repoRoot: repo.root, branch: repo.branch!, base: repo.base, baseRef: repo.baseRef!, sha: repo.headSha, trigger, reviewerAgentKey: reviewer.key, uncommitted: repo.dirty, now: this.now() },
      settings
    )
    this.put(review, view.id)
    this.running.add(key)
    void this.runRound(config, view, repo, review, reviewer.key).finally(() => {
      this.running.delete(key)
      this.changed()
    })
    return { ok: true, reviewId: key }
  }

  private worktreePath(reviewId: string): string {
    return join(this.deps.workDir, 'worktrees', reviewId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120))
  }

  /** One round: checkout, prompt, reply, verdict. Every failure ends the round as `failed`, never throws. */
  private async runRound(config: WorkhubConfig, dev: SessionView, repo: RepoProbe, review: BranchReview, reviewerKey: string): Promise<void> {
    const settings = aiReviewSettings(this.profileOf(config, dev.profileId))
    const round = review.rounds[review.rounds.length - 1]!
    const path = this.worktreePath(review.id)
    let reviewerId: string | undefined
    let raw = ''
    let error: string | undefined
    try {
      const { git } = this.deps
      // The base is refreshed before every round; offline or without access, the local ref is used and the round says so.
      const baseRef = await this.refreshBase(repo.root, review, round.n)
      await git.checkout(repo.root, path, round.sha)
      const mergeBase = (await git.mergeBase(repo.root, baseRef, round.sha)) ?? baseRef
      const fromSha = round.fromSha && (await git.isAncestor(repo.root, round.fromSha, round.sha)) ? round.fromSha : undefined
      const maxChars = this.deps.maxDiffChars ?? 150_000
      const [commits, diffStat, diff] = await Promise.all([git.commits(repo.root, mergeBase, round.sha), git.diffStat(repo.root, mergeBase, round.sha), git.diff(repo.root, fromSha ?? mergeBase, round.sha, maxChars)])
      const prompt = buildReviewPrompt({
        language: settings.language,
        round: cycleRound(review, round.n),
        maxRounds: roundLimit(review, settings),
        branch: review.branch,
        base: review.base,
        baseRef,
        headSha: round.sha,
        mergeBase,
        ...(fromSha ? { fromSha } : {}),
        commits,
        diffStat,
        diff: diff.text,
        diffTruncated: diff.truncated,
        ...(await this.ticketOf(config, dev, review)),
        checklist: settings.checklist,
        uncommitted: repo.dirtyFiles,
        previous: findingsToVerify(review),
        userNotes: review.userNotes
      })
      // The reviewer cannot push: every remote gets an invalid push URL through the session's environment (nothing is written to the repository).
      const env = pushBlockEnv(await git.remotes(repo.root).catch(() => []), process.env)
      const model = settings.reviewerModel.trim()
      const started = await this.deps.sessions.start({ profileId: dev.profileId, agentKey: reviewerKey, cwd: path, mode: 'app', readOnly: true, cols: 120, rows: 32, ...(model ? { model } : {}) }, { env })
      reviewerId = started.id
      this.reviewers.set(started.id, { reviewId: review.id, text: '' })
      this.put(attachReviewer(this.state.reviews[review.id] ?? review, started.id, this.now()), dev.id)
      await this.waitReady(started.id)
      if (model && this.deps.sessions.list().find((v) => v.id === started.id)?.modelIgnored) this.noteRound(review.id, { modelNote: `reviewer model "${model}" not applied: the agent does not offer it, so it runs with its default model` }, dev.id)
      this.deps.showPrompt(started.id, prompt)
      const stopReason = await withTimeout(this.deps.sessions.prompt(started.id, prompt), this.deps.replyTimeoutMs ?? 30 * 60_000, 'the reviewer did not answer in time')
      this.deps.showTurnEnd?.(started.id, stopReason)
      raw = this.reviewers.get(started.id)?.text ?? ''
      if (stopReason === 'cancelled') error = 'the reviewer turn was cancelled'
      else if (!raw.trim()) error = 'the reviewer gave an empty reply'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      if (reviewerId) raw = this.reviewers.get(reviewerId)?.text ?? raw
    }
    if (reviewerId) {
      this.reviewers.delete(reviewerId)
      await this.deps.sessions.stop(reviewerId).catch(() => undefined)
      await this.deps.driver.forget(reviewerId).catch(() => undefined)
    }
    await this.deps.git.remove(repo.root, path).catch(() => undefined)
    const current = this.state.reviews[review.id]
    if (!current || current.status !== 'reviewing') return // stopped by the user meanwhile
    const parsed = error ? null : parseReviewReply(raw)
    this.put(completeRound(current, { raw, parsed, ...(error ? { error } : {}) }, settings, this.now()), dev.id)
    await this.deliverPending()
  }

  /** Fetches the base; returns the ref to diff against (re-resolved, since the fetch may have created `origin/<base>`). */
  private async refreshBase(root: string, review: BranchReview, n: number): Promise<string> {
    const { git } = this.deps
    const fetched = await git.refreshBase(root, review.base).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }))
    if (fetched.ok) {
      const resolved = await git.resolveBase(root, review.base).catch(() => null)
      if (resolved && resolved.ref !== review.baseRef) {
        const current = this.state.reviews[review.id] ?? review
        this.put({ ...current, baseRef: resolved.ref })
        return resolved.ref
      }
      return review.baseRef
    }
    this.noteRound(review.id, { baseNote: `base not refreshed: ${fetched.reason}` }, undefined, n)
    return review.baseRef
  }

  /** Adds facts to the current round (or round `n`) of a review. */
  private noteRound(reviewId: string, patch: Partial<BranchReview['rounds'][number]>, devSessionId?: string, n?: number): void {
    const r = this.state.reviews[reviewId]
    if (!r || !Object.keys(patch).length) return
    const rounds = r.rounds.map((x, i) => (n === undefined ? i === r.rounds.length - 1 : x.n === n) ? { ...x, ...patch } : x)
    this.put({ ...r, rounds, updatedAt: this.now() }, devSessionId)
  }

  private async waitReady(id: string): Promise<void> {
    const until = this.now() + (this.deps.startTimeoutMs ?? 120_000)
    for (;;) {
      const v = this.deps.sessions.list().find((s) => s.id === id)
      if (!v) throw new Error('the reviewer session is gone')
      if (v.state === 'ready') return
      if (v.state === 'error' || v.state === 'stopped') throw new Error(v.error ?? 'the reviewer session stopped while starting')
      if (this.now() > until) throw new Error('the reviewer session did not start in time')
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  private async ticketOf(config: WorkhubConfig, dev: SessionView, review: BranchReview): Promise<{ ticket?: { key: string; title?: string } }> {
    const prefixes = this.deps.ticketPrefixes?.(config) ?? []
    const key = this.ticketKeys.get(dev.id)?.at(-1) ?? ticketKeysIn(review.branch.replace(/[/_]/g, ' '), [{ provider: 'jira', projectKeys: prefixes }])[0]
    if (!key) return {}
    const title = await withTimeout(this.deps.ticketTitle?.(dev.profileId, key) ?? Promise.resolve(undefined), 10_000, 'ticket').catch(() => undefined)
    return { ticket: { key, ...(title ? { title } : {}) } }
  }

  /** Sends queued messages to idle dev sessions. */
  private async deliverPending(): Promise<void> {
    for (const r of Object.values(this.state.reviews)) {
      if (!r.pendingDelivery || r.status === 'stopped') continue
      const dev = this.deps.sessions.list().find((v) => isLive(v) && sessionIdentity(v) === r.devIdentity)
      if (!dev || dev.state !== 'ready') continue
      const outcome = await this.deps.driver.deliver(dev.id, r.pendingDelivery).catch(() => 'waiting' as const)
      if (outcome !== 'delivered') continue
      const latest = this.state.reviews[r.id] ?? r
      // Only a message with findings makes the dev's next reply worth reading for disputes.
      if (latest.pendingFindingIds?.length) this.devReplies.set(dev.id, '')
      this.put(markDelivered(latest, this.now()), dev.id)
    }
  }

  private onDevReply(dev: SessionView, text: string): void {
    const identity = sessionIdentity(dev)
    for (const r of Object.values(this.state.reviews)) {
      if (r.devIdentity !== identity || !r.awaitingDevReply) continue
      this.put(applyDevReply(r, text, this.now()), dev.id)
    }
  }

  // User actions from the Review panel

  private async update(reviewId: string, fn: (r: BranchReview, config: WorkhubConfig) => BranchReview): Promise<void> {
    const r = this.state.reviews[reviewId]
    if (!r) return
    const config = await this.deps.config()
    this.put(fn(r, config), this.snapshot().reviews.find((x) => x.id === reviewId)?.devSessionId)
    await this.deliverPending()
  }

  private settingsFor(config: WorkhubConfig, r: BranchReview) {
    return aiReviewSettings(this.profileOf(config, r.profileId))
  }

  continue(reviewId: string): Promise<void> {
    return this.update(reviewId, (r, c) => continueReview(r, this.settingsFor(c, r), this.now()))
  }

  setFindingStatus(reviewId: string, ids: string[], status: FindingStatus): Promise<void> {
    return this.update(reviewId, (r) => setFindingStatus(r, ids, status, this.now()))
  }

  opinion(reviewId: string, text: string): Promise<void> {
    return this.update(reviewId, (r, c) => addOpinion(r, text, this.settingsFor(c, r), this.now()))
  }

  async stopReview(reviewId: string): Promise<void> {
    const r = this.state.reviews[reviewId]
    const reviewer = r?.rounds.at(-1)?.reviewerSessionId
    if (r?.status === 'reviewing' && reviewer && this.reviewers.has(reviewer)) await this.deps.sessions.stop(reviewer).catch(() => undefined)
    await this.update(reviewId, (x) => stopReview(x, this.now()))
  }

  dismissHold(devIdentity: string): void {
    this.holds.delete(devIdentity)
    this.changed()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/** The usage gate for a reviewer: automatic rounds pause past the budget; a manual one asks for "Run anyway". */
export function reviewBudgetGate(budgetOf: (config: WorkhubConfig, agentKey: string) => BudgetStatus): NonNullable<AiReviewDeps['canStartReview']> {
  return ({ config, reviewerAgentKey, trigger, override }) => {
    const status = budgetOf(config, reviewerAgentKey)
    const verdict = gatePrompt(status, trigger === 'auto' ? 'automation' : 'user', override)
    return verdict.kind === 'send' ? { ok: true } : { ok: false, budget: status }
  }
}

export function registerAiReviewIpc(ipc: IpcRegistrar, service: AiReviewService): void {
  ipc.handle('aiReview:get', () => service.snapshot())
  ipc.handle('aiReview:start', (_e, sessionId: string, override?: boolean) => service.startManual(String(sessionId), override === true))
  ipc.handle('aiReview:continue', (_e, reviewId: string) => service.continue(String(reviewId)))
  ipc.handle('aiReview:setFindingStatus', (_e, reviewId: string, ids: unknown, status: FindingStatus) => {
    if (!Array.isArray(ids) || !(FINDING_STATUSES as readonly string[]).includes(status)) return
    return service.setFindingStatus(String(reviewId), ids.map(String), status)
  })
  ipc.handle('aiReview:opinion', (_e, reviewId: string, text: unknown) => service.opinion(String(reviewId), String(text ?? '').slice(0, 20_000)))
  ipc.handle('aiReview:stop', (_e, reviewId: string) => service.stopReview(String(reviewId)))
  ipc.handle('aiReview:dismissHold', (_e, devIdentity: string) => service.dismissHold(String(devIdentity)))
}
