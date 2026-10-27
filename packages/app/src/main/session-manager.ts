import { randomUUID } from 'node:crypto'
import {
  accountAgent,
  BUILTIN_AGENTS,
  canSetModel,
  canSetSessionMode,
  consoleCommand,
  hasSessionControls,
  isTerminalControl,
  knownAgents,
  launchEnvironment,
  resolveEffectiveAgents,
  sessionScreens,
  type AgentAccount,
  type AgentAdapterKind,
  type AgentDefinition,
  type AgentEvent,
  type AgentRuntime,
  type ConfigurationService,
  type EffectiveAgent,
  type HistoryMessage,
  type ImageInput,
  type ModelOption,
  type SessionHistorySource,
  type SessionOrigin,
  type SessionModeOption,
  type SubagentConversation,
  type TranscriptReader,
  type WorkhubConfig
} from '@workhub/core'
import { terminalChannel, type SessionMode, type SessionView, type SetModeOptions, type StartSessionInput } from '../shared/api'
import { ConsoleActivity } from './console-activity'
import { pathInsideFolder } from './reveal'
import { cleanSessionName, type SessionNameStore } from './session-names'

/** What runs the session right now: the agent's runtime (app) or the agent's own TUI in a PTY (console). */
type Engine = 'app' | 'console'

interface ManagedSession {
  view: SessionView
  agent: AgentDefinition
  account: AgentAccount | null
  env: Record<string, string>
  runtime: AgentRuntime
  engine: Engine
  /** Set while the session hands over from one engine to the other. */
  switching: boolean
  /** The last transcript snapshot sent, to skip polls that found nothing new. */
  lastMonitor?: string
  /** An AI reviewer: started in the agent's most read-only mode, chat only. */
  readOnly: boolean
  /** The engine picked while a turn ran: the hand-over waits for the turn to end (Workhub 1's `pendingEngine`). */
  pending?: Engine
  pendingTimer?: ReturnType<typeof setTimeout>
  /** Permission requests of the app engine not answered yet: the turn waits on the user. */
  openPermissions: Set<string>
  /** What the console's terminal UI shows: a spinner while a turn runs, a notification when it asks. */
  console: ConsoleActivity
  /** When the console engine last started, so a tool call cut off by an earlier process never holds a switch. */
  consoleStartedAt: number
  /** Tool calls the transcript reports for this session, with their last status. */
  toolStatus: Map<string, { status?: string; startedAt?: number }>
  /**
   * While a resumed chat is replayed: its live chat events and its state wait here, so the
   * renderer gets the earlier conversation first and the composer opens only after it.
   */
  held?: { events: AgentEvent[]; state?: Extract<AgentEvent, { type: 'state' }> }
}

const CHAT_EVENTS: ReadonlySet<AgentEvent['type']> = new Set(['message', 'tool', 'permission', 'permissionCancelled', 'notice', 'exit'])

export interface SessionManagerDeps {
  config: ConfigurationService
  /** Environment variables the session's profile adds (Settings → Profiles); applied before the internal ones. */
  profileEnv?: (profileId: string | null, cwd: string) => Promise<Record<string, string>>
  runtimes: Partial<Record<AgentAdapterKind, AgentRuntime>>
  /** Runs consoles and shells. */
  terminal: AgentRuntime
  transcripts: TranscriptReader[]
  /** Past sessions per agent id (Claude), to replay a resumed session in the app. */
  history: Partial<Record<string, SessionHistorySource>>
  emitEvent: (e: AgentEvent) => void
  emitChanged: (s: SessionView) => void
  /** A finished session left the list (an automation replaced it); the renderer drops it. */
  emitRemoved?: (id: string) => void
  emitReplay: (id: string, messages: HistoryMessage[]) => void
  /** Main rewrote the config by itself (a group place moved to a session's real id): the renderer reloads it. */
  emitConfigChanged?: () => void
  /** How often transcripts are read for the monitor (Workhub 1: every 3 s). */
  pollMs?: number
  /** How long a session stays idle before a pending switch hands it over (Workhub 1: 1.5 s). */
  settleMs?: number
  /** Longest wait for the earlier conversation before a resumed chat opens without it. */
  replayWaitMs?: number
  /** The names the user gave sessions (Rename…), by identity; without it renaming keeps the name for this run only. */
  names?: SessionNameStore
  /** A session reported its models and modes: remembered so the next session can offer them before it starts. */
  onAgentOptions?: (agentId: string, accountId: string | null, options: { models: ModelOption[]; modes: SessionModeOption[] }) => void
}

