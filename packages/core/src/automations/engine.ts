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
  type AutomationTrigger
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
  stage: 'opening' | 'delivering' | 'running'
  submittedAt?: number
  turnsAtSubmit: number
}

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

/**
 * Turns triggers (a new chat message, an interval, "Run now") into runs of a prompt in a
 * dedicated session, one at a time per automation, inside its window, under its limits and the
 * usage guard. Bursts coalesce into one pending run. The app calls `tick` every couple of seconds.
 *
 * A "new session each run" automation hands everything of the previous session to the new one:
 * its sidebar group and position, and the chat threads it listens to (so a reply reaches exactly
 * one session). The previous session is then retired: stopped once it is idle, off screen and no
 * open thread wakes it, never before.
 */
export class AutomationEngine {
  private state: AutomationsState
  private readonly runtime = new Map<string, RunState>()
  private ticking = false

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
    const starts = { ...this.state.starts }
    delete starts[id]
    this.save({ ...this.state, starts })
  }

  /** A session got its real identity late (an ACP agent reports its id after starting): the records follow it. */
  identityChanged(oldKey: string, newKey: string): void {
    if (oldKey === newKey || !(oldKey in this.state.owned)) return
    const owned = { ...this.state.owned, [newKey]: this.state.owned[oldKey]! }
    delete owned[oldKey]
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
      const limit = limitWait(this.state.starts[a.id] ?? [], a.limits, now)
      if (limit) return this.setWait(a.id, `limit.${limit.reason}`, limit.until)
    }
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
    try {
      session = await this.resolveSession(a)
    } catch (err) {
      this.finish(a, 'error', err instanceof Error ? err.message : String(err))
      return
    }
    const s = this.runState(a.id)
    if (!s.active) return
    this.runtime.set(a.id, { ...s, active: { ...s.active, run: { ...s.active.run, session: session.identity }, sessionId: session.id, stage: 'delivering' } })
    await this.monitor(a)
  }

  /**
   * The dedicated session: the current one when it is open (reuse), the current one resumed, or
   * a new one. A new session that replaces another takes its sidebar place and its chat threads,
   * and the replaced one is retired (see `retire`).
   */
  private async resolveSession(a: AutomationDefinition): Promise<DrivenSession> {
    const previous = this.state.sessions[a.id]
    const sessions = this.host.sessions
    if (a.sessionPolicy === 'reuse' && previous) {
      const open = this.live(previous)
      if (open) return open
      const continued = await sessions.start(a, previous)
      this.adopt(a, continued.identity)
      if (continued.identity !== previous) await this.handOver(a, previous, continued.identity)
      return continued
    }
    const fresh = await sessions.start(a)
    this.adopt(a, fresh.identity)
    if (previous && previous !== fresh.identity) await this.handOver(a, previous, fresh.identity)
    return fresh
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
    if (active.stage === 'delivering') {
      if (session.state === 'ready') {
        const delivered = await this.host.sessions.deliver(session.id, a.prompt).catch(() => 'waiting' as const)
        if (delivered === 'delivered') {
          this.patchActive(a.id, { stage: 'running', submittedAt: this.host.now(), turnsAtSubmit: session.turnsEnded })
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
    const run: AutomationRun = { ...s.active.run, outcome, endedAt: this.host.now(), ...(detail ? { detail } : {}) }
    let next: RunState = { ...s, active: undefined }
    if (outcome === 'ok') next = { ...next, failureStreak: 0, notified: false, lastError: undefined, pausedUntil: undefined, pauseReason: undefined }
    this.runtime.set(a.id, next)
    this.log(run)
    if (FAILURE_OUTCOMES.includes(outcome)) this.registerFailure(a, outcome, detail ?? outcome, resetsAt)
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
