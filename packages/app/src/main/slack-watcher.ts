import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  accountAgentId,
  applyDigest,
  canonicalUrl,
  chatWatcherSettings,
  closeFinished,
  effectiveAgentKey,
  EMPTY_CHAT_STATE,
  ingestRecord,
  isListening,
  listeningThreadsOf,
  logRun,
  MIN_WATCH_INTERVAL_MINUTES,
  msToTs,
  planWake,
  PR_CHECK_INTERVAL_MS,
  recordWake,
  reopenThread,
  sendRepliesToOwner,
  sessionIdentity,
  THREADS_PER_READ,
  trackMessage,
  trackPermalink,
  transferThreads,
  updateThread,
  wakeText,
  windowReason,
  autoCloseReason,
  closeThread,
  type BudgetStatus,
  type ChatNotice,
  type ChatReadResult,
  type ChatSource,
  type ChatTrackingHook,
  type ChatWatcherSettings,
  type ChatWatcherState,
  type ChatMessage,
  type ConfigurationService,
  type TrackedThread,
  type WakePlan,
  type WorkhubConfig
} from '@workhub/core'
import { agentKeyBudget } from './agent-usage'
import type { DemoChatSource } from '@workhub/adapters/chat-slack'
import { locateClaudeTranscript } from '@workhub/adapters/transcript-claude'
import type { AccountUsage, SessionView, StartSessionInput } from '../shared/api'
import type { ChatNoticeEvent, SlackDemoInput, SlackHealth, SlackHookAccount, SlackResult, SlackSnapshot, TrackThreadInput } from '../shared/chat-api'
import { claudeAccounts } from './claude-accounts'
import { OwnerStarts } from './owner-starts'
import type { SessionDriver } from './session-driver'
import type { StateFile } from './state-file'

/** What the automations tell the watcher (set once both exist). */
export interface ChatAutomationLink {
  onMessages(messages: readonly ChatMessage[], me: string): void
  wakeBlocked(identity: string): string | null
  ignoresChat(identity: string): boolean
}

export interface SlackWatcherDeps {
  configuration: ConfigurationService
  source: ChatSource
  hook: ChatTrackingHook
  /** Set in demo mode (WORKHUB_DEMO_SLACK=1). */
  demo: DemoChatSource | null
  state: StateFile<ChatWatcherState>
  driver: SessionDriver
  startSession: (input: StartSessionInput) => Promise<SessionView>
  /** The per-identity single start shared with the sidebar's reopen; one of its own when absent (tests). */
  ownerStarts?: OwnerStarts
  home: string
  usage: () => AccountUsage[]
  /** The usage budget verdict of an account (Settings → Usage); wakes and reads wait past a ceiling. */
  budgetOf?: (agentId: string, accountId: string | null) => BudgetStatus
  /** Canonical URLs of the user's open PRs in the active profile. */
  myPullRequests: () => Promise<Set<string>>
  /** `open`, `merged` or `closed`; undefined when it could not be read. */
  prState: (url: string) => Promise<string | undefined>
  emit: (snapshot: SlackSnapshot) => void
  notice: (notice: ChatNoticeEvent) => void
  now?: () => number
}

const TICK_MS = 30_000
const INBOX_MS = 5_000
const PR_READS_PER_RUN = 8
const BACKOFF_CAP_MS = 3_600_000
/** A transcript written this recently belongs to a session open somewhere else (another terminal). */
const ELSEWHERE_MS = 120_000

/**
 * The Slack watcher of the main process (Workhub 1's SlackWatcher): reads the watched channels and
 * followed threads on a schedule through a read-only ChatSource, follows the threads sessions
 * start (the hook's inbox), tells the automations about new messages and hands replies to the one
 * session that owns each thread. Its state is one file for every profile and account.
 */
