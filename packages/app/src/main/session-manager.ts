import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, isAbsolute } from 'node:path'
import {
  ActiveClock,
  accountAgent,
  appOptions,
  BUILTIN_AGENTS,
  canSetModel,
  canSetSessionMode,
  containingFolder,
  consoleCommand,
  defaultStartMode,
  hasSessionControls,
  isTerminalControl,
  knownAgents,
  owningProfile,
  launchEnvironment,
  resolveEffectiveAgents,
  sessionScreens,
  worktreeBranch,
  worktreeFolderName,
  worktreeSettings,
  worktreeSetupCommand,
  worktreesLocation,
  type AgentAccount,
  type McpServerLaunch,
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
  type SessionWorktree,
  type Worktrees,
  type WorktreeStatus,
  type SubagentConversation,
  type TranscriptReader,
  type WorkhubConfig,
  redactText
} from '@workhub/core'
import { terminalChannel, type PendingPermission, type SessionMode, type SessionView, type SetModeOptions, type StartSessionInput } from '../shared/api'
import { JOURNAL_MAX_ENTRIES } from './chat-journal'
import { ConsoleActivity } from './console-activity'
import { NO_CONTROL_ENV } from './control-server'
import { pathInsideFolder } from './reveal'
import { elsewhere, hostLabel, type HostControlInfo, type HostTarget } from './hosts'
import { SendGate } from './send-gate'
import { StallWatch } from './stall-watch'
import { translate, type MessageKey } from '../renderer/i18n/translate'
import { bootstrapWorktree, type SetupRunner } from './worktree-bootstrap'
import { cleanSessionName, type SessionNameStore } from './session-names'

/** What runs the session right now: the agent's runtime (app) or the agent's own TUI in a PTY (console). */
type Engine = 'app' | 'console'

/**
 * The `--mcp-config` JSON of a console (Claude Code's format), or undefined for none. Not on
 * Windows: ConPTY joins the args into one command line, where the JSON's quotes do not survive.
 */
export function consoleMcpConfig(servers: readonly McpServerLaunch[], platform: NodeJS.Platform = process.platform): string | undefined {
  if (!servers.length || platform === 'win32') return undefined
  return JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, { type: 'stdio', command: s.command, args: s.args, env: s.env }])) })
}

/** How many answered request ids the view remembers (enough for a burst of questions). */
const ANSWERED_PERMISSIONS_KEPT = 20
/** The head of a request's detail kept on the view (the event carries it whole). */
const PENDING_DETAIL_CHARS = 2000
/** Input xterm sends by itself (focus in/out, cursor position and device attribute replies), not the user typing. */
const isTerminalReply = (data: string): boolean => data.length > 0 && data.replace(/\x1b\[(?:I|O|\d+;\d+R|\?\d+(?:;\d+)*c)/g, '') === ''

interface ManagedSession {
  view: SessionView
  agent: AgentDefinition
  account: AgentAccount | null
  env: Record<string, string>
  /** MCP servers Workhub hands the session (its own, when it is on); empty for a reviewer. */
  mcp: McpServerLaunch[]
  /** The services of the host the session runs on, picked when it started. */
  services: SessionServices
  runtime: AgentRuntime
  engine: Engine
  /** Set while the session hands over from one engine to the other. */
  switching: boolean
  /** Working time from the session's own state changes, used while the agent reports none. */
  clock: ActiveClock
  /** The agent (or its transcript) reported its own working time: the derived one is dropped. */
  reportsActiveTime: boolean
  /** The last transcript snapshot sent, to skip polls that found nothing new. */
  lastMonitor?: string
  /** The transcript was read once after the session stopped; polling skips it until it starts again. */
  finalRead?: boolean
  /** The folders the transcript says the session worked in, most recent last; unset until one says so. */
  workPaths?: string[]
  /** The folders among `workPaths` the session changed something in. */
  changePaths?: string[]
  /** An AI reviewer: started in the agent's most read-only mode, chat only. */
  readOnly: boolean
  /** The engine picked while a turn ran: the hand-over waits for the turn to end (Workhub 1's `pendingEngine`). */
  pending?: Engine
  pendingTimer?: ReturnType<typeof setTimeout>
  /** Permission requests of the app engine not answered yet (the turn waits on the user), by request id, oldest first. */
  openPermissions: Map<string, PendingPermission>
  /** The last requests answered through `respondPermission`, so the view can say which ones left answered (vs withdrawn). */
  answeredPermissions: string[]
  /** The reasoning effort the session started with, kept across a view switch. */
  effort?: string
  /** What the console's terminal UI shows: a spinner while a turn runs, a notification when it asks. */
  console: ConsoleActivity
  /** When the console engine last started, so a tool call cut off by an earlier process never holds a switch. */
  consoleStartedAt: number
  /** Tool calls the transcript reports for this session, with their last status. */
  toolStatus: Map<string, { status?: string; startedAt?: number }>
  /** Brought back at launch without its process; the session that starts it replaces it in the list. */
  dormant?: boolean
  /**
   * The host a restored session waits for (`wsl:<distro>`), until it connects: its services, runtime,
   * environment and MCP servers are this computer's placeholders meanwhile, so nothing may start.
   */
  awaitingHost?: string
  /** The variables the caller added at start (`internal.env`), kept for an environment built again. */
  extraEnv?: Record<string, string>
  /**
   * While a resumed chat is replayed: its live chat events and its state wait here, so the
   * renderer gets the earlier conversation first and the composer opens only after it.
   */
  held?: { events: AgentEvent[]; state?: Extract<AgentEvent, { type: 'state' }> }
}

/** How often the watchdog looks for working sessions that went silent. */
const STALL_CHECK_MS = 15_000

const CHAT_EVENTS: ReadonlySet<AgentEvent['type']> = new Set(['message', 'tool', 'permission', 'permissionCancelled', 'notice', 'exit'])

/** What a session runs on: the agent runtimes, transcript readers and past sessions of its host. */
export interface SessionServices {
  runtimes: Partial<Record<AgentAdapterKind, AgentRuntime>>
  /** Runs consoles and shells. */
  terminal: AgentRuntime
  transcripts: TranscriptReader[]
  /** Past sessions per agent id (Claude), to replay a resumed session in the app. */
  history: Partial<Record<string, SessionHistorySource>>
  /** Whether a path exists where the host's folders live; this computer's disk when not given. */
  exists?: (path: string) => Promise<boolean>
  /** How sessions here reach Workhub (`SessionHost.control`): undefined for main's own endpoint, null for none. */
  control?: HostControlInfo | null
  /** The id of the host (`wsl:<distro>`); undefined or `local` for this computer. */
  hostId?: string
  /** The home folder on the host (`~` there), when it is known; this computer's is used for local sessions. */
  home?: string
}

/** The services of a host the session's profile names that has not connected yet. */
export interface PendingServices {
  hostId: string
  /** The host's services once it connects; rejects with the reason it is not available. */
  ready: Promise<SessionServices>
}

const isPending = (x: SessionServices | PendingServices): x is PendingServices => 'ready' in x

/** Whether these services are another system's (a WSL distribution), not this computer's. */
const onHost = (services: SessionServices): boolean => elsewhere(services.hostId)

export interface SessionManagerDeps extends SessionServices {
  /** How often the stuck-session check runs (tests shorten it). */
  stallCheckMs?: number
  config: ConfigurationService
  /** Environment variables the session's profile adds (Settings → Profiles); applied before the internal ones. */
  /**
   * The profile's variables. `hostHome` is what `~` means for a session on another host: its home,
   * or null when it is not known (`~` is then left for the host to resolve); undefined on this computer.
   */
  profileEnv?: (profileId: string | null, cwd: string, hostHome?: string | null) => Promise<Record<string, string>>
  /** Environment variables the session's agent account adds, read from the secret store (Settings → Agents and accounts). */
  accountEnv?: (account: AgentAccount) => Promise<Record<string, string>>
  /**
   * Environment Workhub itself gives a session (its id and the control endpoint). Reviewers, and
   * every session when this is not set, get `NO_CONTROL_ENV`: the variables set to empty strings,
   * so an agent never reaches an endpoint through values inherited from a parent process.
   */
  sessionEnv?: (sessionId: string, control: HostControlInfo | null | undefined) => Record<string, string>
  /** MCP servers a session gets on top of the agent's own (Workhub's), from its environment and its host. Never for a reviewer. */
  sessionMcp?: (env: Record<string, string>, agent: AgentDefinition, control: HostControlInfo | null | undefined) => Promise<McpServerLaunch[]>
  /**
   * The services of the host a session of this profile runs on, asked once per start. Without it
   * every session runs on the services given here (`runtimes`, `terminal`, `transcripts`, `history`).
   * A host the profile names that has not connected yet is pending: a new session waits for it, a
   * restored one is listed stopped under that host until it connects (never run on this computer).
   */
  hostFor?: (target: HostTarget) => SessionServices | PendingServices
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
  /** Most messages a resume replays (the chat journal keeps no more): the conversation's last ones. */
  replayLast?: number
  /** The names the user gave sessions (Rename…), by identity; without it renaming keeps the name for this run only. */
  names?: SessionNameStore
  /** A session reported its models and modes: remembered so the next session can offer them before it starts. */
  onAgentOptions?: (agentId: string, accountId: string | null, options: { models: ModelOption[]; modes: SessionModeOption[] }) => void
  /** Creates and removes the worktrees of sessions that ask for one; without it they start in the folder. */
  worktrees?: Worktrees
  /** Words a session notice in the user's language (the renderer's dictionaries); English without it. */
  text?: (key: string, params?: Record<string, string | number>) => string
  /** Runs the setup command of a new worktree; tests pass a fake. */
  setupRunner?: SetupRunner
  /** The main log: a session that failed to start or ended on its own, with the agent's last stderr lines (never prompt text). */
  log?: (message: string) => void
}

/** Where a new session runs; `created` when its worktree was made for it just now (it gets bootstrapped). */
interface PlacedSession {
  cwd: string
  worktree?: SessionWorktree
  created?: { setupCommand?: string }
}

/** What closing a session with its worktree did: `blocked` when the worktree has work removing it would lose (nothing was closed). */
export type CloseWorktreeResult = { ok: true } | { ok: false; blocked: WorktreeStatus }

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
  return { key: agentKey, agent, account: account ?? null, label: account ? `${agent.name} · ${account.name}` : agent.name }
}

