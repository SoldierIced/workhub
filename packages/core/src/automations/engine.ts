import { pruneLedger } from '../chat/ledger'
import type { ChatMessage } from '../chat/types'
import type { SessionState } from '../domain/session'
import { chatTriggers, evaluatePendingGate, failureBackoffMs, limitWait, looksRateLimited, resetTimeIn, windowReason, type GateVerdict } from './rules'
import {
  EMPTY_AUTOMATIONS_STATE,
  FAILURE_OUTCOMES,
  RUN_LOG_LIMIT,
  type AutomationDefinition,
  type AutomationOutcome,
  type AutomationRun,
  type AutomationsState,
  type AutomationTrigger,
  type SessionUsage,
  usageDelta
} from './types'

/** A session as the engine sees it. */
export interface DrivenSession {
  id: string
  /** Stable identity (`sessionIdentity`). */
  identity: string
  state: SessionState
  /** Turns that ended (busy to ready) since the session started; how a chat run knows it finished. */
  turnsEnded: number
  /** Epoch ms of the last terminal output; how a console run knows it went quiet. */
  lastOutputAt?: number
  error?: string
  /** The user is looking at it. */
  onScreen?: boolean
  /** Cumulative cost and tokens of the session, when its agent reports them. */
  usage?: SessionUsage
}

/** How the engine drives sessions; the app implements it on its session manager. */
export interface AutomationSessions {
  list(): DrivenSession[]
  /**
   * Opens the automation's session in the background. With `previous`, it continues that session
   * (resumed when the agent can, else started again under the same identity).
   */
  start(automation: AutomationDefinition, previous?: string): Promise<DrivenSession>
  /** Types the prompt into the session: `waiting` while it cannot take it yet. */
  deliver(sessionId: string, text: string): Promise<'delivered' | 'waiting'>
  interrupt(sessionId: string): Promise<void>
  stop(sessionId: string): Promise<void>
  /** Drops a stopped session the engine replaced from the session list (it stays in History). */
  forget(sessionId: string): Promise<void>
}

export type AutomationNotice = { kind: 'failed'; automationId: string; automationName: string; outcome: AutomationOutcome; detail: string }

export interface AutomationHost {
  now(): number
  newId(): string
  definitions(): readonly AutomationDefinition[]
  /** Whether the automation's profile has the Automations module on. */
  isActive(automation: AutomationDefinition): boolean
  sessions: AutomationSessions
  /** 5 h usage of the automation's account, in percent; null when unknown. */
  usagePercent(automation: AutomationDefinition): number | null
  /** The parsed gate file; undefined when it is missing or unreadable. */
  readGate(path: string): Promise<unknown>
  /**
   * Set when the automation's account is past a usage ceiling (Settings → Usage): automatic runs
   * wait, until the window resets when that is known. Absent or null: no budget applies.
   */
  budgetPaused?(automation: AutomationDefinition): { window: string; resetsAt?: number } | null
  /** Whether the automation's agent and view take `/clear` (see `supportsClearContext`); absent: never. */
  clearsContext?(automation: AutomationDefinition): boolean
  /** The new session takes the old one's sidebar group and position (core `replaceSessionIdentity`). */
  replaceIdentity(oldKey: string, newKey: string): Promise<void>
  /** Hands the open chat threads owned by `oldKey` to `newKey`; returns how many moved. */
  transferThreads(oldKey: string, newKey: string, agentKey: string): number
  /** How many open chat threads still wake the session with this identity. */
  listeningThreads(identity: string): number
  notify(notice: AutomationNotice): void
  persist(state: AutomationsState): void
}

interface Pending {
  trigger: AutomationTrigger
  link?: string
  queuedAt: number
  merged: number
  /** The log row that counts the triggers merged into this run. */
  coalescedRowId?: string
}