export class SlackWatcherService {
  private state: ChatWatcherState
  private running = false
  private failureStreak = 0
  private notifiedFailure = false
  private lastError: string | undefined
  private nextRunAt: number | undefined
  private pausedUntil: number | undefined
  private skipReason: SlackSnapshot['skipReason']
  private delivering = false
  private readonly opening = new Map<string, number>()
  /** Owners being opened right now: a wake, a click on "Open" and the sidebar's reopen share one session. */
  private readonly ownerStarts: OwnerStarts
  private readonly prStates = new Map<string, { state?: string; checkedAt: number }>()
  private hooks: SlackHookAccount[] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private automations: ChatAutomationLink | null = null
  private readonly now: () => number

  constructor(private readonly deps: SlackWatcherDeps) {
    this.now = deps.now ?? Date.now
    this.state = deps.state.load(EMPTY_CHAT_STATE)
    this.ownerStarts = deps.ownerStarts ?? new OwnerStarts({ views: () => deps.driver.views(), start: (input) => deps.startSession(input) })
  }

  link(automations: ChatAutomationLink): void {
    this.automations = automations
  }

  start(): void {
    if (this.timers.length) return
    this.timers.push(setInterval(() => void this.tick(), TICK_MS))
    this.timers.push(setInterval(() => void this.inboxBeat(), INBOX_MS))
    for (const t of this.timers) t.unref?.()
    void this.refreshHooks()
    void this.tick()
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.deps.state.flush()
  }

  // Schedule

  private async settings(): Promise<ChatWatcherSettings> {
    return chatWatcherSettings(await this.deps.configuration.current())
  }

  private interval(s: ChatWatcherSettings): number {
    return Math.max(s.intervalMinutes, MIN_WATCH_INTERVAL_MINUTES) * 60_000
  }

  async tick(): Promise<void> {
    const s = await this.settings()
    if (!s.enabled || this.running) return
    const now = this.now()
    if ((this.nextRunAt && this.nextRunAt > now) || (this.pausedUntil && this.pausedUntil > now)) return
    const outside = windowReason({ days: s.weekdays, startHour: s.startHour, endHour: s.endHour }, now)
    if (outside) return this.setSkip(outside)
    const usage = this.usagePercent(s.accountId)
    if (usage !== null && usage >= s.usageThreshold) {
      this.nextRunAt = now + this.interval(s)
      return this.setSkip('usage')
    }
    // Reading Slack runs a turn on the Claude account: it pauses while that account is past its usage ceiling.
    if (this.deps.budgetOf?.('claude', s.accountId).action === 'block') {
      this.nextRunAt = now + this.interval(s)
      return this.setSkip('budget')
    }
    this.skipReason = undefined
    await this.cycle()
  }

  private setSkip(reason: NonNullable<SlackSnapshot['skipReason']>): void {
    if (this.skipReason === reason) return
    this.skipReason = reason
    this.changed()
  }

  private usagePercent(accountId: string | null): number | null {
    const windows = this.deps.usage().find((u) => u.agentId === 'claude' && u.accountId === accountId)?.windows ?? []
    return windows.find((w) => w.window === '5h')?.percent ?? null
  }

  /** Reads now, whatever the schedule, window or usage say. */
  async runNow(): Promise<void> {
    await this.cycle()
  }

