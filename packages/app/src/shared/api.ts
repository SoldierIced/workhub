// Types of the preload bridge (window.hub), shared by main, preload and renderer.
import type { NotificationKind, TrayApi, TrayRoute } from './tray-api'
import type {
  AppOptions,
  AgentCapabilities,
  BudgetStatus,
  CreditSpend,
  FolderSpendEntry,
  AgentDefinition,
  AgentEvent,
  AgentAccount,
  Connection,
  ConnectionProvider,
  EffectiveAgent,
  HistoryEntry,
  HistoryMessage,
  SubagentConversation,
  ImageInput,
  ImportPlan,
  ModelOption,
  PlanUsageWindow,
  Profile,
  SessionModeOption,
  Result,
  SecretChange,
  Session,
  SessionGroups,
  SessionOrigin,
  SessionScreen,
  ValidationIssue,
  Workhub1SecretResult,
  WorkhubConfig
} from '@workhub/core'
import type { AiReviewApi } from './ai-review-api'
import type { AutomationsApi, SlackApi } from './chat-api'
import type { CodeHostApi } from './codehost-api'
import type { ContinuityApi } from './continuity-api'
import type { HealthApi } from './health-api'
import type { LinksApi } from './links-api'
import type { PrEventsApi } from './pr-events-api'
import type { TicketsApi } from './tickets-api'
import type { UpdatesApi } from './updates-api'

export interface ConfigSnapshot {
  config: WorkhubConfig
  /** Problems already in the stored config (e.g. a hand-edited file). */
  issues: ValidationIssue[]
  agents: AgentDefinition[]
  providers: ConnectionProvider[]
  /** Connection ids that have a stored secret. */
  connectionsWithSecret: string[]
  /** Where the config and secrets files live. */
  dataDir: string
  /** Set when the config file could not be loaded; editing is disabled until it is fixed. */
  loadError?: string
}

export interface ConfigApi {
  get(): Promise<ConfigSnapshot>
  saveConnection(connection: Connection, secret: SecretChange): Promise<Result<WorkhubConfig>>
  deleteConnection(id: string): Promise<Result<WorkhubConfig>>
  saveAccount(account: AgentAccount): Promise<Result<WorkhubConfig>>
  deleteAccount(id: string): Promise<Result<WorkhubConfig>>
  saveProfile(profile: Profile): Promise<Result<WorkhubConfig>>
  deleteProfile(id: string): Promise<Result<WorkhubConfig>>
  setActiveProfile(id: string): Promise<Result<WorkhubConfig>>
  saveOptions(options: Partial<AppOptions>): Promise<Result<WorkhubConfig>>
  /** Stores the sidebar groups (computed in the renderer with the pure functions of core). */
  saveSessionGroups(groups: SessionGroups): Promise<Result<WorkhubConfig>>
  effectiveAgents(profileId: string | null): Promise<EffectiveAgent[]>
  /**
   * Workhub 1's settings mapped onto this config, read-only (macOS). `available: false` when Workhub 1
   * has none here. `pendingSecrets`: the connections from Workhub 1 still missing their token (names only).
   */
  previewWorkhub1Import(): Promise<Workhub1Preview>
  /** Reads Workhub 1's settings again and adds what the preview showed. Never writes to Workhub 1. */
  applyWorkhub1Import(): Promise<Result<WorkhubConfig>>
  /** macOS: copies the tokens of Workhub 1's Keychain items (macOS asks to allow each) into the secret store. Statuses only, never a secret. */
  importWorkhub1Secrets(): Promise<Workhub1SecretResult[]>
  /** Main changed the config on its own (a session's group place moved to its real id). */
  onChanged(cb: () => void): () => void
}

/**
 * What a session shows. `app`: the structured chat (agents with app mode). `console`: the agent's
 * own terminal UI (or the CLI of a terminal agent). `shell`: a shell in the session's folder,
 * next to the agent, which keeps running.
 */
export type SessionMode = 'app' | 'console' | 'shell'

/** The terminal channels of a session; their output arrives as `output` events with these ids. */
export function terminalChannel(sessionId: string, channel: 'console' | 'shell'): string {
  return `${sessionId}:${channel}`
}