interface Active {
  run: AutomationRun
  sessionId?: string
  /** `clearing`: the session's context is being cleared before the prompt goes in. */
  stage: 'opening' | 'clearing' | 'delivering' | 'running'
  submittedAt?: number
  turnsAtSubmit: number
  /** The session was started for this run, so it had spent nothing before it. */
  fresh?: boolean
  /** The context was cleared for this run (`clearContext`): the session starts it with nothing spent. */
  cleared?: boolean
  /** The session's usage when the prompt went in; absent when it is unknown (then no usage is logged). */
  usageBaseline?: SessionUsage
}

/** The monitor reads transcripts every few seconds: a finished run's usage is refreshed for this long. */
export const USAGE_SETTLE_MS = 20_000

export interface RunState {
  pending?: Pending
  active?: Active
  failureStreak: number
  notified: boolean
  lastError?: string
  /** Automatic runs wait until then (a rate limit's reset, or the backoff after failures). */
  pausedUntil?: number
  pauseReason?: 'rateLimited' | 'backoff'
  /** Why the pending run has not started yet (`window.days`, `limit.window`, `usage`…). */
  waitReason?: string
  waitUntil?: number
  lastIntervalAt?: number
  lastCheck?: { at: number; verdict: GateVerdict; fired: boolean }
  /** The gate lets a missing state file through once, so the first run can create it. */
  missingFileFired: boolean
}

export type AutomationHealth = 'off' | 'idle' | 'waiting' | 'paused' | 'failing' | 'running'

/** A chat run that cannot deliver its prompt within this time fails. */
export const DELIVERY_TIMEOUT_MS = 180_000
/** A console run is done once its output has been quiet this long. */
export const CONSOLE_QUIET_MS = 5_000
/** What a run sends before its prompt when the automation clears the context (Claude Code's own command). */
export const CLEAR_CONTEXT_PROMPT = '/clear'

/**
 * Turns triggers (a new chat message, an interval, "Run now") into runs of a prompt in a
 * dedicated session, one at a time per automation, inside its window, under its limits and the
 * usage guard. Bursts coalesce into one pending run. The app calls `tick` every couple of seconds.
 *
 * While the app runs, every run of an automation goes into the session it opened: one chat that
 * gets each run's prompt. A run waits while that session is busy instead of opening a second one.
 * A new session starts only when there is none (after a restart, or once it was closed or failed);
 * a "reuse" automation then resumes its dedicated session instead.
 *
 * A new session that replaces another takes everything of the previous one: its sidebar group and
 * position, and the chat threads it listens to (so a reply reaches exactly one session). The
 * previous session is then retired: stopped once it is idle, off screen and no open thread wakes
 * it, never before.
 */
export class AutomationEngine {
  private state: AutomationsState
  private readonly runtime = new Map<string, RunState>()
  private ticking = false
  /** Finished runs whose usage may still grow as the monitor catches up with the transcript. */
  private readonly settling = new Map<string, { automationId: string; sessionId: string; baseline: SessionUsage; until: number }>()
  /** Per automation: the session (its id in the session list) it runs in while the app runs. Not kept across launches. */
  private readonly owner = new Map<string, string>()

  constructor(
    private readonly host: AutomationHost,
    initial: AutomationsState = EMPTY_AUTOMATIONS_STATE
  ) {
    this.state = { ...EMPTY_AUTOMATIONS_STATE, ...initial }
  }

  snapshot(): AutomationsState {
    return this.state
  }

  runState(id: string): RunState {
    return this.runtime.get(id) ?? { failureStreak: 0, notified: false, missingFileFired: false }
  }

  /** The automation a session belongs to: its current one, or one it replaced. */
  automationOf(identity: string): AutomationDefinition | undefined {
    const id = this.state.owned[identity]
    return id ? this.host.definitions().find((a) => a.id === id) : undefined
  }

  /** Why a chat reply must not wake this session (its automation is off, or takes no replies); null when it may. */
  wakeBlocked(identity: string): 'automationOff' | 'noReplies' | null {
    const a = this.automationOf(identity)
    if (!a) return null
    if (!a.enabled) return 'automationOff'
    if (!a.receivesChatReplies) return 'noReplies'
    return null
  }

  /** Whether the threads this session writes in are left unfollowed (its automation takes no replies). */
  ignoresChat(identity: string): boolean {
    return this.automationOf(identity)?.receivesChatReplies === false
  }