  private async cycle(): Promise<void> {
    if (this.running) return
    this.running = true
    this.changed()
    const started = this.now()
    try {
      const s = await this.settings()
      // Threads that are done stop being followed before the request is built, so they are not read.
      await this.closeFinishedThreads()
      const open = this.state.threads.filter((t) => !t.closed).slice(0, THREADS_PER_READ)
      if (!s.channels.length && !open.length) {
        this.lastError = 'nothingToWatch'
        return
      }
      const result = await this.deps.source
        .read({ channels: s.channels, cursors: this.state.cursors, threads: open, model: s.model, now: started, ...(this.configDirOf(s.accountId) ? { configDir: this.configDirOf(s.accountId) } : {}) })
        .catch((err: unknown): ChatReadResult => ({ ok: false, failure: 'failed', error: err instanceof Error ? err.message : String(err), deniedTools: [] }))
      if (!result.ok) return this.recordFailure(s, result, started)
      const myPrs = await this.deps.myPullRequests().catch(() => new Set<string>())
      const applied = applyDigest(this.state, result.digest, { channelIds: s.channels.map((c) => c.id), myPullRequests: myPrs })
      this.lastError = undefined
      this.failureStreak = 0
      this.notifiedFailure = false
      this.pausedUntil = undefined
      this.nextRunAt = this.now() + this.interval(s)
      const denied = result.deniedTools
      this.setState(
        logRun(applied.state, {
          id: randomUUID(),
          at: started,
          durationMs: this.now() - started,
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ok: true,
          outcome: applied.messages + applied.replies === 0 ? 'nothing new' : 'ok',
          messages: applied.messages,
          replies: applied.replies,
          deniedTools: denied
        })
      )
      for (const n of applied.notices) this.deps.notice(n)
      if (applied.fresh.length) this.automations?.onMessages(applied.fresh, this.state.me)
      if (applied.replies) await this.deliverPendingWakes()
    } finally {
      this.running = false
      this.changed()
    }
  }

  private recordFailure(s: ChatWatcherSettings, result: Extract<ChatReadResult, { ok: false }>, started: number): void {
    const now = this.now()
    this.lastError = result.error
    this.failureStreak += 1
    if (!this.notifiedFailure) {
      this.notifiedFailure = true
      this.deps.notice({ kind: 'watchFailed', error: result.error })
    }
    // Rate limited: wait for the reset when known; otherwise back off exponentially.
    let next = now + Math.min(this.interval(s) * 2 ** this.failureStreak, BACKOFF_CAP_MS)
    if (result.failure === 'rateLimited' && result.resetsAt && result.resetsAt > now) {
      this.pausedUntil = result.resetsAt + 30_000
      next = Math.max(next, this.pausedUntil)
    }
    this.nextRunAt = next
    const denied = result.deniedTools.length ? ` (${result.deniedTools.map((t) => `denied tool: ${t}`).join('; ')})` : ''
    this.setState(
      logRun(this.state, {
        id: randomUUID(),
        at: started,
        durationMs: now - started,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        ok: false,
        outcome: result.error + denied,
        messages: 0,
        replies: 0,
        deniedTools: result.deniedTools
      })
    )
  }

  /** Closes threads whose PR is merged or closed (a PR read at most once an hour) or idle for 7 days. */
  private async closeFinishedThreads(): Promise<void> {
    const now = this.now()
    const due: string[] = []
    for (const t of this.state.threads) {
      if (t.closed || !t.prUrl || t.reopenedAt !== undefined || autoCloseReason(t, undefined, now)) continue
      const key = canonicalUrl(t.prUrl)
      const known = this.prStates.get(key)
      if (due.includes(key) || (known && now - known.checkedAt < PR_CHECK_INTERVAL_MS)) continue
      due.push(key)
    }
    for (const key of due.slice(0, PR_READS_PER_RUN)) {
      this.prStates.set(key, { ...this.prStates.get(key), checkedAt: now })
      const state = await this.deps.prState(key).catch(() => undefined)
      this.prStates.set(key, { ...(state ? { state } : {}), checkedAt: this.now() })
    }
    const states = new Map([...this.prStates].flatMap(([k, v]) => (v.state ? [[k, v.state] as const] : [])))
    const next = closeFinished(this.state, states, now)
    if (next !== this.state) this.setState(next)
  }

  // The hook's inbox and the wakes

  private async inboxBeat(): Promise<void> {
    await this.ingestInbox()
    await this.deliverPendingWakes()
  }