/** A session as the renderer sees it. */
export interface SessionView extends Session {
  label: string
  agentName: string
  /** The account's name, when the session runs with one. */
  accountName?: string
  adapter: AgentDefinition['adapter']
  capabilities: AgentCapabilities
  screens: SessionScreen[]
  /** The modes this session can show, and the one on screen. */
  modes: SessionMode[]
  mode: SessionMode
  /** Whether the shell next to the agent is running. */
  shellRunning: boolean
  /** Models the session can switch to (native Claude, ACP agents that list them), and the current one. */
  models?: ModelOption[]
  currentModelId?: string
  /** The model asked for at start could not be applied: the agent runs with its default. */
  modelIgnored?: boolean
  /** The mode (agent, persona) asked for at start is not offered: the agent runs in its default. */
  modeIgnored?: boolean
  /** The runtime offers live controls: model switch and MCP reconnect/toggle (native Claude). */
  controls: boolean
  /** The model can be switched while the session runs (native Claude, ACP). */
  modelControl?: boolean
  /** The session mode (`availableModes`: agent, persona or approval preset) can be switched while it runs (ACP). */
  modeControl?: boolean
  /** An AI reviewer session (read-only, started by the AI review). */
  readOnly?: boolean
  /** The session continues another one: moved from another account, or handed off from another agent. */
  origin?: SessionOrigin
  /** The engine picked while a turn was running: the hand-over waits for the turn to end. */
  pendingMode?: 'app' | 'console'
}

export interface SetModeOptions {
  /** Hand over at once, even if that ends the turn in progress. */
  now?: boolean
}

export interface StartSessionInput {
  profileId: string | null
  agentKey: string
  cwd: string
  cols?: number
  rows?: number
  /** `console` opens the agent's own terminal UI instead of the chat; the default is `app` where the agent has it. */
  mode?: 'app' | 'console'
  /** Continue a past session (from the history) instead of starting a new one. */
  resumeAgentSessionId?: string
  /** Reopen a session that has no agent session id (a plain terminal) under its old identity, so it keeps its group. */
  identity?: string
  /** Model to start with (remembered per agent and account by the renderer); else the account's default. */
  model?: string
  /** Session mode to start in: the agent or persona (Kiro, OpenCode), the approval preset (Codex); else the account's default. */
  modeId?: string
  /** An AI reviewer: the agent's most read-only mode, chat only (see `StartSessionRequest.readOnly`). */
  readOnly?: boolean
}

/** A past session, plus its agent and account names for the history screen. */
export interface HistoryItem extends HistoryEntry {
  accountName?: string
  agentName: string
  /** Whether Workhub can open the session again; other agents' sessions are listed only. */
  resumable: boolean
}

export interface HistoryResult {
  entries: HistoryItem[]
  /** Accounts that could not be listed, with the reason. */
  errors: { account: string; message: string }[]
}

/** Plan usage of one agent account (Claude, Codex; Settings → Usage, opt-in per agent). */
export interface AccountUsage {
  /** The agent the account belongs to (`claude`, `codex`). */
  agentId: string
  /** `usageAccountKey`: what budgets are stored under. */
  key: string
  accountId: string | null
  name: string
  windows: PlanUsageWindow[]
  error?: string
  /** Epoch milliseconds of the read. */
  at: number
  /** The budget verdict at the time of the read (Settings → Usage). */
  budget: BudgetStatus
}

/** A usage window crossed an alert threshold or its ceiling; the renderer words it and shows it. */
export interface UsageAlert {
  agentId: string
  key: string
  name: string
  window: string
  threshold: number
  percent: number
  ceiling: boolean
  resetsAt: number
}

export interface SessionsApi {
  list(): Promise<SessionView[]>
  /** Returns at once with the session in `starting`; progress arrives through onChanged. */
  start(input: StartSessionInput): Promise<SessionView>
  prompt(id: string, text: string, images?: ImageInput[]): Promise<string>
  cancel(id: string): Promise<void>
  stop(id: string): Promise<void>
  respondPermission(id: string, requestId: string, optionId: string | null): void
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /**
   * Switches what the session shows; app and console hand the same agent session over. While a
   * turn runs the hand-over waits for its end (`pendingMode`) unless `now` is set.
   */
  setMode(id: string, mode: SessionMode, options?: SetModeOptions): Promise<void>
  /** Stops the session if it runs and drops it from the open sessions (it stays in History). */
  close(id: string): Promise<void>
  setModel(id: string, modelId: string | null): Promise<void>
  /** Switches the session's agent mode (an id of `availableModes`). */
  setAgentMode(id: string, modeId: string): Promise<void>
  mcp(id: string, action: 'refresh' | 'reconnect' | 'enable' | 'disable', server?: string): void
  /** One subagent's conversation (prompt, steps, answer); null when the agent keeps none. */
  subagent(id: string, subagentId: string): Promise<SubagentConversation | null>
  /** Shows a file the session's agent touched in the file manager; false when it is outside the session's folder or missing. */
  revealFile(id: string, path: string): Promise<boolean>
  onEvent(cb: (e: AgentEvent) => void): () => void
  onChanged(cb: (s: SessionView) => void): () => void
  /** A finished session left the list (an automation replaced it). */
  onRemoved(cb: (id: string) => void): () => void
  /** Earlier messages of a resumed session, to show before the new turns. */
  onReplay(cb: (id: string, messages: HistoryMessage[]) => void): () => void
}

