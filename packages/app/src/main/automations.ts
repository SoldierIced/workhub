import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  AutomationEngine,
  EMPTY_AUTOMATIONS_STATE,
  startedInWindow,
  startedToday,
  type AutomationDefinition,
  type AutomationHost,
  type AutomationNotice,
  type AutomationsState,
  type ConfigurationService,
  type DrivenSession,
  type Result,
  type WorkhubConfig
} from '@workhub/core'
import { locateClaudeTranscript } from '@workhub/adapters/transcript-claude'
import type { AccountUsage, SessionView, StartSessionInput } from '../shared/api'
import type { AutomationsSnapshot, AutomationStatus, ChatNoticeEvent } from '../shared/chat-api'
import { claudeAccounts } from './claude-accounts'
import type { SessionDriver } from './session-driver'
import type { SlackWatcherService } from './slack-watcher'
import type { StateFile } from './state-file'

export interface AutomationServiceDeps {
  configuration: ConfigurationService
  driver: SessionDriver
  startSession: (input: StartSessionInput) => Promise<SessionView>
  watcher: SlackWatcherService
  state: StateFile<AutomationsState>
  home: string
  usage: () => AccountUsage[]
  emit: (snapshot: AutomationsSnapshot) => void
  /** The stored config changed here (a session's sidebar place moved); the renderer reloads it. */
  configChanged: () => void
  notice: (notice: ChatNoticeEvent) => void
}

const TICK_MS = 2_000
const START_WAIT_MS = 60_000

/** `~` and `~/…` in a folder typed by the user. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/** `agentId[:accountId]` of an agent key. */
function accountOf(agentKey: string): { agentId: string; accountId: string | null } {
  const at = agentKey.indexOf(':')
  return at < 0 ? { agentId: agentKey, accountId: null } : { agentId: agentKey.slice(0, at), accountId: agentKey.slice(at + 1) }
}

/**
 * The automations of the main process: the core engine on top of the session manager, the
 * config, the usage reader and the Slack watcher (which owns the chat threads).
 */
export class AutomationService {
  readonly engine: AutomationEngine
  private defs: AutomationDefinition[] = []
  private config: WorkhubConfig | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private emitQueued = false

  constructor(private readonly deps: AutomationServiceDeps) {
    this.engine = new AutomationEngine(this.host(), deps.state.load(EMPTY_AUTOMATIONS_STATE))
    deps.driver.onIdentityChanged = (oldKey, newKey) => {
      this.engine.identityChanged(oldKey, newKey)
      deps.watcher.renameOwner(oldKey, newKey)
    }
    deps.watcher.link({
      onMessages: (messages, me) => {
        if (this.engine.onChatMessages(messages, me)) void this.tick()
      },
      wakeBlocked: (identity) => this.engine.wakeBlocked(identity),
      ignoresChat: (identity) => this.engine.ignoresChat(identity)
    })
  }

  async start(): Promise<void> {
    await this.reload()
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.deps.state.flush()
  }

  private async reload(): Promise<void> {
    this.config = await this.deps.configuration.current()
    this.defs = this.config.automations ?? []
  }

  async tick(): Promise<void> {
    await this.reload()
    await this.engine.tick()
    this.changed()
  }

  private host(): AutomationHost {
    return {
      now: () => Date.now(),
      newId: () => randomUUID(),
      definitions: () => this.defs,
      isActive: (a) => this.isActive(a),
      sessions: {
        list: () => this.deps.driver.list(),
        start: (a, previous) => this.open(a, previous),
        deliver: (id, text) => this.deps.driver.deliver(id, text),
        interrupt: (id) => this.deps.driver.interrupt(id),
        stop: (id) => this.deps.driver.stop(id),
        forget: (id) => this.deps.driver.forget(id)
      },
      usagePercent: (a) => {
        const { agentId, accountId } = accountOf(a.agentKey)
        if (agentId !== 'claude') return null
        const windows = this.deps.usage().find((u) => u.accountId === accountId)?.windows ?? []
        return windows.find((w) => w.window === '5h')?.percent ?? null
      },
      readGate: async (path) => {
        try {
          return JSON.parse(await readFile(expandHome(path, this.deps.home), 'utf8')) as unknown
        } catch {
          return undefined
        }
      },
      replaceIdentity: async (oldKey, newKey) => {
        const r = await this.deps.configuration.replaceSessionIdentity(oldKey, newKey)
        if (r.ok) this.deps.configChanged()
      },
      transferThreads: (oldKey, newKey, agentKey) => this.deps.watcher.transferThreads(oldKey, newKey, agentKey),
      listeningThreads: (identity) => this.deps.watcher.listeningThreads(identity),
      notify: (n: AutomationNotice) => this.deps.notice({ kind: 'automationFailed', automationName: n.automationName, outcome: n.outcome, detail: n.detail }),
      persist: (state) => {
        this.deps.state.save(state)
        this.changed()
      }
    }
  }