  async ingestInbox(): Promise<void> {
    const records = await this.deps.hook.drain().catch(() => [])
    if (!records.length) return
    const config = await this.deps.configuration.current()
    let state = this.state
    const notices: ChatNotice[] = []
    for (const record of records) {
      const r = ingestRecord(state, record, {
        now: this.now(),
        newId: randomUUID,
        ignored: (id) => this.automations?.ignoresChat(id) ?? false,
        agentKeyFor: (dir) => this.agentKeyFor(config, dir)
      })
      state = r.state
      if (r.notice) notices.push(r.notice)
    }
    this.setState(state)
    for (const n of notices) this.deps.notice(n)
  }

  /**
   * Hands the waiting replies of each listening thread to its owner: typed in when it is open and
   * idle, opened in its own folder first when it is closed, only notified when it must not be
   * woken (its automation is off) or is open in another terminal.
   */
  async deliverPendingWakes(): Promise<void> {
    if (this.delivering) return
    this.delivering = true
    try {
      const now = this.now()
      for (const [id, at] of this.opening) if (now - at > 600_000) this.opening.delete(id)
      for (const thread of this.state.threads) {
        if (!isListening(thread) || !thread.pendingWake.length) continue
        await this.wake(thread)
      }
    } finally {
      this.delivering = false
    }
  }

  private async wake(thread: TrackedThread): Promise<void> {
    const owner = thread.owner!
    const now = this.now()
    const views = this.deps.driver.views()
    const candidates = views.map((v) => ({ id: v.id, identity: sessionIdentity(v), state: v.state, startedAt: v.startedAt }))
    const knownHere = candidates.some((c) => c.identity === owner)
    const live = candidates.some((c) => c.identity === owner && c.state !== 'stopped' && c.state !== 'error')
    const located = live ? null : await locateClaudeTranscript(owner, await this.claudeDirs())
    const plan = planWake(thread, {
      sessions: candidates,
      now,
      ...(this.opening.has(owner) ? { openingSince: this.opening.get(owner)! } : {}),
      blocked: this.automations?.wakeBlocked(owner) ?? null,
      // A transcript that changed in the last two minutes, of a session Workhub does not have, is open elsewhere.
      openElsewhere: located && !knownHere && now - located.modifiedAt < ELSEWHERE_MS ? 'openElsewhere' : null,
      transcriptCwd: located?.cwd ?? null
    })
    const update = (change: (t: TrackedThread) => TrackedThread) => this.setState(updateThread(this.state, thread.id, change))
    if (await this.pausedByBudget(thread, plan, views, located?.configDir)) return
    switch (plan.kind) {
      case 'deliver': {
        const outcome = await this.deps.driver.deliver(plan.sessionId, wakeText(thread, thread.pendingWake))
        update((t) => (outcome === 'delivered' ? recordWake(t, 'delivered', 'delivered', this.now(), true) : recordWake(t, 'pending', 'busy', this.now(), false)))
        return
      }
      case 'wait':
        update((t) => recordWake(t, 'pending', plan.reason, this.now(), false))
        return
      case 'notifyOnly':
        // The replies were handed over as a notice: the next ones may open the session again.
        if (plan.reason === 'openFailed') this.opening.delete(owner)
        this.deps.notice({ kind: 'notWoken', threadId: thread.id, title: thread.title, reason: plan.reason, replies: thread.pendingWake.map((r) => ({ user: r.user, text: r.text })) })
        update((t) => recordWake(t, 'notifyOnly', plan.reason, this.now(), true))
        return
      case 'missing':
        update((t) => recordWake(t, 'pending', 'transcriptMissing', this.now(), false))
        return
      case 'reopen': {
        // Marked before anything is awaited, so no later pass opens a second copy meanwhile.
        this.opening.set(owner, now)
        const config = await this.deps.configuration.current()
        try {
          await this.resumeOwner(owner, {
            profileId: this.profileOf(owner, views, config),
            agentKey: plan.agentKey ?? this.agentKeyFor(config, located?.configDir) ?? 'claude',
            cwd: plan.cwd,
            mode: 'app',
            cols: 100,
            rows: 30
          })
          update((t) => recordWake(t, 'pending', 'opening', this.now(), false))
        } catch (err) {
          this.opening.delete(owner)
          update((t) => recordWake(t, 'pending', err instanceof Error ? err.message : String(err), this.now(), false))
        }
      }
    }
  }