  health(a: AutomationDefinition): AutomationHealth {
    if (!a.enabled) return 'off'
    const s = this.runState(a.id)
    if (s.active) return 'running'
    if (s.failureStreak > 0) return 'failing'
    if (s.pausedUntil && s.pausedUntil > this.host.now()) return 'paused'
    if (s.pending) return 'waiting'
    return 'idle'
  }

  // Triggers

  /** Watcher callback: new chat messages fire the automations listening to their channel. */
  onChatMessages(messages: readonly ChatMessage[], me: string): number {
    const now = this.host.now()
    const defs = this.host.definitions()
    const { ledger, triggers } = chatTriggers(defs, messages, this.state.ledger, { me, now, isActive: (a) => this.host.isActive(a) })
    if (ledger !== this.state.ledger) this.save({ ...this.state, ledger: pruneLedger(ledger, now) })
    for (const t of triggers) {
      const a = defs.find((d) => d.id === t.automationId)
      if (a) this.enqueue(a, 'chat', t.link)
    }
    return triggers.length
  }

  /** "Run now": ignores the window, the limits, the usage guard and pauses; only a run in progress stops it. */
  runNow(id: string): void {
    const a = this.host.definitions().find((d) => d.id === id)
    if (!a || this.runState(id).active) return
    const s = this.runState(id)
    if (s.pending) this.runtime.set(id, { ...s, pending: { ...s.pending, trigger: 'manual' } })
    else this.enqueue(a, 'manual')
  }

  /** Stops the run in progress: the session's turn is interrupted. */
  async stopRun(id: string): Promise<void> {
    const a = this.host.definitions().find((d) => d.id === id)
    const active = this.runState(id).active
    if (!a || !active) return
    if (active.sessionId) await this.host.sessions.interrupt(active.sessionId).catch(() => undefined)
    this.finish(a, 'stopped', 'stoppedByUser')
  }

  /** Resuming an automation clears a rate-limit pause and the failure backoff. */
  resumed(id: string): void {
    const s = this.runState(id)
    this.runtime.set(id, { ...s, pausedUntil: undefined, pauseReason: undefined, failureStreak: 0, notified: false, lastIntervalAt: this.host.now() })
  }

  /** Forgets a removed automation's schedule (its log rows and sessions stay). */
  removed(id: string): void {
    this.runtime.delete(id)
    this.owner.delete(id)
    const starts = { ...this.state.starts }
    delete starts[id]
    this.save({ ...this.state, starts })
  }

  /** A session got its real identity late (an ACP agent reports its id after starting): the records follow it. */
  identityChanged(oldKey: string, newKey: string): void {
    if (oldKey === newKey || !(oldKey in this.state.owned)) return
    // The old key stays too: a session that cleared its context left its earlier transcript under
    // it, and History still groups that one with the automation.
    const owned = { ...this.state.owned, [newKey]: this.state.owned[oldKey]! }
    const sessions = Object.fromEntries(Object.entries(this.state.sessions).map(([id, key]) => [id, key === oldKey ? newKey : key]))
    const retiring = this.state.retiring.map((key) => (key === oldKey ? newKey : key))
    const runs = this.state.runs.map((r) => (r.session === oldKey ? { ...r, session: newKey } : r))
    for (const [id, s] of this.runtime) {
      if (s.active?.run.session === oldKey) this.runtime.set(id, { ...s, active: { ...s.active, run: { ...s.active.run, session: newKey } } })
    }
    this.save({ ...this.state, owned, sessions, retiring, runs })
  }