/**
 * Owns every session of the app: picks the runtime by adapter kind, hands a session between its
 * chat and its console, runs the shell next to it, reads its transcript into the monitor and
 * keeps the session state the renderer shows.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>()
  /** One prompt in flight per session, whoever sends it (see `prompt`). */
  private readonly sends = new SendGate()
  private readonly timer: ReturnType<typeof setInterval>
  /** Notices a working session whose agent went silent (see `checkStalls`). */
  private readonly stalls = new StallWatch()
  private readonly stallTimer: ReturnType<typeof setInterval>
  private polling = false
  /** The last size each terminal channel reported, so a terminal started later starts at that size. */
  private readonly sizes = new Map<string, { cols: number; rows: number }>()
  /** The services given in the deps: every session's, unless `hostFor` picks others. */
  private readonly local: SessionServices
  /** Every runtime whose events reach `onEvent`, of whatever host; each is subscribed once. */
  private readonly subscribed = new Set<AgentRuntime>()

  constructor(private readonly deps: SessionManagerDeps) {
    this.local = { runtimes: deps.runtimes, terminal: deps.terminal, transcripts: deps.transcripts, history: deps.history, ...(deps.exists ? { exists: deps.exists } : {}) }
    this.watch(this.local)
    this.timer = setInterval(() => void this.pollTranscripts(), deps.pollMs ?? 3000)
    this.timer.unref?.()
    this.stallTimer = setInterval(() => void this.checkStalls().catch(() => undefined), deps.stallCheckMs ?? STALL_CHECK_MS)
    this.stallTimer.unref?.()
  }

  /** Subscribes to the runtimes of a host's services not heard from yet. */
  private watch(services: SessionServices): void {
    for (const runtime of [...Object.values(services.runtimes), services.terminal]) {
      if (!runtime || this.subscribed.has(runtime)) continue
      this.subscribed.add(runtime)
      runtime.subscribe((e) => this.onEvent(e))
    }
  }

  /** The services a session of this profile runs on, or the host it waits for. */
  private servicesFor(profileId: string | null): SessionServices | PendingServices {
    const services = this.deps.hostFor?.({ profileId }) ?? this.local
    if (!isPending(services)) this.watch(services)
    return services
  }

  /**
   * A restored session listed stopped while its host connects: once the host is there it is bound
   * to it (and `then` starts it, for "start sessions at launch"); when the host fails it shows the
   * reason. Nothing happens to a session opened or closed meanwhile (its start waited by itself).
   */
  private bindWhenReady(id: string, pending: PendingServices, then?: () => Promise<unknown>): void {
    const waiting = () => {
      const s = this.sessions.get(id)
      return s?.dormant && s.view.state === 'stopped' ? s : undefined
    }
    const fail = (err: unknown) => {
      if (!waiting()) return
      const error = err instanceof Error ? err.message : String(err)
      this.deps.log?.(`session ${id}: ${error}`)
      this.update(id, { state: 'error', error })
    }
    pending.ready.then(async (services) => {
      if (!waiting()) return
      // Its environment and MCP servers were built for this computer's endpoint: built again for the host's.
      const s0 = this.sessions.get(id)!
      const { env, mcp } = await this.environment(id, s0.agent, s0.account, { profileId: s0.view.profileId ?? null, cwd: s0.view.cwd, readOnly: s0.readOnly }, services, s0.extraEnv)
      const s = waiting()
      if (!s) return
      this.watch(services)
      s.services = services
      s.runtime = (s.agent.adapter === 'terminal' ? services.terminal : services.runtimes[s.agent.adapter]) ?? s.runtime
      s.env = env
      s.mcp = mcp
      s.awaitingHost = undefined
      if (then) void then().catch(fail)
    }, fail).catch(fail)
  }

  /** The terminal runtime behind a channel (`<id>:console` or `<id>:shell`): its session's host's. */
  private terminalOf(channelId: string): AgentRuntime {
    return this.sessions.get(channelId.split(':')[0]!)?.services.terminal ?? this.local.terminal
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => s.view)
  }

  /** Drops a stopped or failed session from the list. A live one stays: the caller must stop it first. */
  remove(id: string): boolean {
    return this.drop(id, true)
  }

  private drop(id: string, stopTerminals: boolean): boolean {
    const s = this.sessions.get(id)
    if (!s || (s.view.state !== 'stopped' && s.view.state !== 'error')) return false
    this.sessions.delete(id)
    this.stalls.forget(id)
    this.sends.withdraw(id)
    // The agent may have exited on its own, which `stop()` never saw: its Shell and console
    // terminals would keep running with no session left to show them.
    if (stopTerminals) this.stopTerminals(s)
    const reader = this.reader(s)
    if (reader && s.view.agentSessionId) reader.forget(s.view.agentSessionId)
    this.deps.emitRemoved?.(id)
    return true
  }

  /** Stops the session's shell and console terminal channels, whatever its state (best effort). */
  private stopTerminals(s: ManagedSession): void {
    for (const channel of ['shell', 'console'] as const) {
      void (async () => s.services.terminal.stop(terminalChannel(s.view.id, channel)))().catch(() => undefined)
    }
  }

  /**
   * `internal` is for the main process only (never the renderer's IPC input): extra environment
   * for the agent process, e.g. the AI review's push block.
   *
   * Resuming a conversation a live session already runs returns that session instead of starting
   * a second process on the same agent session id; `internal.handOver` is for a caller that
   * deliberately starts it again (it has stopped, or is stopping, the other one itself).
   */
  async start(
    asked: StartSessionInput,
    internal: { env?: Record<string, string>; origin?: SessionOrigin; restored?: boolean; worktree?: SessionWorktree; handOver?: boolean; dormant?: boolean; title?: string } = {}
  ): Promise<SessionView> {
    const running = internal.handOver ? undefined : this.liveWith(asked.resumeAgentSessionId ?? asked.identity)
    if (running) return running.view
    const config = await this.deps.config.current()
    // A session belongs to the profile that owns its folder (its AI review, links and environment
    // follow it), whatever profile was active when it was opened, as long as that profile offers the agent.
    // Decided on the folder asked for, so a worktree placed outside the profile's folders stays in it.
    const owner = asked.readOnly ? undefined : owningProfile(asked.cwd, config.profiles, homedir())
    const owned: StartSessionInput = owner && owner.id !== asked.profileId && resolveChoice(config, owner.id, asked.agentKey) ? { ...asked, profileId: owner.id } : asked
    const choice = resolveChoice(config, owned.profileId, owned.agentKey)
    if (!choice) throw new Error(`agent "${owned.agentKey}" is not offered by this profile`)
    const { account } = choice
    // An account can run another build of the agent (its own command).
    const agent = accountAgent(choice.agent, account)
    const resolved = this.servicesFor(owned.profileId)
    // An account's own config folder is a path on this computer: a session on another host cannot use it yet.
    if (account?.configDir && elsewhere(resolved.hostId)) throw new Error(this.t('profileHost.accountConfigDir', { account: account.name }))
    // A restored session whose host is still connecting is listed now, stopped, under that host (the
    // runtimes here only describe it; it never starts on them). Any other session waits for the host.
    const pending = isPending(resolved) && internal.restored ? resolved : undefined
    const services = pending ? { ...this.local, hostId: pending.hostId } : isPending(resolved) ? await this.ready(resolved) : resolved
    const runtime = agent.adapter === 'terminal' ? services.terminal : services.runtimes[agent.adapter]
    // Checked before a worktree is made, so a session that cannot run leaves nothing behind.
    if (!runtime) throw new Error(`no runtime for adapter "${agent.adapter}"`)
    const placed = await this.placeInWorktree(owned, config, internal, services)
    if (pending) {
      const view = await this.launch(config, choice, agent, account, services, runtime, { ...owned, cwd: placed.cwd }, placed, { ...internal, dormant: true, awaitingHost: pending.hostId })
      this.bindWhenReady(view.id, pending, internal.dormant ? undefined : () => this.start(asked, internal))
      return view
    }
    try {
      return await this.launch(config, choice, agent, account, services, runtime, { ...owned, cwd: placed.cwd }, placed, internal)
    } catch (err) {
      // A worktree made for this session goes when the session cannot start (the environment failed).
      if (placed.worktree && !internal.worktree) await this.deps.worktrees?.remove(placed.worktree.repoRoot, placed.worktree.path, { force: true }).catch(() => undefined)
      throw err
    }
  }

  /**
   * Prepares a worktree made for a session: the `.worktreeinclude` copy, then the user's setup
   * command with the session's environment. Reported as a notice; never stops the session.
   */
  private async bootstrap(s: ManagedSession, worktree: SessionWorktree, command: string | undefined): Promise<void> {
    if (!this.deps.worktrees) return
    const text = this.deps.text ?? ((key: string, params?: Record<string, string | number>) => translate('en', key as MessageKey, params))
    const report = await bootstrapWorktree(
      { worktrees: this.deps.worktrees, t: text, ...(this.deps.setupRunner ? { run: this.deps.setupRunner } : {}), ...(this.deps.log ? { log: this.deps.log } : {}) },
      { repoRoot: worktree.repoRoot, path: worktree.path, command, env: s.env }
    ).catch(() => null)
    if (!report) return
    this.deps.emitEvent({ sessionId: s.view.id, type: 'notice', noticeId: `${s.view.id}:worktree`, kind: report.failed ? 'warning' : 'info', title: report.title, text: report.text, ...(report.failed ? { failed: true } : {}) })
  }

  /** The services of a host the session waits for, subscribed to. */
  private async ready(pending: PendingServices): Promise<SessionServices> {
    const services = await pending.ready
    this.watch(services)
    return services
  }

  /** A live session (starting, running or idle) that runs this agent session id or identity. */
  private liveWith(key: string | undefined): ManagedSession | undefined {
    if (!key) return undefined
    for (const s of this.sessions.values()) {
      if (s.view.state === 'stopped' || s.view.state === 'error') continue
      if (s.view.agentSessionId === key || s.view.identity === key) return s
    }
    return undefined
  }

  /** The rest of `start`, once the runtime is known and the session has its folder. */
  private async launch(
    config: WorkhubConfig,
    choice: EffectiveAgent,
    agent: AgentDefinition,
    account: AgentAccount | null,
    services: SessionServices,
    runtime: AgentRuntime,
    input: StartSessionInput,
    placed: PlacedSession,
    internal: { env?: Record<string, string>; origin?: SessionOrigin; restored?: boolean; handOver?: boolean; dormant?: boolean; title?: string; awaitingHost?: string }
  ): Promise<SessionView> {

    const capabilities = runtime.capabilities(agent)
    const modes: SessionMode[] = []
    if (agent.adapter !== 'terminal' && capabilities.appMode) modes.push('app')
    // A read-only reviewer has no console: the agent's own TUI would run with its usual permissions.
    if ((agent.adapter === 'terminal' || agent.console) && !input.readOnly) modes.push('console')
    modes.push('shell')
    // An agent without a console (most ACP agents) opens its chat even when the terminal is asked for.
    const engine: Engine = modes[0] === 'app' && !(input.mode === 'console' && modes.includes('console')) ? 'app' : 'console'
    // Agents with a console share one session id between chat, console and transcript.
    const agentSessionId = input.resumeAgentSessionId ?? (agent.console || agent.adapter === 'native' ? randomUUID() : undefined)

    // Sidebar groups (and names) key a session by this: the agent's own id when there is one.
    const identity = agentSessionId ?? input.identity ?? randomUUID()
    const name = this.deps.names?.get(identity)
    const id = randomUUID()
    // Built before the session is listed: a profile environment that fails leaves no session behind.
    const { env, mcp } = await this.environment(id, agent, account, { profileId: input.profileId, cwd: input.cwd, readOnly: input.readOnly === true }, services, internal.env)
    const view: SessionView = {
      id,
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
      ...(placed.worktree ? { worktree: placed.worktree } : {}),
      ...(services.hostId && services.hostId !== 'local' ? { hostId: services.hostId } : {}),
      ...(internal.origin ? { origin: internal.origin } : {}),
      ...(input.resumeAgentSessionId || input.identity ? { resumed: true } : {}),
      pendingPermissions: []
    }
    const session: ManagedSession = {
      view,
      agent,
      account,
      env,
      mcp,
      services,
      runtime,
      engine,
      switching: false,
      readOnly: input.readOnly === true,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(internal.env ? { extraEnv: internal.env } : {}),
      ...(internal.awaitingHost ? { awaitingHost: internal.awaitingHost } : {}),
      openPermissions: new Map(),
      answeredPermissions: [],
      console: new ConsoleActivity(),
      consoleStartedAt: 0,
      clock: new ActiveClock(),
      reportsActiveTime: false,
      toolStatus: new Map()
    }
    // Another start of the same conversation may have got here while this one awaited.
    const raced = internal.handOver ? undefined : this.liveWith(input.resumeAgentSessionId ?? input.identity)
    if (raced) return raced.view
    // A session brought back at launch without its process: listed stopped, started when opened.
    if (internal.dormant) {
      view.state = 'stopped'
      const title = internal.title ? cleanSessionName(internal.title) : null
      if (title) view.agentTitle = title
      session.dormant = true
      this.sessions.set(view.id, session)
      this.deps.emitChanged(view)
      return view
    }
    // Opening a session that waited stopped, or one whose start failed (a resume the agent refused),
    // replaces it, so removing the new one removes it for good.
    for (const old of [...this.sessions.values()]) {
      const key = input.resumeAgentSessionId ?? input.identity
      const replaced = (old.dormant && old.view.state === 'stopped') || old.view.state === 'error'
      if (replaced && key && (old.view.agentSessionId === key || old.view.identity === key)) this.remove(old.view.id)
    }
    this.sessions.set(view.id, session)
    this.deps.emitChanged(view)

    // session/new can take 10-15 s: answer now, report progress through `changed` events.
    // What was picked for this session, else the account's defaults, else the agent's (Settings → Agents).
    const model = input.model ?? account?.defaultModel
    const modeId = input.readOnly ? undefined : (input.modeId ?? defaultStartMode(config, choice.agent.id, account))
    // A session reopened (at launch, or by hand from the list) resumes its conversation only when
    // it exists (one never prompted has none, and a transcript may be gone): otherwise the same
    // session id starts fresh, as Workhub 1 does. An agent without a transcript reader cannot be
    // checked, so a manual reopen of it keeps resuming, and so does one restored at launch when it
    // resumes over ACP (`session/load`; it falls back to a new conversation with a notice).
    const starting = async () => {
      if (placed.created && placed.worktree && this.deps.worktrees) await this.bootstrap(session, placed.worktree, placed.created.setupCommand)
      const resume = internal.restored
        ? this.reader(session)
          ? await this.hasTranscript(session).catch(() => false)
          : agent.adapter === 'acp' && agent.capabilities.resume === true && Boolean(session.view.agentSessionId)
        : input.resumeAgentSessionId
          ? !this.reader(session) || (await this.hasTranscript(session).catch(() => false))
          : false
      return engine === 'app' ? this.startChat(session, { resume, model, effort: input.effort, modeId, cols: input.cols, rows: input.rows }) : this.startConsole(session, input.cols, input.rows, model)
    }
    void starting().catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      // A runtime that reports its own failure as a state event has logged it already.
      if (this.sessions.get(view.id)?.view.state !== 'error') this.logFailure(this.sessions.get(view.id), error)
      this.update(view.id, { state: 'error', error })
    })
    return view
  }

  /**
   * A session's variables (its agent and account, its profile, Workhub's control endpoint on its
   * host, the caller's) and the MCP servers Workhub hands it there.
   */
  private async environment(
    id: string,
    agent: AgentDefinition,
    account: AgentAccount | null,
    input: { profileId: string | null; cwd: string; readOnly: boolean },
    services: SessionServices,
    extra: Record<string, string> | undefined
  ): Promise<{ env: Record<string, string>; mcp: McpServerLaunch[] }> {
    const env = {
      ...launchEnvironment(agent, account, account ? await this.deps.accountEnv?.(account) : undefined),
      ...((await this.deps.profileEnv?.(input.profileId, input.cwd, onHost(services) ? (services.home ?? null) : undefined)) ?? {}),
      ...(input.readOnly ? NO_CONTROL_ENV : (this.deps.sessionEnv?.(id, services.control) ?? NO_CONTROL_ENV)),
      ...(extra ?? {})
    }
    const mcp = input.readOnly ? [] : ((await this.deps.sessionMcp?.(env, agent, services.control)) ?? [])
    return { env, mcp }
  }

  /** A message in the user's language (English without `deps.text`). */
  private t(key: MessageKey, params?: Record<string, string | number>): string {
    return this.deps.text ? this.deps.text(key, params) : translate('en', key, params)
  }

  /** Refuses to run anything for a session whose host has not connected yet (its services are placeholders). */
  private requireHost(s: ManagedSession): void {
    if (s.awaitingHost) throw new Error(`${hostLabel(s.awaitingHost)} has not connected yet: the session starts there once it connects`)
  }

  /**
   * Where a new session runs: a new worktree of the folder's repository when the session asks for
   * one (never for a reviewer, a reopened or a resumed session), else the folder asked for. The
   * folder's place inside the repository is kept (`repo/src` starts in `<worktree>/src`).
   */
  private async placeInWorktree(input: StartSessionInput, config: WorkhubConfig, internal: { restored?: boolean; worktree?: SessionWorktree }, services: SessionServices): Promise<PlacedSession> {
    if (internal.worktree) return { cwd: input.cwd, worktree: internal.worktree }
    const asked = input.worktree
    // Not yet on another host (its worktree would be made on this computer): a session that asks
    // for one is refused; one that takes a worktree only when it can starts in the folder.
    if (asked && onHost(services)) {
      if (asked.optional) return { cwd: input.cwd }
      throw new Error(this.t('profileHost.noWorktrees'))
    }
    const worktrees = this.deps.worktrees
    if (!asked || !worktrees || input.readOnly || internal.restored || input.resumeAgentSessionId || input.identity) return { cwd: input.cwd }
    const repoRoot = await worktrees.repoRootOf(input.cwd)
    if (!repoRoot) {
      if (asked.optional) return { cwd: input.cwd }
      throw new Error(`${input.cwd} is not in a git repository, so it cannot get a worktree`)
    }
    const home = homedir()
    const profile = config.profiles.find((p) => p.id === input.profileId)
    const settings = worktreeSettings(profile)
    const branch = worktreeBranch(settings, asked.branch, randomUUID().slice(0, 8))
    const folder = (profile && containingFolder(repoRoot, profile, home)?.path) ?? dirname(repoRoot)
    const path = join(worktreesLocation(settings, { folder, repo: repoRoot }, home), worktreeFolderName(repoRoot, branch))
    const exists = services.exists ?? (async (p: string) => existsSync(p))
    if (await exists(path)) throw new Error(`${path} already exists: pick another branch name`)
    await worktrees.create(repoRoot, { path, branch, base: settings.baseRef })
    const inside = relative(repoRoot, input.cwd)
    const cwd = inside && !inside.startsWith('..') && !isAbsolute(inside) ? join(path, inside) : path
    return { cwd: (await exists(cwd)) ? cwd : path, worktree: { repoRoot, path, branch }, created: { setupCommand: worktreeSetupCommand(profile, repoRoot, home) } }
  }

  /**
   * Closes a session and removes the worktree Workhub created for it (its branch stays). Without
   * `force`, a worktree with uncommitted changes or unpushed commits is left alone and the session
   * stays open: the answer says what it holds, so the user can confirm.
   */
  async closeRemovingWorktree(id: string, force: boolean): Promise<CloseWorktreeResult> {
    const worktree = this.sessions.get(id)?.view.worktree
    const worktrees = this.deps.worktrees
    if (!worktree || !worktrees) {
      await this.close(id)
      return { ok: true }
    }
    if (!force) {
      const status = await worktrees.status(worktree.path)
      if (status.dirty || status.unpushed > 0) return { ok: false, blocked: status }
    }
    await this.close(id)
    await worktrees.remove(worktree.repoRoot, worktree.path, { force })
    return { ok: true }
  }

  /** The engine a session runs (its shell shows over the chat or the console); undefined when it is not open. */
  engineOf(id: string): 'app' | 'console' | undefined {
    return this.sessions.get(id)?.engine
  }

  /** Stops a session (if it still runs) and drops it from the list; its conversation stays in History. */
  async close(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    // `stop()` already stopped the terminals; a session that had exited on its own needs it here.
    const wasLive = s.view.state !== 'stopped' && s.view.state !== 'error'
    if (wasLive) await this.stop(id)
    // A late event may have moved it out of `stopped`; closing wins.
    if (s.view.state !== 'stopped' && s.view.state !== 'error') this.update(id, { state: 'stopped' })
    this.drop(id, !wasLive)
  }

  /**
   * Names a session; empty or null goes back to its agent's name. Kept by identity, so a resumed
   * session keeps it. An agent whose history takes titles (Claude) gets it too, as `/rename` would
   * set it, so `claude --resume` and the terminal show the same name; that write is best effort.
   */
  rename(id: string, name: string | null): void {
    const s = this.require(id)
    const key = s.view.identity ?? s.view.agentSessionId ?? s.view.id
    const stored = this.deps.names ? this.deps.names.set(key, name) : cleanSessionName(name)
    this.update(id, { name: stored })
    const source = s.services.history[s.agent.accountsOf ?? s.agent.id]
    if (stored && source?.rename && s.view.agentSessionId) {
      void source.rename(s.view.agentSessionId, s.view.cwd, stored, s.account?.configDir).catch(() => undefined)
    }
  }

  /**
   * Runs one prompt turn. An agent that takes no input mid-turn gets one prompt at a time: this
   * waits for the session's prompt in flight, whoever sent it. Claude folds a message sent during a
   * turn into it, so its prompts go straight through. `onStart` runs when the prompt actually goes
   * out; `key` lets the sender take it back with `withdrawPrompt` while it waits.
   */
  prompt(id: string, text: string, images?: ImageInput[], options: { key?: string; onStart?: () => void } = {}): Promise<string> {
    try {
      const s = this.chatSession(id)
      const send = async () => {
        // The session may have handed over to its console while this prompt waited.
        const now = this.chatSession(id)
        const usable = now.view.capabilities.imageInput && images?.length ? images : undefined
        options.onStart?.()
        return (await now.runtime.prompt(id, text, usable)).stopReason
      }
      return s.view.capabilities.midTurnInput ? send() : this.sends.run(id, send, options.key)
    } catch (e) {
      return Promise.reject(e)
    }
  }

  /**
   * A prompt from a sender that keeps its own retry (reviews, automations, Slack): sent now, or
   * null (nothing sent) while another prompt of the session is in flight or waiting.
   */
  tryPrompt(id: string, text: string): Promise<string> | null {
    const s = this.chatSession(id)
    if (!s.view.capabilities.midTurnInput && this.sends.busy(id)) return null
    return this.prompt(id, text)
  }

  /** Prompts held in main behind a running turn, over every session (the quit guard counts them). */
  queuedPromptCount(): number {
    return this.sends.waitingCount()
  }

  /** Takes back a prompt still waiting for its turn (the user removed it); false once it went out. */
  withdrawPrompt(id: string, key: string): boolean {
    return this.sends.withdrawOne(id, key)
  }

  private chatSession(id: string): ManagedSession {
    const s = this.require(id)
    if (s.engine !== 'app') throw new Error('the session is in its console; type there')
    return s
  }

  /** Interrupts the turn; prompts still waiting for it are dropped, never sent after it. */
  async cancel(id: string): Promise<void> {
    const s = this.require(id)
    this.sends.withdraw(id)
    if (s.engine === 'app') await s.runtime.cancel(id)
    else await s.services.terminal.cancel(terminalChannel(id, 'console'))
  }

  async stop(id: string): Promise<void> {
    const s = this.require(id)
    this.sends.withdraw(id)
    this.clearPending(s)
    s.switching = true
    try {
      await Promise.all([
        s.engine === 'app' ? s.runtime.stop(id) : s.services.terminal.stop(terminalChannel(id, 'console')),
        s.services.terminal.stop(terminalChannel(id, 'shell'))
      ])
    } finally {
      // Marked stopped even when a runtime failed to stop: the session must not stay "switching".
      s.switching = false
      this.update(id, { state: 'stopped', shellRunning: false, pendingMode: undefined })
    }
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
    this.requireHost(s)
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
      if (live) await (s.engine === 'app' ? s.runtime.stop(id) : s.services.terminal.stop(terminalChannel(id, 'console')))
      s.engine = engine
      s.openPermissions.clear()
      s.console.reset()
      this.update(id, { mode: show, pendingMode: undefined, state: 'starting', error: undefined, pendingPermissions: [], consoleAsking: false })
    } finally {
      s.switching = false
    }
    const hasHistory = await this.hasTranscript(s)
    if (engine === 'app') await this.startChat(s, { resume: hasHistory, model: s.view.currentModelId, effort: s.effort, modeId: s.readOnly ? undefined : s.view.currentModeId })
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

  respondPermission(id: string, requestId: string, optionId: string | null, answers?: Record<string, string>): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.runtime.respondPermission(id, requestId, optionId, answers)
    if (s.openPermissions.delete(requestId)) {
      s.answeredPermissions = [...s.answeredPermissions.filter((r) => r !== requestId), requestId].slice(-ANSWERED_PERMISSIONS_KEPT)
      this.update(id, { pendingPermissions: [...s.openPermissions.values()], answeredPermissions: [...s.answeredPermissions] })
    }
    this.checkPending(s)
  }

  /** Raw input for a session's terminal channel (`<id>:console` or `<id>:shell`). */
  write(channelId: string, data: string): void {
    const terminal = this.terminalOf(channelId)
    if (isTerminalControl(terminal)) terminal.write(channelId, data)
    const [id, channel] = channelId.split(':')
    const s = channel === 'console' ? this.sessions.get(id!) : undefined
    if (s) {
      // Typing in the console answers whatever it asked; xterm's own replies (focus reports, cursor
      // position, device attributes) are not typing, and moving through the options is not an answer: Enter is.
      if (!isTerminalReply(data)) s.console.typed()
      if (s.view.consoleAsking && /[\r\n]/.test(data)) this.update(s.view.id, { consoleAsking: false, consoleAskingSince: undefined })
      this.checkPending(s)
    }
  }

  /** Remembered per channel too: a terminal that starts later (a hand-over) starts at this size. */
  resize(channelId: string, cols: number, rows: number): void {
    if (!(cols > 0 && rows > 0)) return
    this.sizes.set(channelId, { cols, rows })
    const terminal = this.terminalOf(channelId)
    if (isTerminalControl(terminal)) terminal.resize(channelId, cols, rows)
  }

  async stopAll(): Promise<void> {
    clearInterval(this.timer)
    clearInterval(this.stallTimer)
    for (const s of this.sessions.values()) this.clearPending(s)
    for (const s of this.sessions.values()) s.switching = true
    await Promise.all([...this.subscribed].map((r) => r.stopAll()))
  }

  private async startApp(s: ManagedSession, opts: { resume: boolean; model?: string; effort?: string; modeId?: string; cols?: number; rows?: number }): Promise<void> {
    const started = await s.runtime.start({
      sessionId: s.view.id,
      agent: s.agent,
      account: s.account,
      cwd: s.view.cwd,
      env: s.env,
      agentSessionId: s.view.agentSessionId,
      resume: opts.resume,
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.modeId ? { modeId: opts.modeId } : {}),
      cols: opts.cols,
      rows: opts.rows,
      ...(s.readOnly ? { readOnly: true } : {}),
      ...(s.mcp.length ? { mcpServers: s.mcp } : {})
    })
    const patch: Partial<SessionView> = { agentSessionId: started.agentSessionId ?? s.view.agentSessionId, agentName: started.agentName }
    // An agent that only reports its session id now (ACP) gives the session its real identity; the
    // group place it may have been given under the provisional one moves with it.
    if (patch.agentSessionId && patch.agentSessionId !== s.view.identity) {
      patch.identity = patch.agentSessionId
      await this.moveIdentity(s.view.identity, patch.agentSessionId)
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
    if (opts.resume && started.resumeFailed) this.noteNewConversation(s, started.resumeFailed)
    if (started.models?.length || started.availableModes?.length) {
      this.deps.onAgentOptions?.(s.agent.id, s.account?.id ?? null, { models: started.models ?? [], modes: started.availableModes ?? [] })
    }
  }

  /**
   * A resume that started a new conversation instead (an ACP agent without `session/load`, or a
   * load the agent refused). Sent through `onEvent`, so while the earlier conversation is replayed
   * it waits with the chat's own events and shows right below it: what came before stays readable
   * as history, and the notice says the agent does not remember it.
   */
  private noteNewConversation(s: ManagedSession, reason: 'unsupported' | 'failed'): void {
    const text = this.deps.text ?? ((key: string, params?: Record<string, string | number>) => translate('en', key as MessageKey, params))
    this.onEvent({ sessionId: s.view.id, type: 'notice', noticeId: `${s.view.id}:resume`, kind: 'warning', title: text('session.resumeFailed.title'), text: text(`session.resumeFailed.${reason}`) })
  }

  /** The session's name and sidebar place follow it to a new identity. */
  private async moveIdentity(previous: string | undefined, next: string): Promise<void> {
    if (!previous || previous === next) return
    this.deps.names?.move(previous, next)
    try {
      const moved = await this.deps.config.replaceSessionIdentity(previous, next)
      if (moved?.ok) this.deps.emitConfigChanged?.()
    } catch {
      // The groups are a convenience; the session goes on.
    }
  }

  /**
   * The agent moved the conversation to a new session id (Claude's `/clear`): the session takes it
   * as its id and identity, so its monitor, a resume and its sidebar place follow the live
   * conversation. The session driver sees the new identity and tells the automations and the
   * chat watcher.
   */
  private followAgentSession(s: ManagedSession, agentSessionId: string): void {
    if (s.view.agentSessionId === agentSessionId) return
    const previous = s.view.identity
    this.update(s.view.id, { agentSessionId, identity: agentSessionId })
    void this.moveIdentity(previous, agentSessionId)
  }

  private async startConsole(s: ManagedSession, cols?: number, rows?: number, model?: string): Promise<void> {
    // A session created straight in the console has no model on its view yet: keep it there, so the
    // chat (and the next console) starts on the same one.
    if (model && !s.view.currentModelId) this.update(s.view.id, { currentModelId: model })
    const modelId = model ?? s.view.currentModelId
    const launch =
      s.agent.adapter === 'terminal'
        ? { command: s.agent.command, args: s.agent.args }
        : consoleCommand(s.agent.console!, s.view.agentSessionId, await this.hasTranscript(s), modelId, consoleMcpConfig(s.mcp))
    const agent: AgentDefinition = { ...s.agent, adapter: 'terminal', command: launch.command, args: launch.args }
    const channel = terminalChannel(s.view.id, 'console')
    const size = this.sizes.get(channel)
    s.console.reset()
    s.consoleStartedAt = Date.now()
    const started = await s.services.terminal.start({
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
    this.requireHost(s)
    const channel = terminalChannel(s.view.id, 'shell')
    const size = this.sizes.get(channel) ?? this.sizes.get(terminalChannel(s.view.id, 'console'))
    await s.services.terminal.start({ sessionId: channel, agent: SHELL, account: null, cwd: s.view.cwd, env: s.env, cols: size?.cols ?? 100, rows: size?.rows ?? 30 })
    this.update(s.view.id, { shellRunning: true })
  }

  private async hasTranscript(s: ManagedSession): Promise<boolean> {
    const reader = this.reader(s)
    if (!reader || !s.view.agentSessionId) return false
    return reader.exists({ agentSessionId: s.view.agentSessionId, cwd: s.view.cwd, configDir: s.account?.configDir })
  }

  private reader(s: ManagedSession): TranscriptReader | undefined {
    return s.agent.transcript ? s.services.transcripts.find((r) => r.id === s.agent.transcript) : undefined
  }

  /**
   * Starts the chat; a resumed one shows its conversation first (its last `replayLast` messages). The SDK resumes a session
   * without replaying it, so the stored messages are read (in parallel with the start) and sent
   * before any live event of the new chat, and the chat turns ready only after them: the
   * renderer replaces what it showed with the full conversation, the console's turns included.
   */
  private async startChat(s: ManagedSession, opts: { resume: boolean; model?: string; effort?: string; modeId?: string; cols?: number; rows?: number }): Promise<void> {
    const source = s.services.history[s.agent.accountsOf ?? s.agent.id]
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
      this.readHistory(source, agentSessionId, s, this.deps.replayLast ?? JOURNAL_MAX_ENTRIES).then((messages) => {
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

  /** The stored conversation of an open session: empty when it has none yet or it cannot be read. */
  async history(id: string): Promise<HistoryMessage[]> {
    const s = this.sessions.get(id)
    const source = s ? s.services.history[s.agent.accountsOf ?? s.agent.id] : undefined
    if (!s || !source || !s.view.agentSessionId) return []
    return this.readHistory(source, s.view.agentSessionId, s)
  }

  private async readHistory(source: SessionHistorySource, agentSessionId: string, s: ManagedSession, last?: number): Promise<HistoryMessage[]> {
    try {
      const messages = await source.messages(agentSessionId, s.view.cwd, s.account?.configDir, last ? { last } : undefined)
      // A source that cannot cut the conversation itself returns all of it.
      return last && messages.length > last ? messages.slice(-last) : messages
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
      for (const s of this.sessions.values()) {
        // A stopped session cannot change: it gets one last read, then is left alone until it starts again.
        const over = (s.view.state === 'stopped' || s.view.state === 'error') && !s.switching
        if (over && s.finalRead) continue
        await this.pollOne(s, prefixes)
        if (over) s.finalRead = true
        if (s.clock.isBusy()) this.emitDerivedActive(s)
      }
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
    if (snapshot?.activeTimeMs !== undefined) s.reportsActiveTime = true
    if (!snapshot || key === s.lastMonitor) return
    s.lastMonitor = key ?? undefined
    if (snapshot.workPaths) {
      s.workPaths = snapshot.workPaths
      s.changePaths = snapshot.changePaths ?? []
    }
    if (snapshot.title) this.noteAgentTitle(s, snapshot.title)
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
        if (e.state === 'error') this.logFailure(s, e.error)
        this.update(id, { state: e.state, ...(e.error ? { error: e.error } : {}) })
      }
    }
    if (s && !channel) {
      if (e.type === 'agentSession') this.followAgentSession(s, e.agentSessionId)
      if (e.type === 'permissionMode') this.update(id, { permissionMode: e.mode, currentModeId: e.currentModeId })
      if (e.type === 'commands') this.update(id, { commands: e.commands })
      if (e.type === 'monitor' && e.snapshot.title) this.noteAgentTitle(s, e.snapshot.title)
      if (e.type === 'models') {
        this.update(id, { models: e.models, ...(e.currentModelId ? { currentModelId: e.currentModelId } : {}) })
        if (e.models.length) this.deps.onAgentOptions?.(s.agent.id, s.account?.id ?? null, { models: e.models, modes: s.view.availableModes ?? [] })
      }
    }
    if (s && e.type === 'monitor' && e.snapshot.activeTimeMs !== undefined) s.reportsActiveTime = true
    // Anything the agent sends (not the polled transcript, nor the shell beside it) ends its silence.
    if (s && e.type !== 'monitor' && channel !== 'shell') this.noteActivity(s)
    if (s) this.track(s, e, channel)
    this.deps.emitEvent(e)
    if (s) this.checkPending(s)
  }

  private noteActivity(s: ManagedSession): void {
    this.stalls.note(s.view.id, Date.now())
    if (s.view.stalledSince !== undefined) this.update(s.view.id, { stalledSince: undefined })
  }

  /** Flags the working sessions whose agent has been silent for the preference's minutes; nothing is stopped. */
  private async checkStalls(): Promise<void> {
    const minutes = appOptions(await this.deps.config.current()).stuckSessionMinutes
    const inputs = [...this.sessions.values()].map((s) => ({
      id: s.view.id,
      working: s.view.state === 'busy' && !s.dormant && !s.held,
      waitingOnUser: s.openPermissions.size > 0 || Boolean(s.view.consoleAsking)
    }))
    const { flag } = this.stalls.check(inputs, Date.now(), minutes * 60_000)
    for (const f of flag) this.update(f.id, { stalledSince: f.since })
    // Turned off (or raised past the silence so far): a notice already showing goes.
    for (const s of this.sessions.values()) {
      if (s.view.stalledSince !== undefined && (minutes <= 0 || !inputs.find((i) => i.id === s.view.id)?.working)) this.update(s.view.id, { stalledSince: undefined })
    }
  }

  /** "Keep waiting": the silence starts over; the notice comes back after another full interval. */
  keepWaiting(id: string): void {
    const s = this.require(id)
    this.stalls.keepWaiting(id, Date.now())
    if (s.view.stalledSince !== undefined) this.update(id, { stalledSince: undefined })
  }

  /** The agent titled the conversation (or titled it again): the sidebar shows it unless the user named the session. */
  private noteAgentTitle(s: ManagedSession, title: string): void {
    const clean = cleanSessionName(title)
    if (clean && clean !== s.view.agentTitle) this.update(s.view.id, { agentTitle: clean })
  }

  /** Keeps what decides whether a turn is in progress: open permission requests, the console's title. */
  private track(s: ManagedSession, e: AgentEvent, channel?: 'console' | 'shell'): void {
    if (!channel && s.engine === 'app') {
      const before = s.openPermissions.size
      // The detail travels in full with the event; the view, pushed on every change and to the phone, keeps a head of it.
      if (e.type === 'permission') s.openPermissions.set(e.requestId, { requestId: e.requestId, title: e.title, options: e.options, ...(e.detail ? { detail: e.detail.length > PENDING_DETAIL_CHARS ? `${e.detail.slice(0, PENDING_DETAIL_CHARS)}…` : e.detail } : {}), ...(e.questions ? { questions: e.questions } : {}), at: Date.now() })
      else if (e.type === 'permissionCancelled') s.openPermissions.delete(e.requestId)
      else if (e.type === 'state' && e.state !== 'busy') s.openPermissions.clear()
      // The view carries what waits, so a window or device that connects later shows it (and one answered elsewhere goes away).
      if (e.type === 'permission' || s.openPermissions.size !== before) this.update(s.view.id, { pendingPermissions: [...s.openPermissions.values()] })
    } else if (channel === 'console' && s.engine === 'console' && e.type === 'output') {
      if (s.console.feed(e.data) && s.console.asking !== (s.view.consoleAsking ?? false)) this.update(s.view.id, { consoleAsking: s.console.asking, consoleAskingSince: s.console.asking ? Date.now() : undefined })
    }
  }

  /** One line in the main log for a session that failed to start or ended on its own; `error` carries the agent's last stderr lines. */
  private logFailure(s: ManagedSession | undefined, error: string | undefined): void {
    if (!s || !this.deps.log) return
    const what = s.view.state === 'starting' ? 'failed to start' : 'ended unexpectedly'
    this.deps.log(`session ${s.view.id} (${s.view.agentId}) ${what}: ${error ? redactText(error, 2000) : 'no error reported'}`)
  }

  private update(id: string, patch: Partial<SessionView>): void {
    const s = this.sessions.get(id)
    if (!s) return
    // A finished session keeps its final state even if a late event arrives.
    if ((s.view.state === 'stopped' || s.view.state === 'error') && patch.state && patch.state !== s.view.state) {
      if (patch.state !== 'stopped' && patch.state !== 'error' && patch.state !== 'starting') return
    }
    // When the state began, for the header's "Working 1:23" / "Idle 2 min".
    if (patch.state && patch.state !== 'stopped' && patch.state !== 'error') s.finalRead = false
    const since = patch.state && patch.state !== s.view.state ? { stateSince: Date.now() } : {}
    // A console that stopped, failed or restarts no longer asks anything.
    const consoleGone = s.view.consoleAsking && patch.state && patch.state !== 'ready' && patch.state !== 'busy' ? { consoleAsking: false, consoleAskingSince: undefined } : {}
    // A turn that ended (or a session that stopped) is no longer silent.
    const unstalled = patch.state && patch.state !== 'busy' && s.view.stalledSince !== undefined ? { stalledSince: undefined } : {}
    s.view = { ...s.view, ...patch, ...since, ...consoleGone, ...unstalled }
    this.deps.emitChanged(s.view)
    if (patch.state && 'stateSince' in since) {
      s.clock.observe(patch.state, s.view.stateSince ?? Date.now())
      this.emitDerivedActive(s)
    }
  }

  /** Working time counted from the session's state changes, for agents that report none. */
  private emitDerivedActive(s: ManagedSession): void {
    if (s.reportsActiveTime) return
    this.deps.emitEvent({ sessionId: s.view.id, type: 'monitor', snapshot: { activeTimeMs: s.clock.ms(Date.now()) } })
  }

  /** The session's folder, for reads main does on its behalf (local changes). */
  cwdOf(id: string): string | null {
    return this.sessions.get(id)?.view.cwd ?? null
  }

  /** The folders a session worked in, most recent last; undefined when its agent does not report them. */
  workPathsOf(id: string): string[] | undefined {
    return this.sessions.get(id)?.workPaths
  }

  /** The folders a session changed something in (edits, git writes, pull requests); undefined when its agent does not report them. */
  changePathsOf(id: string): string[] | undefined {
    return this.sessions.get(id)?.changePaths
  }

  private require(id: string): ManagedSession {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session ${id}`)
    return s
  }
}