  /**
   * A wake that would type into or reopen a session waits while that session's account is past a
   * usage ceiling (Settings → Usage). The replies stay pending and are delivered once the window
   * resets or the ceiling is raised or cleared; the user is told once per pause.
   */
  private async pausedByBudget(thread: TrackedThread, plan: WakePlan, views: SessionView[], configDir: string | undefined): Promise<boolean> {
    const budgetOf = this.deps.budgetOf
    if (!budgetOf || (plan.kind !== 'deliver' && plan.kind !== 'reopen')) return false
    const config = await this.deps.configuration.current()
    let agentKey: string | undefined
    if (plan.kind === 'deliver') {
      const view = views.find((v) => v.id === plan.sessionId)
      agentKey = view ? (view.accountId ? `${view.agentId}:${view.accountId}` : view.agentId) : undefined
    } else {
      agentKey = plan.agentKey ?? this.agentKeyFor(config, configDir) ?? 'claude'
    }
    if (!agentKey || agentKeyBudget(config, agentKey, budgetOf).action !== 'block') return false
    const already = thread.wakeLog[0]?.detail === 'budget'
    this.setState(updateThread(this.state, thread.id, (t) => recordWake(t, 'pending', 'budget', this.now(), false)))
    if (!already) this.deps.notice({ kind: 'notWoken', threadId: thread.id, title: thread.title, reason: 'budget', replies: thread.pendingWake.map((r) => ({ user: r.user, text: r.text })) })
    return true
  }

  // Ownership, for the automations

  transferThreads(from: string, to: string, agentKey: string): number {
    const r = transferThreads(this.state.threads, from, to, agentKey)
    if (r.moved) this.setState({ ...this.state, threads: r.threads })
    return r.moved
  }

  /** A session got its real identity after starting (ACP): the threads it owns follow it. */
  renameOwner(oldKey: string, newKey: string): void {
    if (oldKey === newKey || !this.state.threads.some((t) => t.owner === oldKey)) return
    this.setState({ ...this.state, threads: this.state.threads.map((t) => (t.owner === oldKey ? { ...t, owner: newKey } : t)) })
  }

  listeningThreads(identity: string): number {
    return listeningThreadsOf(this.state.threads, identity).length
  }

  // Actions from the Slack screen

  async track(input: TrackThreadInput): Promise<{ ok: true } | { ok: false; error: 'notAPermalink' | 'alreadyTracked' }> {
    const view = input.sessionId ? this.deps.driver.views().find((v) => v.id === input.sessionId) : undefined
    const r = trackPermalink(
      this.state,
      {
        permalink: input.permalink,
        ...(input.title ? { title: input.title } : {}),
        ...(input.prUrl ? { prUrl: input.prUrl } : {}),
        ...(input.ticketKey ? { ticketKey: input.ticketKey } : {}),
        ...(view ? { owner: sessionIdentity(view), ownerAgentKey: effectiveAgentKey(view.agentId, view.accountId) } : {}),
        wake: Boolean(view && input.wake)
      },
      this.now(),
      randomUUID
    )
    if (r.error) return { ok: false, error: r.error }
    this.setState(r.state)
    return { ok: true }
  }

  trackMessage(channelId: string, ts: string): void {
    const message = (this.state.messages[channelId] ?? []).find((m) => m.ts === ts)
    if (message) this.setState(trackMessage(this.state, message, this.now(), randomUUID))
  }

  setClosed(id: string, closed: boolean): void {
    this.setState(updateThread(this.state, id, (t) => (closed ? closeThread(t) : reopenThread(t, this.now()))))
  }

