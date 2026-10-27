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
  type SessionModeOption,
  type TranscriptReader,
  type WorkhubConfig
} from '@workhub/core'
import { terminalChannel, type SessionMode, type SessionView, type StartSessionInput } from '../shared/api'

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
}

export interface SessionManagerDeps {
  config: ConfigurationService
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
  async start(input: StartSessionInput, internal: { env?: Record<string, string> } = {}): Promise<SessionView> {
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

    const view: SessionView = {
      id: randomUUID(),
      // Sidebar groups key a session by this: the agent's own id when there is one.
      identity: agentSessionId ?? input.identity ?? randomUUID(),
      agentId: agent.id,
      accountId: account?.id ?? null,
      accountName: account?.name,
      profileId: input.profileId,
      cwd: input.cwd,
      state: 'starting',
      agentSessionId,
      permissionMode: null,
      startedAt: Date.now(),
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
      ...(input.readOnly ? { readOnly: true } : {})
    }
    const session: ManagedSession = { view, agent, account, env: { ...launchEnvironment(agent, account), ...(internal.env ?? {}) }, runtime, engine, switching: false, readOnly: input.readOnly === true }
    this.sessions.set(view.id, session)
    this.deps.emitChanged(view)

    const resume = Boolean(input.resumeAgentSessionId)
    // session/new can take 10-15 s: answer now, report progress through `changed` events.
    // What was picked for this session, else the account's defaults (Settings → Agent accounts).
    const model = input.model ?? account?.defaultModel
    const modeId = input.readOnly ? undefined : (input.modeId ?? account?.defaultMode)
    void (engine === 'app' ? this.startApp(session, { resume, model, modeId, cols: input.cols, rows: input.rows }) : this.startConsole(session, input.cols, input.rows))
      .then(() => {
        if (resume && engine === 'app') void this.replay(session)
      })
      .catch((err: unknown) => this.update(view.id, { state: 'error', error: err instanceof Error ? err.message : String(err) }))
    return view
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
    s.switching = true
    await Promise.all([
      s.engine === 'app' ? s.runtime.stop(id) : this.deps.terminal.stop(terminalChannel(id, 'console')),
      this.deps.terminal.stop(terminalChannel(id, 'shell'))
    ])
    s.switching = false
    this.update(id, { state: 'stopped', shellRunning: false })
  }

  /**
   * Shows another mode. App and console hand the same agent session over: the running engine
   * stops (Claude ends cleanly) and the other resumes it, as Workhub 1 does. The shell starts once
   * and keeps running beside the agent.
   */
  async setMode(id: string, mode: SessionMode): Promise<void> {
    const s = this.require(id)
    if (!s.view.modes.includes(mode)) throw new Error(`mode ${mode} is not available for this session`)
    if (mode === 'shell') {
      if (!s.view.shellRunning) await this.startShell(s)
      this.update(id, { mode })
      return
    }
    const live = s.view.state !== 'stopped' && s.view.state !== 'error'
    if (mode === s.engine && live) {
      this.update(id, { mode })
      return
    }
    s.switching = true
    try {
      if (live) await (s.engine === 'app' ? s.runtime.stop(id) : this.deps.terminal.stop(terminalChannel(id, 'console')))
      s.engine = mode
      this.update(id, { mode, state: 'starting', error: undefined })
    } finally {
      s.switching = false
    }
    const hasHistory = await this.hasTranscript(s)
    if (mode === 'app') await this.startApp(s, { resume: hasHistory, model: s.view.currentModelId, modeId: s.readOnly ? undefined : s.view.currentModeId })
    else await this.startConsole(s)
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

  respondPermission(id: string, requestId: string, optionId: string | null): void {
    this.sessions.get(id)?.runtime.respondPermission(id, requestId, optionId)
  }

  /** Raw input for a session's terminal channel (`<id>:console` or `<id>:shell`). */
  write(channelId: string, data: string): void {
    if (isTerminalControl(this.deps.terminal)) this.deps.terminal.write(channelId, data)
  }

  resize(channelId: string, cols: number, rows: number): void {
    if (isTerminalControl(this.deps.terminal)) this.deps.terminal.resize(channelId, cols, rows)
  }

  async stopAll(): Promise<void> {
    clearInterval(this.timer)
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
    const started = await this.deps.terminal.start({
      sessionId: terminalChannel(s.view.id, 'console'),
      agent,
      account: s.account,
      cwd: s.view.cwd,
      env: s.env,
      cols: cols ?? 100,
      rows: rows ?? 30
    })
    // The console does not report a permission mode; keep the one the chat last showed.
    if (!s.view.permissionMode) this.update(s.view.id, { permissionMode: started.permissionMode })
  }

  private async startShell(s: ManagedSession): Promise<void> {
    await this.deps.terminal.start({ sessionId: terminalChannel(s.view.id, 'shell'), agent: SHELL, account: null, cwd: s.view.cwd, env: s.env, cols: 100, rows: 30 })
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

  private async replay(s: ManagedSession): Promise<void> {
    const source = this.deps.history[s.agent.accountsOf ?? s.agent.id]
    if (!source || !s.view.agentSessionId) return
    try {
      const messages = await source.messages(s.view.agentSessionId, s.view.cwd, s.account?.configDir)
      if (messages.length) this.deps.emitReplay(s.view.id, messages)
    } catch {
      // A conversation that cannot be read back still resumes; only the earlier messages are missing.
    }
  }

  /** Reads what each session's transcript added since the last poll; the result is a monitor update. */
  private async pollTranscripts(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const config = await this.deps.config.current()
      const prefixes = ticketPrefixes(config)
      for (const s of this.sessions.values()) {
        const reader = this.reader(s)
        if (!reader || !s.view.agentSessionId) continue
        const snapshot = await reader
          .read({ agentSessionId: s.view.agentSessionId, cwd: s.view.cwd, configDir: s.account?.configDir, ticketPrefixes: prefixes })
          .catch(() => null)
        const key = snapshot && JSON.stringify(snapshot)
        if (!snapshot || key === s.lastMonitor) continue
        s.lastMonitor = key ?? undefined
        this.deps.emitEvent({ sessionId: s.view.id, type: 'monitor', snapshot })
      }
    } finally {
      this.polling = false
    }
  }

  /** Runtime events carry the runtime's session id: the session's own for the app engine, `<id>:<channel>` for terminals. */
  private onEvent(e: AgentEvent): void {
    const [id, channel] = e.sessionId.split(':') as [string, 'console' | 'shell' | undefined]
    const s = this.sessions.get(id)
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
    this.deps.emitEvent(e)
  }

  private update(id: string, patch: Partial<SessionView>): void {
    const s = this.sessions.get(id)
    if (!s) return
    // A finished session keeps its final state even if a late event arrives.
    if ((s.view.state === 'stopped' || s.view.state === 'error') && patch.state && patch.state !== s.view.state) {
      if (patch.state !== 'stopped' && patch.state !== 'error' && patch.state !== 'starting') return
    }
    s.view = { ...s.view, ...patch }
    this.deps.emitChanged(s.view)
  }

  private require(id: string): ManagedSession {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session ${id}`)
    return s
  }
}