const SHELL = BUILTIN_AGENTS.find((a) => a.id === 'shell')!

/** Ticket project keys configured on the tracker connections (`projectKeys=ABC,DEF`). */
export function ticketPrefixes(config: WorkhubConfig): string[] {
  return config.connections
    .filter((c) => c.kind === 'tracker')
    .flatMap((c) => (c.settings['projectKeys'] ?? '').split(/[,\s]+/))
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean)
}

/**
 * The agent and account behind an agent key. The active profile's offer comes first; a key the
 * profile does not offer (a history entry of another account) is resolved from the config.
 */
export function resolveChoice(config: WorkhubConfig, profileId: string | null, agentKey: string): EffectiveAgent | null {
  const offered = resolveEffectiveAgents(config, profileId).find((e) => e.key === agentKey)
  if (offered) return offered
  const [agentId, accountId] = agentKey.split(':')
  const agent = knownAgents(config).find((a) => a.id === agentId)
  if (!agent) return null
  const account = accountId ? config.accounts.find((a) => a.id === accountId) : undefined
  if (accountId && !account) return null
  return { key: agentKey, agent, account: account ?? null, label: account ? `${agent.name} - ${account.name}` : agent.name }
}

/**
 * Owns every session of the app: picks the runtime by adapter kind, hands a session between its
 * chat and its console, runs the shell next to it, reads its transcript into the monitor and
 * keeps the session state the renderer shows.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly timer: ReturnType<typeof setInterval>
  private polling = false
  /** The last size each terminal channel reported, so a terminal started later starts at that size. */
  private readonly sizes = new Map<string, { cols: number; rows: number }>()

  constructor(private readonly deps: SessionManagerDeps) {
    const runtimes = new Set([...Object.values(deps.runtimes), deps.terminal])
    for (const runtime of runtimes) runtime?.subscribe((e) => this.onEvent(e))
    this.timer = setInterval(() => void this.pollTranscripts(), deps.pollMs ?? 3000)
    this.timer.unref?.()
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => s.view)
  }

  /** Drops a stopped or failed session from the list. A live one stays: the caller must stop it first. */
  remove(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || (s.view.state !== 'stopped' && s.view.state !== 'error')) return false
    this.sessions.delete(id)
    this.deps.emitRemoved?.(id)
    return true
  }

  /**
   * `internal` is for the main process only (never the renderer's IPC input): extra environment
   * for the agent process, e.g. the AI review's push block.
   */
  async start(input: StartSessionInput, internal: { env?: Record<string, string>; origin?: SessionOrigin } = {}): Promise<SessionView> {
    const config = await this.deps.config.current()
    const choice = resolveChoice(config, input.profileId, input.agentKey)
    if (!choice) throw new Error(`agent "${input.agentKey}" is not offered by this profile`)
    const { account } = choice
    // An account can run another build of the agent (its own command).
    const agent = accountAgent(choice.agent, account)
    const runtime = agent.adapter === 'terminal' ? this.deps.terminal : this.deps.runtimes[agent.adapter]
    if (!runtime) throw new Error(`no runtime for adapter "${agent.adapter}"`)

    const capabilities = runtime.capabilities(agent)
    const modes: SessionMode[] = []
    if (agent.adapter !== 'terminal' && capabilities.appMode) modes.push('app')
    // A read-only reviewer has no console: the agent's own TUI would run with its usual permissions.
    if ((agent.adapter === 'terminal' || agent.console) && !input.readOnly) modes.push('console')
    modes.push('shell')
    const engine: Engine = modes[0] === 'app' && input.mode !== 'console' ? 'app' : 'console'
    // Agents with a console share one session id between chat, console and transcript.
    const agentSessionId = input.resumeAgentSessionId ?? (agent.console || agent.adapter === 'native' ? randomUUID() : undefined)

    // Sidebar groups (and names) key a session by this: the agent's own id when there is one.
    const identity = agentSessionId ?? input.identity ?? randomUUID()
    const name = this.deps.names?.get(identity)
    const view: SessionView = {
      id: randomUUID(),
      identity,
      ...(name ? { name } : {}),
      agentId: agent.id,
      accountId: account?.id ?? null,
      accountName: account?.name,
      profileId: input.profileId,
      cwd: input.cwd,
      state: 'starting',
      agentSessionId,
      permissionMode: null,
      startedAt: Date.now(),
      stateSince: Date.now(),
      label: choice.label,
      agentName: agent.name,
      adapter: agent.adapter,
      capabilities,
      screens: sessionScreens(capabilities),
      modes,
      mode: engine,
      shellRunning: false,
      controls: hasSessionControls(runtime),
      modelControl: canSetModel(runtime),
      modeControl: canSetSessionMode(runtime),
      ...(input.readOnly ? { readOnly: true } : {}),
      ...(internal.origin ? { origin: internal.origin } : {})
    }
    const session: ManagedSession = {
      view,
      agent,
      account,
      env: { ...launchEnvironment(agent, account), ...((await this.deps.profileEnv?.(input.profileId, input.cwd)) ?? {}), ...(internal.env ?? {}) },
      runtime,
      engine,
      switching: false,
      readOnly: input.readOnly === true,
      openPermissions: new Set(),
      console: new ConsoleActivity(),
      consoleStartedAt: 0,
      toolStatus: new Map()
    }
    this.sessions.set(view.id, session)
    this.deps.emitChanged(view)

    const resume = Boolean(input.resumeAgentSessionId)
    // session/new can take 10-15 s: answer now, report progress through `changed` events.
    // What was picked for this session, else the account's defaults (Settings → Agent accounts).
    const model = input.model ?? account?.defaultModel
    const modeId = input.readOnly ? undefined : (input.modeId ?? account?.defaultMode)
    void (engine === 'app' ? this.startChat(session, { resume, model, modeId, cols: input.cols, rows: input.rows }) : this.startConsole(session, input.cols, input.rows)).catch(
      (err: unknown) => this.update(view.id, { state: 'error', error: err instanceof Error ? err.message : String(err) })
    )
    return view
  }

  /** Stops a session (if it still runs) and drops it from the list; its conversation stays in History. */
  async close(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.view.state !== 'stopped' && s.view.state !== 'error') await this.stop(id)
    // A late event may have moved it out of `stopped`; closing wins.
    if (s.view.state !== 'stopped' && s.view.state !== 'error') this.update(id, { state: 'stopped' })
    this.remove(id)
  }

  /** Names a session; empty or null goes back to its agent's name. Kept by identity, so a resumed session keeps it. */
  rename(id: string, name: string | null): void {
    const s = this.require(id)
    const key = s.view.identity ?? s.view.agentSessionId ?? s.view.id
    const stored = this.deps.names ? this.deps.names.set(key, name) : cleanSessionName(name)
    this.update(id, { name: stored })
  }

  async prompt(id: string, text: string, images?: ImageInput[]): Promise<string> {
    const s = this.require(id)
    if (s.engine !== 'app') throw new Error('the session is in its console; type there')
    const usable = s.view.capabilities.imageInput && images?.length ? images : undefined
    return (await s.runtime.prompt(id, text, usable)).stopReason
  }

  async cancel(id: string): Promise<void> {
    const s = this.require(id)
    if (s.engine === 'app') await s.runtime.cancel(id)
    else await this.deps.terminal.cancel(terminalChannel(id, 'console'))
  }

  async stop(id: string): Promise<void> {
    const s = this.require(id)
    this.clearPending(s)
    s.switching = true
    await Promise.all([
      s.engine === 'app' ? s.runtime.stop(id) : this.deps.terminal.stop(terminalChannel(id, 'console')),
      this.deps.terminal.stop(terminalChannel(id, 'shell'))
    ])
    s.switching = false
    this.update(id, { state: 'stopped', shellRunning: false, pendingMode: undefined })
  }

  /**
   * Shows another mode. App and console hand the same agent session over: the running engine
   * stops (Claude ends cleanly) and the other resumes it, as Workhub 1 does. The shell starts once
   * and keeps running beside the agent.
   *
   * Handing over ends the current engine's process, which would cut a turn off. So while a turn
   * runs (or waits on a permission or a question) the other engine is only recorded as
   * `pendingMode` and the hand-over follows the turn's end. `now` forces it (the turn ends);
   * picking the engine that runs drops a pending switch.
   */
  async setMode(id: string, mode: SessionMode, options: SetModeOptions = {}): Promise<void> {
    const s = this.require(id)
    if (!s.view.modes.includes(mode)) throw new Error(`mode ${mode} is not available for this session`)
    if (mode === 'shell') {
      if (!s.view.shellRunning) await this.startShell(s)
      this.update(id, { mode })
      return
    }
    const live = s.view.state !== 'stopped' && s.view.state !== 'error'
    if (mode === s.engine && live) {
      this.clearPending(s)
      this.update(id, { mode, pendingMode: undefined })
      return
    }
    // A hand-over is under way; the switch shows the engine it lands on.
    if (s.switching) return
    if (live && !options.now && this.turnInProgress(s)) {
      s.pending = mode
      // From the shell, back to the view where the turn runs and the notice shows.
      this.update(id, { mode: s.engine, pendingMode: mode })
      return
    }
    this.clearPending(s)
    await this.handOver(s, mode, mode)
  }

  /** Whether handing the conversation to the other engine now would cut a turn off. */
  turnInProgress(s: ManagedSession): boolean {
    if (s.view.state === 'stopped' || s.view.state === 'error') return false
    if (s.engine === 'app') return s.view.state === 'busy' || s.openPermissions.size > 0
    if (s.console.busy) return true
    // A permission prompt titles the terminal with the idle ✳: the transcript tells, through a tool
    // call this console started that has no result yet.
    for (const t of s.toolStatus.values()) {
      if ((t.status === 'pending' || t.status === 'in_progress') && (t.startedAt ?? 0) >= s.consoleStartedAt - 1000) return true
    }
    return false
  }

  /** Ends the current engine and resumes the same agent session in the other one. */
  private async handOver(s: ManagedSession, engine: Engine, show: SessionMode): Promise<void> {
    const id = s.view.id
    const live = s.view.state !== 'stopped' && s.view.state !== 'error'
    s.switching = true
    try {
      if (live) await (s.engine === 'app' ? s.runtime.stop(id) : this.deps.terminal.stop(terminalChannel(id, 'console')))
      s.engine = engine
      s.openPermissions.clear()
      s.console.reset()
      this.update(id, { mode: show, pendingMode: undefined, state: 'starting', error: undefined })
    } finally {
      s.switching = false
    }
    const hasHistory = await this.hasTranscript(s)
    if (engine === 'app') await this.startChat(s, { resume: hasHistory, model: s.view.currentModelId, modeId: s.readOnly ? undefined : s.view.currentModeId })
    else await this.startConsole(s)
  }

  private clearPending(s: ManagedSession): void {
    s.pending = undefined
    if (s.pendingTimer) clearTimeout(s.pendingTimer)
    s.pendingTimer = undefined
  }

  /**
   * Runs a pending switch once the session has been idle for a moment: a short gap between two
   * requests of one turn does not count as its end. In the console the transcript is read first,
   * for a permission prompt the terminal title does not show.
   */
  private checkPending(s: ManagedSession): void {
    if (!s.pending) return
    if (s.view.state === 'stopped' || s.view.state === 'error') {
      this.clearPending(s)
      this.update(s.view.id, { pendingMode: undefined })
      return
    }
    if (this.turnInProgress(s)) {
      if (s.pendingTimer) clearTimeout(s.pendingTimer)
      s.pendingTimer = undefined
      return
    }
    if (s.pendingTimer) return
    s.pendingTimer = setTimeout(() => {
      s.pendingTimer = undefined
      void (async () => {
        if (s.engine === 'console') await this.pollOne(s)
        const target = s.pending
        if (!target || s.switching || this.turnInProgress(s) || !this.sessions.has(s.view.id)) return
        s.pending = undefined
        // Stays in the shell if the user went there meanwhile; the agent changes view underneath.
        await this.handOver(s, target, s.view.mode === 'shell' ? 'shell' : target)
      })().catch((err: unknown) => this.update(s.view.id, { state: 'error', error: err instanceof Error ? err.message : String(err) }))
    }, this.deps.settleMs ?? 1500)
  }

  async setModel(id: string, modelId: string | null): Promise<void> {
    const s = this.require(id)
    if (s.engine !== 'app' || !canSetModel(s.runtime)) throw new Error('this agent cannot switch models')
    await s.runtime.setModel(id, modelId)
    // ACP cannot go back to "the agent's default": the current model stays until another is picked.
    if (modelId || s.agent.adapter !== 'acp') this.update(id, { currentModelId: modelId ?? undefined, modelIgnored: undefined })
  }

  /** Switches the session's mode: the agent or persona (Kiro, OpenCode) or the approval preset (Codex). */
  async setAgentMode(id: string, modeId: string): Promise<void> {
    const s = this.require(id)
    if (s.engine !== 'app' || !canSetSessionMode(s.runtime)) throw new Error('this agent cannot switch modes')
    // A reviewer stays in its read-only mode.
    if (s.readOnly) throw new Error('a review session keeps its read-only mode')
    if (!(s.view.availableModes ?? []).some((m) => m.id === modeId)) throw new Error(`mode "${modeId}" is not offered by this session`)
    await s.runtime.setSessionMode(id, modeId)
    this.update(id, { currentModeId: modeId, modeIgnored: undefined })
  }

  mcp(id: string, action: 'refresh' | 'reconnect' | 'enable' | 'disable', server?: string): void {
    const s = this.sessions.get(id)
    if (!s || s.engine !== 'app' || !hasSessionControls(s.runtime)) return
    if (action === 'refresh') s.runtime.refreshMcp(id)
    else if (server && action === 'reconnect') s.runtime.reconnectMcp(id, server)
    else if (server) s.runtime.toggleMcp(id, server, action === 'enable')
  }

  /** One subagent's conversation, read from the session's transcript; null when there is none. */
  async subagent(id: string, subagentId: string): Promise<SubagentConversation | null> {
    const s = this.sessions.get(id)
    const reader = s && this.reader(s)
    if (!s || !reader?.subagent || !s.view.agentSessionId || typeof subagentId !== 'string') return null
    return reader.subagent({ agentSessionId: s.view.agentSessionId, cwd: s.view.cwd, configDir: s.account?.configDir }, subagentId).catch(() => null)
  }

  /** A file the session's agent named, when it lies inside the session's folder (to reveal it). */
  fileInSession(id: string, path: string): string | null {
    const s = this.sessions.get(id)
    return s ? pathInsideFolder(s.view.cwd, path) : null
  }

  respondPermission(id: string, requestId: string, optionId: string | null): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.runtime.respondPermission(id, requestId, optionId)
    s.openPermissions.delete(requestId)
    this.checkPending(s)
  }

  /** Raw input for a session's terminal channel (`<id>:console` or `<id>:shell`). */
  write(channelId: string, data: string): void {
    if (isTerminalControl(this.deps.terminal)) this.deps.terminal.write(channelId, data)
    const [id, channel] = channelId.split(':')
    const s = channel === 'console' ? this.sessions.get(id!) : undefined
    if (s) {
      // Typing in the console answers whatever it asked.
      s.console.typed()
      this.checkPending(s)
    }
  }

  /** Remembered per channel too: a terminal that starts later (a hand-over) starts at this size. */
  resize(channelId: string, cols: number, rows: number): void {
    if (!(cols > 0 && rows > 0)) return
    this.sizes.set(channelId, { cols, rows })
    if (isTerminalControl(this.deps.terminal)) this.deps.terminal.resize(channelId, cols, rows)
  }

  async stopAll(): Promise<void> {
    clearInterval(this.timer)
    for (const s of this.sessions.values()) this.clearPending(s)
    for (const s of this.sessions.values()) s.switching = true
    const runtimes = new Set([...Object.values(this.deps.runtimes), this.deps.terminal])
    await Promise.all([...runtimes].map((r) => r?.stopAll()))
  }

  private async startApp(s: ManagedSession, opts: { resume: boolean; model?: string; modeId?: string; cols?: number; rows?: number }): Promise<void> {
    const started = await s.runtime.start({
      sessionId: s.view.id,
      agent: s.agent,
      account: s.account,
      cwd: s.view.cwd,
      env: s.env,
      agentSessionId: s.view.agentSessionId,
      resume: opts.resume,
      model: opts.model,
      ...(opts.modeId ? { modeId: opts.modeId } : {}),
      cols: opts.cols,
      rows: opts.rows,
      ...(s.readOnly ? { readOnly: true } : {})
    })
    const patch: Partial<SessionView> = { agentSessionId: started.agentSessionId ?? s.view.agentSessionId, agentName: started.agentName }
    // An agent that only reports its session id now (ACP) gives the session its real identity; the
    // group place it may have been given under the provisional one moves with it.
    if (patch.agentSessionId && patch.agentSessionId !== s.view.identity) {
      const previous = s.view.identity
      patch.identity = patch.agentSessionId
      if (previous) this.deps.names?.move(previous, patch.agentSessionId)
      if (previous) {
        try {
          const moved = await this.deps.config.replaceSessionIdentity(previous, patch.agentSessionId)
          if (moved?.ok) this.deps.emitConfigChanged?.()
        } catch {
          // The groups are a convenience; the session still starts.
        }
      }
    }
    if (started.permissionMode) patch.permissionMode = started.permissionMode
    if (started.currentModeId) patch.currentModeId = started.currentModeId
    if (started.availableModes) patch.availableModes = started.availableModes
    // The model asked for is the current one until the agent reports otherwise; an agent that cannot
    // pick one says so, and the session keeps its own default.
    if (started.models?.length) patch.models = started.models
    if (started.modelIgnored) {
      patch.modelIgnored = true
      if (started.currentModelId) patch.currentModelId = started.currentModelId
    } else if (opts.model) patch.currentModelId = opts.model
    else if (started.currentModelId) patch.currentModelId = started.currentModelId
    if (started.modeIgnored) patch.modeIgnored = true
    // The agent's own word on images (ACP) wins over its definition.
    if (started.imageInput !== undefined) patch.capabilities = { ...s.view.capabilities, imageInput: started.imageInput }
    this.update(s.view.id, patch)
    if (started.models?.length || started.availableModes?.length) {
      this.deps.onAgentOptions?.(s.agent.id, s.account?.id ?? null, { models: started.models ?? [], modes: started.availableModes ?? [] })
    }
  }

  private async startConsole(s: ManagedSession, cols?: number, rows?: number): Promise<void> {
    const launch =
      s.agent.adapter === 'terminal'
        ? { command: s.agent.command, args: s.agent.args }
        : consoleCommand(s.agent.console!, s.view.agentSessionId, await this.hasTranscript(s))
    const agent: AgentDefinition = { ...s.agent, adapter: 'terminal', command: launch.command, args: launch.args }
    const channel = terminalChannel(s.view.id, 'console')
    const size = this.sizes.get(channel)
    s.console.reset()
    s.consoleStartedAt = Date.now()
    const started = await this.deps.terminal.start({
      sessionId: channel,
      agent,
      account: s.account,
      cwd: s.view.cwd,
      env: s.env,
      cols: size?.cols ?? cols ?? 100,
      rows: size?.rows ?? rows ?? 30
    })
    // The console does not report a permission mode; keep the one the chat last showed.
    if (!s.view.permissionMode) this.update(s.view.id, { permissionMode: started.permissionMode })
  }

  private async startShell(s: ManagedSession): Promise<void> {
    const channel = terminalChannel(s.view.id, 'shell')
    const size = this.sizes.get(channel) ?? this.sizes.get(terminalChannel(s.view.id, 'console'))
    await this.deps.terminal.start({ sessionId: channel, agent: SHELL, account: null, cwd: s.view.cwd, env: s.env, cols: size?.cols ?? 100, rows: size?.rows ?? 30 })
    this.update(s.view.id, { shellRunning: true })
  }

  private async hasTranscript(s: ManagedSession): Promise<boolean> {
    const reader = this.reader(s)
    if (!reader || !s.view.agentSessionId) return false
    return reader.exists({ agentSessionId: s.view.agentSessionId, cwd: s.view.cwd, configDir: s.account?.configDir })
  }

  private reader(s: ManagedSession): TranscriptReader | undefined {
    return s.agent.transcript ? this.deps.transcripts.find((r) => r.id === s.agent.transcript) : undefined
  }

  /**
   * Starts the chat; a resumed one shows its whole conversation first. The SDK resumes a session
   * without replaying it, so the stored messages are read (in parallel with the start) and sent
   * before any live event of the new chat, and the chat turns ready only after them: the
   * renderer replaces what it showed with the full conversation, the console's turns included.
   */
  private async startChat(s: ManagedSession, opts: { resume: boolean; model?: string; modeId?: string; cols?: number; rows?: number }): Promise<void> {
    const source = this.deps.history[s.agent.accountsOf ?? s.agent.id]
    if (!opts.resume || !source || !s.view.agentSessionId) return this.startApp(s, opts)
    const held: NonNullable<ManagedSession['held']> = { events: [] }
    s.held = held
    const release = () => {
      if (s.held !== held) return
      s.held = undefined
      if (held.state) this.onEvent(held.state)
      for (const e of held.events) this.deps.emitEvent(e)
    }
    const agentSessionId = s.view.agentSessionId
    let timer: ReturnType<typeof setTimeout> | undefined
    const replayed = Promise.race([
      this.readHistory(source, agentSessionId, s).then((messages) => {
        if (s.held === held && messages.length) this.deps.emitReplay(s.view.id, messages)
      }),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, this.deps.replayWaitMs ?? 10_000)))
    ]).finally(() => {
      clearTimeout(timer)
      release()
    })
    try {
      await this.startApp(s, opts)
    } finally {
      await replayed
    }
  }

  private async readHistory(source: SessionHistorySource, agentSessionId: string, s: ManagedSession): Promise<HistoryMessage[]> {
    try {
      return await source.messages(agentSessionId, s.view.cwd, s.account?.configDir)
    } catch {
      // A conversation that cannot be read back still resumes; only the earlier messages are missing.
      return []
    }
  }

  /** Reads what each session's transcript added since the last poll; the result is a monitor update. */
  private async pollTranscripts(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const prefixes = ticketPrefixes(await this.deps.config.current())
      for (const s of this.sessions.values()) await this.pollOne(s, prefixes)
    } finally {
      this.polling = false
    }
  }

  private async pollOne(s: ManagedSession, prefixes?: string[]): Promise<void> {
    const reader = this.reader(s)
    if (!reader || !s.view.agentSessionId) return
    const ticketPrefixesNow = prefixes ?? ticketPrefixes(await this.deps.config.current())
    const snapshot = await reader
      .read({ agentSessionId: s.view.agentSessionId, cwd: s.view.cwd, configDir: s.account?.configDir, ticketPrefixes: ticketPrefixesNow })
      .catch(() => null)
    const key = snapshot && JSON.stringify(snapshot)
    if (!snapshot || key === s.lastMonitor) return
    s.lastMonitor = key ?? undefined
    for (const t of snapshot.toolCalls ?? []) s.toolStatus.set(t.id, { status: t.status, startedAt: t.startedAt })
    this.deps.emitEvent({ sessionId: s.view.id, type: 'monitor', snapshot })
    this.checkPending(s)
  }

  /** Runtime events carry the runtime's session id: the session's own for the app engine, `<id>:<channel>` for terminals. */
  private onEvent(e: AgentEvent): void {
    const [id, channel] = e.sessionId.split(':') as [string, 'console' | 'shell' | undefined]
    const s = this.sessions.get(id)
    // A resumed chat's own events wait for its earlier conversation (see startChat).
    if (s?.held && !channel && s.engine === 'app' && !s.switching) {
      if (e.type === 'state') {
        s.held.state = e
        return
      }
      if (CHAT_EVENTS.has(e.type)) {
        this.track(s, e)
        s.held.events.push(e)
        return
      }
    }
    if (s && e.type === 'state') {
      if (channel === 'shell') {
        if (e.state === 'stopped' || e.state === 'error') this.update(id, { shellRunning: false, ...(s.view.mode === 'shell' ? { mode: s.engine } : {}) })
      } else if ((channel === 'console') === (s.engine === 'console') && !s.switching) {
        this.update(id, { state: e.state, ...(e.error ? { error: e.error } : {}) })
      }
    }
    if (s && !channel) {
      if (e.type === 'permissionMode') this.update(id, { permissionMode: e.mode, currentModeId: e.currentModeId })
      if (e.type === 'models') {
        this.update(id, { models: e.models, ...(e.currentModelId ? { currentModelId: e.currentModelId } : {}) })
        if (e.models.length) this.deps.onAgentOptions?.(s.agent.id, s.account?.id ?? null, { models: e.models, modes: s.view.availableModes ?? [] })
      }
    }
    if (s) this.track(s, e, channel)
    this.deps.emitEvent(e)
    if (s) this.checkPending(s)
  }

  /** Keeps what decides whether a turn is in progress: open permission requests, the console's title. */
  private track(s: ManagedSession, e: AgentEvent, channel?: 'console' | 'shell'): void {
    if (!channel && s.engine === 'app') {
      if (e.type === 'permission') s.openPermissions.add(e.requestId)
      else if (e.type === 'permissionCancelled') s.openPermissions.delete(e.requestId)
      else if (e.type === 'state' && e.state !== 'busy') s.openPermissions.clear()
    } else if (channel === 'console' && s.engine === 'console' && e.type === 'output') {
      s.console.feed(e.data)
    }
  }

  private update(id: string, patch: Partial<SessionView>): void {
    const s = this.sessions.get(id)
    if (!s) return
    // A finished session keeps its final state even if a late event arrives.
    if ((s.view.state === 'stopped' || s.view.state === 'error') && patch.state && patch.state !== s.view.state) {
      if (patch.state !== 'stopped' && patch.state !== 'error' && patch.state !== 'starting') return
    }
    // When the state began, for the header's "Working 1:23" / "Idle 2 min".
    const since = patch.state && patch.state !== s.view.state ? { stateSince: Date.now() } : {}
    s.view = { ...s.view, ...patch, ...since }
    this.deps.emitChanged(s.view)
  }

  /** The session's folder, for reads main does on its behalf (local changes). */
  cwdOf(id: string): string | null {
    return this.sessions.get(id)?.view.cwd ?? null
  }

  private require(id: string): ManagedSession {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session ${id}`)
    return s
  }
}