  setWake(id: string, wake: boolean): void {
    this.setState(updateThread(this.state, id, (t) => ({ ...t, wake: wake && Boolean(t.owner) })))
  }

  remove(id: string): void {
    this.setState({ ...this.state, threads: this.state.threads.filter((t) => t.id !== id) })
  }

  async sendToSession(id: string): Promise<void> {
    this.setState(updateThread(this.state, id, (t) => sendRepliesToOwner(t, this.state.me, this.now())))
    await this.deliverPendingWakes()
  }

  markViewed(ids: readonly string[]): void {
    const wanted = new Set(ids)
    let changed = false
    const threads = this.state.threads.map((t) => {
      if (!wanted.has(t.id) || t.lastViewedReplyTs === t.lastSeenReplyTs) return t
      changed = true
      return { ...t, lastViewedReplyTs: t.lastSeenReplyTs }
    })
    if (changed) this.setState({ ...this.state, threads })
  }

  /** The owner's view id: the open session, or the session resumed in its own folder. */
  async openOwner(threadId: string): Promise<string | null> {
    const thread = this.state.threads.find((t) => t.id === threadId)
    if (!thread?.owner) return null
    const views = this.deps.driver.views()
    const open = views.filter((v) => sessionIdentity(v) === thread.owner && v.state !== 'stopped' && v.state !== 'error').sort((a, b) => b.startedAt - a.startedAt)[0]
    if (open) return open.id
    const located = await locateClaudeTranscript(thread.owner, await this.claudeDirs())
    if (!located?.cwd) return views.filter((v) => sessionIdentity(v) === thread.owner).sort((a, b) => b.startedAt - a.startedAt)[0]?.id ?? null
    const config = await this.deps.configuration.current()
    const view = await this.resumeOwner(thread.owner, {
      profileId: this.profileOf(thread.owner, views, config),
      agentKey: thread.ownerAgentKey ?? this.agentKeyFor(config, located.configDir) ?? 'claude',
      cwd: located.cwd,
      cols: 100,
      rows: 30
    })
    return view.id
  }

  /**
   * Resumes a thread's owner, once: while it is being opened (a wake, a click on "Open") every
   * other caller gets that same session, and one already open is returned instead of a copy.
   */
  private resumeOwner(owner: string, input: Omit<StartSessionInput, 'resumeAgentSessionId'>): Promise<SessionView> {
    return this.ownerStarts.start(owner, { ...input, resumeAgentSessionId: owner })
  }

  /** The profile the owner last ran in here (its sidebar place and colour stay), else the active one. */
  private profileOf(owner: string, views: readonly SessionView[], config: WorkhubConfig): string | null {
    const last = views.filter((v) => sessionIdentity(v) === owner).sort((a, b) => b.startedAt - a.startedAt)[0]
    return last?.profileId ?? config.activeProfileId ?? null
  }

  // The tracking hook (Settings → Slack)

  async refreshHooks(): Promise<void> {
    const config = await this.deps.configuration.current()
    const accounts = claudeAccounts(config, this.deps.home)
    this.hooks = await Promise.all(
      accounts.map(async (a) => {
        const configDir = this.resolveDir(a.configDir)
        // Demo mode never reads a real account's settings.
        const status = this.deps.demo ? ({ state: 'notInstalled' } as const) : await this.deps.hook.status(configDir)
        return { accountId: a.accountId, name: a.name, configDir, status }
      })
    )
    this.changed()
  }

  /** Adds or removes the hook; only ever called from the user's click in Settings. Disabled in demo mode. */
  async setHook(accountId: string | null, install: boolean): Promise<SlackResult> {
    if (this.deps.demo) return { ok: false, error: 'demoMode' }
    const account = this.hooks.find((h) => h.accountId === accountId)
    if (!account) return { ok: false, error: 'unknownAccount' }
    try {
      if (install) await this.deps.hook.install(account.configDir)
      else await this.deps.hook.remove(account.configDir)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await this.refreshHooks()
    }
  }