  /** An automation runs only while its profile has the Automations module on (one without a profile always can). */
  private isActive(a: AutomationDefinition): boolean {
    if (!a.profileId) return true
    return this.config?.profiles.find((p) => p.id === a.profileId)?.modules.automations === true
  }

  /**
   * Opens the automation's session in the background. With `previous`, a Claude session is
   * resumed in the folder its transcript records; any other agent starts again under that
   * identity, so it keeps its sidebar place.
   */
  private async open(a: AutomationDefinition, previous?: string): Promise<DrivenSession> {
    const folder = resolve(expandHome(a.folder || '~', this.deps.home))
    const isDir = await stat(folder).then((s) => s.isDirectory(), () => false)
    if (!isDir) throw new Error(`folder not found: ${folder}`)
    const input: StartSessionInput = { profileId: a.profileId, agentKey: a.agentKey, cwd: folder, mode: a.view, cols: 120, rows: 32, ...(a.model ? { model: a.model } : {}) }
    if (previous) {
      const dirs = claudeAccounts(this.config ?? (await this.deps.configuration.current()), this.deps.home).map((c) => resolve(c.configDir || process.env['CLAUDE_CONFIG_DIR'] || join(this.deps.home, '.claude')))
      const located = accountOf(a.agentKey).agentId === 'claude' ? await locateClaudeTranscript(previous, dirs) : null
      if (located) Object.assign(input, { resumeAgentSessionId: previous, cwd: located.cwd ?? folder })
      else input.identity = previous
    }
    const view = await this.deps.startSession(input)
    // An ACP agent reports its session id once it has started: wait for it, so the hand-over uses the real identity.
    const until = Date.now() + START_WAIT_MS
    let current = this.deps.driver.list().find((s) => s.id === view.id)
    while (current?.state === 'starting' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200))
      current = this.deps.driver.list().find((s) => s.id === view.id)
    }
    return current ?? { id: view.id, identity: view.agentSessionId ?? view.identity ?? view.id, state: view.state, turnsEnded: 0 }
  }

  // Actions from the Automations screen

  async save(automation: AutomationDefinition): Promise<Result<WorkhubConfig>> {
    const before = this.defs.find((d) => d.id === automation.id)
    const r = await this.deps.configuration.saveAutomation(automation)
    if (r.ok) {
      if (before && !before.enabled && automation.enabled) this.engine.resumed(automation.id)
      await this.reload()
      this.changed()
    }
    return r
  }

  async remove(id: string): Promise<Result<WorkhubConfig>> {
    const r = await this.deps.configuration.deleteAutomation(id)
    if (r.ok) {
      this.engine.removed(id)
      await this.reload()
      this.changed()
    }
    return r
  }

  async setEnabled(id: string, enabled: boolean): Promise<Result<WorkhubConfig>> {
    const a = this.defs.find((d) => d.id === id)
    if (!a) return { ok: false, issues: [{ path: 'automations', message: `unknown automation ${id}` }] }
    return this.save({ ...a, enabled })
  }

  async runNow(id: string): Promise<void> {
    this.engine.runNow(id)
    await this.tick()
  }

  async stopRun(id: string): Promise<void> {
    await this.engine.stopRun(id)
    this.changed()
  }

  /** The automation's session: the open one, or the last one reopened. */
  async openSession(id: string): Promise<string | null> {
    const a = this.defs.find((d) => d.id === id)
    const identity = this.engine.snapshot().sessions[id]
    if (!a || !identity) return null
    const live = this.deps.driver.list().find((s) => s.identity === identity && s.state !== 'stopped' && s.state !== 'error')
    if (live) return live.id
    return (await this.open(a, identity)).id
  }

  setViewing(sessionId: string | null): void {
    this.deps.driver.setViewing(sessionId)
  }

  snapshot(): AutomationsSnapshot {
    const now = Date.now()
    const state = this.engine.snapshot()
    const automations = this.defs.map((a): AutomationStatus => {
      const s = this.engine.runState(a.id)
      const starts = state.starts[a.id] ?? []
      const status: AutomationStatus = {
        definition: a,
        health: this.engine.health(a),
        startedInWindow: startedInWindow(starts, a.limits, now),
        startedToday: startedToday(starts, now),
        active: this.isActive(a)
      }
      if (s.waitReason) status.waitReason = s.waitReason
      if (s.waitUntil) status.waitUntil = s.waitUntil
      if (s.pausedUntil && s.pausedUntil > now) status.pausedUntil = s.pausedUntil
      if (s.lastError) status.lastError = s.lastError
      if (s.lastCheck) status.lastCheck = s.lastCheck
      if (a.triggers.intervalMinutes && s.lastIntervalAt) status.nextIntervalAt = s.lastIntervalAt + a.triggers.intervalMinutes * 60_000
      if (state.sessions[a.id]) status.session = state.sessions[a.id]
      return status
    })
    return { automations, runs: state.runs }
  }

  /** Coalesces the snapshot pushes of one tick into one. */
  private changed(): void {
    if (this.emitQueued) return
    this.emitQueued = true
    queueMicrotask(() => {
      this.emitQueued = false
      this.deps.emit(this.snapshot())
    })
  }
}