  private enqueue(a: AutomationDefinition, trigger: AutomationTrigger, link?: string): void {
    const s = this.runState(a.id)
    const now = this.host.now()
    if (!s.pending) {
      this.runtime.set(a.id, { ...s, pending: { trigger, queuedAt: now, merged: 0, ...(link ? { link } : {}) } })
      return
    }
    const pending = { ...s.pending, merged: s.pending.merged + 1 }
    const rowIndex = pending.coalescedRowId ? this.state.runs.findIndex((r) => r.id === pending.coalescedRowId) : -1
    if (rowIndex >= 0) {
      const runs = [...this.state.runs]
      runs[rowIndex] = { ...runs[rowIndex]!, merged: runs[rowIndex]!.merged + 1 }
      this.save({ ...this.state, runs })
    } else {
      const row: AutomationRun = { id: this.host.newId(), automationId: a.id, automationName: a.name, trigger, queuedAt: now, outcome: 'coalesced', detail: 'mergedIntoPending', merged: 1, ...(link ? { triggerLink: link } : {}) }
      pending.coalescedRowId = row.id
      this.log(row)
    }
    this.runtime.set(a.id, { ...s, pending })
  }

  // The loop

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const a of this.host.definitions()) await this.step(a)
      await this.retire()
      this.settleUsage()
    } finally {
      this.ticking = false
    }
  }

  private async step(a: AutomationDefinition): Promise<void> {
    if (this.runState(a.id).active) return this.monitor(a)
    const on = a.enabled && this.host.isActive(a)
    if (on) await this.fireInterval(a)
    const s = this.runState(a.id)
    if (!s.pending) {
      if (s.waitReason) this.runtime.set(a.id, { ...s, waitReason: undefined, waitUntil: undefined })
      return
    }
    if (!on && s.pending.trigger !== 'manual') return this.drop(a, a.enabled ? 'moduleOff' : 'paused')
    return this.attemptStart(a)
  }

  private async fireInterval(a: AutomationDefinition): Promise<void> {
    const minutes = a.triggers.intervalMinutes
    if (!minutes || minutes <= 0) return
    const now = this.host.now()
    let s = this.runState(a.id)
    if (s.lastIntervalAt === undefined) {
      this.runtime.set(a.id, { ...s, lastIntervalAt: now })
      return
    }
    if (now - s.lastIntervalAt < minutes * 60_000) return
    s = { ...s, lastIntervalAt: now }
    this.runtime.set(a.id, s)
    // Outside the window the interval simply does not fire; a run already queued or working covers it.
    if (windowReason(a.window, now) || s.pending || s.active) return
    const gate = a.triggers.pendingGate
    if (gate) {
      const verdict = evaluatePendingGate(await this.host.readGate(gate.stateFile).catch(() => undefined), now)
      let fire = verdict.actionable
      let missingFileFired = false
      if (verdict.reason === 'missing') {
        fire = !s.missingFileFired
        missingFileFired = true
      }
      this.runtime.set(a.id, { ...this.runState(a.id), missingFileFired, lastCheck: { at: now, verdict, fired: fire } })
      if (!fire) return
    }
    this.enqueue(a, 'interval')
  }

  private async attemptStart(a: AutomationDefinition): Promise<void> {
    const s = this.runState(a.id)
    const pending = s.pending!
    const now = this.host.now()
    if (pending.trigger !== 'manual') {
      if (s.pausedUntil && s.pausedUntil > now) return this.setWait(a.id, s.pauseReason === 'rateLimited' ? 'rateLimited' : 'backoff', s.pausedUntil)
      const outside = windowReason(a.window, now)
      if (outside) return this.drop(a, `window.${outside}`)
      const usage = this.host.usagePercent(a)
      if (usage !== null && usage >= a.usageThreshold) return this.setWait(a.id, 'usage')
      const budget = this.host.budgetPaused?.(a)
      if (budget) return this.setWait(a.id, `budget.${budget.window}`, budget.resetsAt)
      const limit = limitWait(this.state.starts[a.id] ?? [], a.limits, now)
      if (limit) return this.setWait(a.id, `limit.${limit.reason}`, limit.until)
    }
    // One session per automation: while it is busy (a turn, a permission prompt, a reply it woke
    // for) the run stays pending, and further triggers merge into it, instead of opening another.
    const open = this.current(a)
    if (open && open.state !== 'ready') return this.setWait(a.id, 'sessionBusy')
    await this.begin(a, pending)
  }

  private setWait(id: string, reason: string, until?: number): void {
    const s = this.runState(id)
    this.runtime.set(id, { ...s, waitReason: reason, waitUntil: until })
  }

  /** Drops the pending run with a `skipped` row. */
  private drop(a: AutomationDefinition, reason: string): void {
    const s = this.runState(a.id)
    if (!s.pending) return
    this.runtime.set(a.id, { ...s, pending: undefined, waitReason: undefined, waitUntil: undefined })
    this.log({
      id: this.host.newId(),
      automationId: a.id,
      automationName: a.name,
      trigger: s.pending.trigger,
      queuedAt: s.pending.queuedAt,
      outcome: 'skipped',
      detail: reason,
      merged: s.pending.merged,
      ...(s.pending.link ? { triggerLink: s.pending.link } : {})
    })
  }

  // Starting a run

  private async begin(a: AutomationDefinition, pending: Pending): Promise<void> {
    const now = this.host.now()
    const run: AutomationRun = {
      id: this.host.newId(),
      automationId: a.id,
      automationName: a.name,
      trigger: pending.trigger,
      queuedAt: pending.queuedAt,
      startedAt: now,
      outcome: 'ok',
      merged: pending.merged,
      ...(pending.link ? { triggerLink: pending.link } : {})
    }
    this.runtime.set(a.id, { ...this.runState(a.id), pending: undefined, waitReason: undefined, waitUntil: undefined, active: { run, stage: 'opening', turnsAtSubmit: 0 } })
    const starts = [...(this.state.starts[a.id] ?? []).filter((t) => now - t < 2 * 86_400_000), now]
    this.save({ ...this.state, starts: { ...this.state.starts, [a.id]: starts } })
    let session: DrivenSession
    let fresh = false
    try {
      ;({ session, fresh } = await this.resolveSession(a))
    } catch (err) {
      this.finish(a, 'error', err instanceof Error ? err.message : String(err))
      return
    }
    const s = this.runState(a.id)
    if (!s.active) return
    this.runtime.set(a.id, { ...s, active: { ...s.active, run: { ...s.active.run, session: session.identity }, sessionId: session.id, stage: 'delivering', fresh } })
    await this.monitor(a)
  }

  /**
   * The session a run goes into: the open one (see `current`), else the dedicated one resumed
   * (reuse), else a new one. A new session that replaces another takes its sidebar place and its
   * chat threads, and the replaced one is retired (see `retire`).
   */
  private async resolveSession(a: AutomationDefinition): Promise<{ session: DrivenSession; fresh: boolean }> {
    const open = this.current(a)
    if (open) {
      this.owner.set(a.id, open.id)
      return { session: open, fresh: false }
    }
    const previous = this.state.sessions[a.id]
    const sessions = this.host.sessions
    if (a.sessionPolicy === 'reuse' && previous) {
      const continued = await sessions.start(a, previous)
      this.owner.set(a.id, continued.id)
      this.adopt(a, continued.identity)
      if (continued.identity !== previous) await this.handOver(a, previous, continued.identity)
      return { session: continued, fresh: false }
    }
    const started = await sessions.start(a)
    this.owner.set(a.id, started.id)
    this.adopt(a, started.identity)
    if (previous && previous !== started.identity) await this.handOver(a, previous, started.identity)
    return { session: started, fresh: true }
  }

  private adopt(a: AutomationDefinition, identity: string): void {
    this.save({ ...this.state, sessions: { ...this.state.sessions, [a.id]: identity }, owned: { ...this.state.owned, [identity]: a.id } })
  }

  /** The replacing session inherits the group, the position and the listening threads; the old one retires. */
  private async handOver(a: AutomationDefinition, previous: string, next: string): Promise<void> {
    try {
      await this.host.replaceIdentity(previous, next)
    } catch {
      // The sidebar place is a convenience; the run still goes ahead.
    }
    this.host.transferThreads(previous, next, a.agentKey)
    if (!this.state.retiring.includes(previous)) this.save({ ...this.state, retiring: [...this.state.retiring, previous] })
  }

  /**
   * Stops replaced sessions that are done with: idle, off screen, not in a run and with no open
   * chat thread waking them. A session a thread still wakes is never stopped here.
   */
  private async retire(): Promise<void> {
    if (!this.state.retiring.length) return
    const inRun = new Set([...this.runtime.values()].map((s) => s.active?.sessionId).filter(Boolean))
    const keep: string[] = []
    for (const identity of this.state.retiring) {
      const open = this.live(identity)
      if (!open) continue
      if (this.host.listeningThreads(identity) > 0 || open.state !== 'ready' || open.onScreen || inRun.has(open.id)) {
        keep.push(identity)
        continue
      }
      const stopped = await this.host.sessions.stop(open.id).then(() => true, () => false)
      // Only a session this hand-over stopped leaves the list; one that would not stop stays visible.
      if (stopped) await this.host.sessions.forget(open.id).catch(() => undefined)
    }
    if (keep.length !== this.state.retiring.length) this.save({ ...this.state, retiring: keep })
  }

  private live(identity: string): DrivenSession | undefined {
    return this.host.sessions.list().find((s) => s.identity === identity && s.state !== 'stopped' && s.state !== 'error')
  }

  /**
   * The open session the automation runs in: the one it opened while the app runs, else, for a
   * "reuse" automation, its dedicated one when it is open (say, reopened by a chat reply).
   * Undefined once it was closed or failed.
   */
  private current(a: AutomationDefinition): DrivenSession | undefined {
    const id = this.owner.get(a.id)
    const mine = id ? this.host.sessions.list().find((s) => s.id === id && s.state !== 'stopped' && s.state !== 'error') : undefined
    if (mine) return mine
    const previous = this.state.sessions[a.id]
    return a.sessionPolicy === 'reuse' && previous ? this.live(previous) : undefined
  }

  // Watching a run

  private async monitor(a: AutomationDefinition): Promise<void> {
    const active = this.runState(a.id).active
    if (!active || active.stage === 'opening' || !active.sessionId) return
    const now = this.host.now()
    const session = this.host.sessions.list().find((s) => s.id === active.sessionId)
    if (!session || session.state === 'stopped') return this.finish(a, 'error', 'sessionClosed')
    if (session.state === 'error') {
      const text = session.error ?? 'sessionFailed'
      return looksRateLimited(text) ? this.finish(a, 'rateLimited', text, resetTimeIn(text) ?? undefined) : this.finish(a, 'error', text)
    }
    if (active.stage === 'clearing') {
      // `/clear` runs as a turn of its own: the prompt goes in once it ended.
      if (session.turnsEnded > active.turnsAtSubmit && session.state === 'ready') this.patchActive(a.id, { stage: 'delivering', cleared: true })
      else if (now - (active.run.startedAt ?? now) > DELIVERY_TIMEOUT_MS) this.finish(a, 'error', 'clearFailed')
      return
    }
    if (active.stage === 'delivering') {
      if (session.state === 'ready') {
        // A session that already ran something starts the run with an empty context when asked to.
        const clear = a.clearContext === true && !active.fresh && !active.cleared && this.host.clearsContext?.(a) === true
        const delivered = await this.host.sessions.deliver(session.id, clear ? CLEAR_CONTEXT_PROMPT : a.prompt).catch(() => 'waiting' as const)
        if (delivered === 'delivered' && clear) {
          this.patchActive(a.id, { stage: 'clearing', turnsAtSubmit: session.turnsEnded })
          return
        }
        if (delivered === 'delivered') {
          // A cleared session starts a new transcript, so its usage starts again from nothing.
          const baseline = active.cleared ? {} : (session.usage ?? (active.fresh ? {} : undefined))
          this.patchActive(a.id, { stage: 'running', submittedAt: this.host.now(), turnsAtSubmit: session.turnsEnded, ...(baseline ? { usageBaseline: baseline } : {}) })
          return
        }
      }
      if (now - (active.run.startedAt ?? now) > DELIVERY_TIMEOUT_MS) this.finish(a, 'error', 'neverIdle')
      return
    }
    const submittedAt = active.submittedAt ?? now
    if (now - submittedAt > Math.max(a.runTimeoutMinutes, 1) * 60_000) {
      await this.host.sessions.interrupt(session.id).catch(() => undefined)
      return this.finish(a, 'timeout', `timeout:${a.runTimeoutMinutes}`)
    }
    if (a.view === 'app') {
      if (session.turnsEnded > active.turnsAtSubmit && session.state === 'ready') this.finish(a, 'ok')
      return
    }
    const quietSince = Math.max(session.lastOutputAt ?? submittedAt, submittedAt)
    if (now - quietSince >= CONSOLE_QUIET_MS) this.finish(a, 'ok')
  }

  private patchActive(id: string, patch: Partial<Active>): void {
    const s = this.runState(id)
    if (s.active) this.runtime.set(id, { ...s, active: { ...s.active, ...patch } })
  }

  // Finishing and failures

  private finish(a: AutomationDefinition, outcome: AutomationOutcome, detail?: string, resetsAt?: number): void {
    const s = this.runState(a.id)
    if (!s.active) return
    const baseline = s.active.usageBaseline
    const sessionId = s.active.sessionId
    const spent = baseline && sessionId ? usageDelta(baseline, this.host.sessions.list().find((x) => x.id === sessionId)?.usage) : {}
    const run: AutomationRun = { ...s.active.run, outcome, endedAt: this.host.now(), ...(detail ? { detail } : {}), ...spent }
    if (baseline && sessionId) this.settling.set(run.id, { automationId: a.id, sessionId, baseline, until: this.host.now() + USAGE_SETTLE_MS })
    let next: RunState = { ...s, active: undefined }
    if (outcome === 'ok') next = { ...next, failureStreak: 0, notified: false, lastError: undefined, pausedUntil: undefined, pauseReason: undefined }
    this.runtime.set(a.id, next)
    this.log(run)
    if (FAILURE_OUTCOMES.includes(outcome)) this.registerFailure(a, outcome, detail ?? outcome, resetsAt)
  }

  /** Refreshes the usage of runs that just ended, until the monitor has read their last turn. */
  private settleUsage(): void {
    if (!this.settling.size) return
    const now = this.host.now()
    const sessions = this.host.sessions.list()
    let runs = this.state.runs
    for (const [runId, w] of this.settling) {
      const index = runs.findIndex((r) => r.id === runId)
      if (index < 0 || now > w.until) {
        this.settling.delete(runId)
        continue
      }
      const spent = usageDelta(w.baseline, sessions.find((x) => x.id === w.sessionId)?.usage)
      const row = runs[index]!
      if (spent.tokens === row.tokens && spent.cost?.amount === row.cost?.amount) continue
      runs = runs.map((r, i) => (i === index ? { ...row, ...spent } : r))
    }
    if (runs !== this.state.runs) this.save({ ...this.state, runs })
  }

  /** A failure notifies once per streak, then pauses automatic runs until the limit resets, or with a backoff. */
  private registerFailure(a: AutomationDefinition, outcome: AutomationOutcome, reason: string, resetsAt?: number): void {
    const now = this.host.now()
    const s = this.runState(a.id)
    const streak = s.failureStreak + 1
    if (!s.notified) this.host.notify({ kind: 'failed', automationId: a.id, automationName: a.name, outcome, detail: reason.slice(0, 160) })
    const paused =
      outcome === 'rateLimited' && resetsAt && resetsAt > now
        ? { pausedUntil: resetsAt + 30_000, pauseReason: 'rateLimited' as const }
        : { pausedUntil: now + failureBackoffMs(streak), pauseReason: 'backoff' as const }
    this.runtime.set(a.id, { ...s, failureStreak: streak, notified: true, lastError: reason, ...paused })
  }

  private log(run: AutomationRun): void {
    this.save({ ...this.state, runs: [run, ...this.state.runs].slice(0, RUN_LOG_LIMIT) })
  }

  private save(state: AutomationsState): void {
    this.state = state
    this.host.persist(state)
  }
}