  // Demo mode

  async demo(input: SlackDemoInput): Promise<SlackResult> {
    const demo = this.deps.demo
    if (!demo) return { ok: false, error: 'notDemo' }
    if (input.kind === 'message') {
      demo.inject({ channelId: input.channelId, user: input.user, text: input.text, ...(input.ts ? { ts: input.ts } : {}), ...(input.replay ? { replay: true } : {}) })
    } else if (input.kind === 'reply') {
      const thread = this.state.threads.find((t) => t.id === input.threadId)
      if (!thread) return { ok: false, error: 'unknownThread' }
      demo.injectReply({ channelId: thread.channelId, threadTs: thread.ts, user: input.user, text: input.text })
    } else {
      // What the tracking hook would have recorded, without any hook installed.
      const view = this.deps.driver.views().find((v) => v.id === input.sessionId)
      if (!view) return { ok: false, error: 'unknownSession' }
      const config = await this.deps.configuration.current()
      const r = ingestRecord(this.state, { sessionId: sessionIdentity(view), channelId: input.channelId, ts: msToTs(this.now()), text: input.text, cwd: view.cwd }, { now: this.now(), newId: randomUUID, ignored: (id) => this.automations?.ignoresChat(id) ?? false, agentKeyFor: () => effectiveAgentKey(view.agentId, view.accountId) || this.agentKeyFor(config, undefined) })
      this.setState(r.state)
      if (r.notice) this.deps.notice(r.notice)
      return { ok: true }
    }
    await this.cycle()
    return { ok: true }
  }

  // Helpers

  private resolveDir(configDir: string | undefined): string {
    return resolve(configDir || process.env['CLAUDE_CONFIG_DIR'] || join(this.deps.home, '.claude'))
  }

  private configDirOf(accountId: string | null): string | undefined {
    const ref = this.hooks.find((h) => h.accountId === accountId)
    return accountId ? ref?.configDir : undefined
  }

  private async claudeDirs(): Promise<string[]> {
    return claudeAccounts(await this.deps.configuration.current(), this.deps.home).map((a) => this.resolveDir(a.configDir))
  }

  /** The agent key of the Claude account behind a config folder. */
  private agentKeyFor(config: WorkhubConfig, configDir: string | undefined): string | undefined {
    if (!configDir) return undefined
    const dir = resolve(configDir)
    const account = config.accounts.find((a) => a.agentId === accountAgentId({ id: 'claude' }) && this.resolveDir(a.configDir) === dir)
    return account ? effectiveAgentKey('claude', account.id) : this.resolveDir(undefined) === dir ? 'claude' : undefined
  }

  private health(s: ChatWatcherSettings): SlackHealth {
    if (!s.enabled) return 'off'
    if (this.running) return 'checking'
    if (this.failureStreak > 0 && this.lastError) return 'failing'
    if ((this.pausedUntil && this.pausedUntil > this.now()) || this.skipReason === 'days' || this.skipReason === 'hours') return 'paused'
    return 'watching'
  }

  async snapshot(): Promise<SlackSnapshot> {
    const s = await this.settings()
    const messages = Object.values(this.state.messages)
      .flat()
      .sort((a, b) => Number(b.ts) - Number(a.ts))
    return {
      settings: s,
      demo: Boolean(this.deps.demo),
      health: this.health(s),
      ...(this.skipReason ? { skipReason: this.skipReason } : {}),
      ...(this.nextRunAt ? { nextRunAt: this.nextRunAt } : {}),
      ...(this.pausedUntil ? { pausedUntil: this.pausedUntil } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      messages,
      threads: this.state.threads,
      runs: this.state.runs,
      me: this.state.me,
      hooks: this.hooks
    }
  }

  private setState(next: ChatWatcherState): void {
    this.state = next
    this.deps.state.save(next)
    this.changed()
  }

  private changed(): void {
    void this.snapshot().then(this.deps.emit, () => undefined)
  }
}