export interface HistoryApi {
  list(): Promise<HistoryResult>
}

/**
 * What an agent offers before a session starts, for the New session dialog and Settings: Kiro's
 * models and agents from its CLI, else what the agent's last session reported over ACP.
 */
export interface AgentOptionsView {
  models: ModelOption[]
  modes: SessionModeOption[]
  defaultModelId?: string
  defaultModeId?: string
  /** `cli`: listed by the agent's CLI now. `session`: reported by its last session. `none`: nothing known yet. */
  source: 'cli' | 'session' | 'none'
  /** Epoch ms of the reading. */
  at?: number
  /** What the modes are: an agent's personas (Kiro, OpenCode) or permission presets. */
  modeSemantics: AgentDefinition['modeSemantics']
}

export interface AgentsApi {
  /** For each known agent id, whether its executable is installed (found on PATH). */
  availability(): Promise<Record<string, boolean>>
  /** Models and modes of an agent key (`kiro`, `kiro:<accountId>`); `refresh` lists them again. */
  options(agentKey: string, refresh?: boolean): Promise<AgentOptionsView>
}

/** Home's "Token spend by folder" card. */
export interface FolderSpendResult {
  entries: FolderSpendEntry[]
  /** The days covered, today included. */
  days: number
  /** When the last background scan of this run ended; null before the first one (the figures are then the cached ones). */
  scannedAt: number | null
  scanning: boolean
  /** False when the profile has no folders: there is nothing to attribute spend to. */
  hasFolders: boolean
}

export interface UsageApi {
  /** The last reads, and a fresh read when `refresh` is set. Empty while the option is off. */
  get(refresh?: boolean): Promise<AccountUsage[]>
  /**
   * Kiro credits spent today and over the last 7 days, from its local session files. Kiro does
   * not expose the credits left; null when no Kiro session data is found.
   */
  kiroSpend(): Promise<CreditSpend | null>
  /**
   * Token spend per folder of a profile (the active one when omitted) over the last days, from the
   * transcripts scanned in the background and cached in the data folder.
   */
  folderSpend(profileId?: string | null): Promise<FolderSpendResult>
  /** A background scan finished; ask `folderSpend` again. */
  onFolderSpendChanged(cb: () => void): () => void
  onChanged(cb: (usage: AccountUsage[]) => void): () => void
  /** Threshold and ceiling crossings, once per window reset, while alerts are on. */
  onAlerts(cb: (alerts: UsageAlert[]) => void): () => void
  /** Shows an OS notification; a click brings the window up on Home. */
  notify(n: { title: string; body: string }): void
  /** The renderer listens for alerts; the ones found before are sent now. */
  ready(): void
  /** A usage notification was clicked. */
  onOpen(cb: () => void): () => void
}

/** The OS family the app runs on; the renderer uses it for shortcut labels and window chrome. */
export type Platform = 'mac' | 'windows' | 'linux'

export function toPlatform(nodePlatform: string): Platform {
  return nodePlatform === 'darwin' ? 'mac' : nodePlatform === 'win32' ? 'windows' : 'linux'
}

/** Appearance preference: follow the OS or force one theme. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** An OS notification about a session; clicking it asks the renderer to open that session. */
export interface SessionNotification {
  title: string
  body: string
  sessionId: string
  /** Which switch in Settings governs it; sessions' own kinds when unset. */
  kind?: NotificationKind
  /** A click opens this screen instead of a session (Slack, Automations). */
  route?: TrayRoute
}

export interface NotificationsApi {
  show(n: SessionNotification): void
  onOpen(cb: (sessionId: string) => void): () => void
}

export interface HubApi {
  platform: Platform
  /** Tells the main process the theme preference so native chrome (title bar, dialogs) follows it. */
  setTheme(theme: ThemePreference): void
  getDefaultCwd(): Promise<string>
  pickFolder(): Promise<string | null>
  /** Opens an http(s) link in the default browser. */
  openExternal(url: string): void
  config: ConfigApi
  sessions: SessionsApi
  history: HistoryApi
  agents: AgentsApi
  usage: UsageApi
  notifications: NotificationsApi
  codeHost: CodeHostApi
  tickets: TicketsApi
  updates: UpdatesApi
  health: HealthApi
  prEvents: PrEventsApi
  links: LinksApi
  slack: SlackApi
  automations: AutomationsApi
  aiReview: AiReviewApi
  continuity: ContinuityApi
  tray: TrayApi
}

/** What Settings knows about Workhub 1 on this machine (see `previewWorkhub1Import`). */
export interface Workhub1Preview {
  available: boolean
  plan?: ImportPlan
  error?: string
  pendingSecrets?: { connectionId: string; name: string }[]
}
