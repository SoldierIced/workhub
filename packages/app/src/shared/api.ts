// Types of the preload bridge (window.hub), shared by main, preload and renderer.
import type { AnalyticsApi } from './analytics-api'
import type { ChatJournal } from './chat-journal'
import type { AgentAvailability, BackgroundSpend, ChromeProfile, GroupChoice, SessionWorktree, SignInTool, WorktreeStatus } from '@workhub/core'
import type { NotificationKind, TrayApi, TrayRoute } from './tray-api'
import type { ProfileEnvApi, SetupApi, SystemNotificationsApi } from './setup-api'
import type { HostsApi } from './hosts-api'
import type { SignInPaneApi } from './sign-in-api'
import type { AgentToolsApi } from './agent-tools-api'
import type {
  AgentQuestion,
  PermissionOption,
  LocalChanges,
  AppOptions,
  AgentCapabilities,
  BudgetStatus,
  ApiAgentSpend,
  CreditSpend,
  FolderSpendEntry,
  SessionCeilings,
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
  SlashCommandInfo,
  ValidationIssue,
  WorkhubConfig
} from '@workhub/core'
import type { AiReviewApi } from './ai-review-api'
import type { AutomationsApi, SlackApi } from './chat-api'
import type { CodeHostApi } from './codehost-api'
import type { ContinuityApi } from './continuity-api'
import type { SessionRequestsApi } from './session-requests-api'
import type { AgentChangesApi } from './agent-changes-api'
import type { HealthApi } from './health-api'
import type { FlowMapsApi } from './flow-maps-api'
import type { BoardsApi } from './boards-api'
import type { PlanApi } from './plan-api'
import type { PlannerApi } from './planner-api'
import type { MetricAlertsApi } from './metric-alerts-api'
import type { ListenApi } from './listen-api'
import type { LinksApi } from './links-api'
import type { PrEventsApi } from './pr-events-api'
import type { TicketsApi } from './tickets-api'
import type { QuitApi } from './quit-api'
import type { UpdatesApi } from './updates-api'
import type { MenuApi, SettingsWindowApi, WindowsApi } from './windows-api'
import type { FilesApi, LocalReviewApi } from './local-review-api'
import type { RemoteApi } from './remote-api'

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
  /** With `loadError`: the problems the file has, one line each (empty when the error says it all). */
  loadIssues?: string[]
  /** The config file's path, so a load error can say which file to fix. */
  configPath?: string
}

export interface ConfigApi {
  get(): Promise<ConfigSnapshot>
  /** Reads the config file again (after the user fixed it); every window gets `config:changed`. */
  reload(): Promise<ConfigSnapshot>
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

/** A permission request or question of the app engine that waits for the user; kept by the main process until answered. */
export interface PendingPermission {
  requestId: string
  title: string
  options: PermissionOption[]
  detail?: string
  questions?: AgentQuestion[]
  /** Epoch ms when the agent asked. */
  at: number
}

/** A session as the renderer sees it. */
export interface SessionView extends Session {
  label: string
  /** The host the session runs on (`wsl:<distro>`); absent on this computer. */
  hostId?: string
  /** The worktree Workhub created for this session; closing it can remove it. */
  worktree?: SessionWorktree
  /** The name the user gave the session (Rename…, `/rename`), kept across restarts; else it shows its agent's name. */
  name?: string
  /** The title the agent gave the conversation (Claude's, an ACP agent's `session_info_update`); a name the user gave wins. */
  agentTitle?: string
  /** What the user first asked, cut to a row's length: only set on what a paired device receives, which has not loaded the chat to name the session by it. */
  firstPrompt?: string
  /** The slash commands the agent reported (built-ins, skills, custom commands); absent until it reports them. */
  commands?: SlashCommandInfo[]
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
  /** Reopened (resumed by its agent session id, or restarted under its old identity), not new. */
  resumed?: boolean
  /** The engine picked while a turn was running: the hand-over waits for the turn to end. */
  pendingMode?: 'app' | 'console'
  /** Epoch ms when `state` last changed (the header's activity timer). */
  stateSince?: number
  /**
   * Permission requests and questions of the chat not answered yet, oldest first. Always present
   * for a chat session (empty when nothing waits), so a window or device that connects later
   * shows them, and one answered elsewhere disappears everywhere.
   */
  pendingPermissions?: PendingPermission[]
  /** Ids of requests answered through Workhub (any window or device), newest last, so a chat can tell "answered elsewhere" from "withdrawn". */
  answeredPermissions?: string[]
  /** The console's terminal UI posted a notification asking for a permission or an answer, and nothing answered it yet. */
  consoleAsking?: boolean
  /** When the console started asking (epoch ms); absent while it does not. */
  consoleAskingSince?: number
  /**
   * Set while the session is working and its agent has sent nothing since this time (epoch ms),
   * for longer than the stuck-session preference: the header offers Stop and Keep waiting.
   */
  stalledSince?: number
  /** Sent to a paired device in place of a session too large for one relay frame: only its id, label and state. */
  tooLarge?: boolean
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
  /** Reasoning effort to start with (Claude); else the account's setting. */
  effort?: string
  /** Session mode to start in: the agent or persona (Kiro, OpenCode), the approval preset (Codex); else the account's default. */
  modeId?: string
  /** An AI reviewer: the agent's most read-only mode, chat only (see `StartSessionRequest.readOnly`). */
  readOnly?: boolean
  /**
   * Start in a new git worktree of the folder's repository (Settings → Profiles → Worktrees), on
   * `branch` (the profile's prefix is added; empty: named after the session). `optional`: start in
   * the folder itself when it is not in a repository, instead of failing.
   */
  worktree?: { branch?: string; optional?: boolean }
  /**
   * The sidebar group the new session goes in (the New session dialog's Group): an existing group
   * by id, or a group by name, made when none has it. Left out, the session starts ungrouped.
   */
  group?: GroupChoice
}

/** A past session, plus its agent and account names for the history screen. */
export interface HistoryItem extends HistoryEntry {
  accountName?: string
  agentName: string
  /** Whether Workhub can open the session again; other agents' sessions are listed only. */
  resumable: boolean
  /** Whether it can also reopen in the terminal (the agent has a console view); true when absent. */
  consoleResumable?: boolean
  /** The automation the session ran for, when it is one (History groups its runs). */
  automationId?: string
  automationName?: string
}

export interface HistoryResult {
  entries: HistoryItem[]
  /** Accounts that could not be listed, with the reason. */
  errors: { account: string; message: string }[]
  /**
   * The accounts whose listing holds every session they still have that the search index may hold
   * (`agentId` NUL `accountId or ''`), so the index drops only their missing sessions.
   */
  listed?: string[]
  /** The accounts with more sessions than the listing went to (`listed`'s keys): History can list further back. */
  truncated?: string[]
  /** Every account the listing tried, failed or not: the index drops the sessions of any other. */
  accounts?: string[]
}

/** A past session found by History search, with the text around the matches (each between `HISTORY_MARK.open` and `.close`; see `snippetParts`). */
export interface HistoryMatch extends HistoryItem {
  /** From the conversation; absent when only the title, prompt or folder matched or the session is not indexed yet. */
  snippet?: string
  /** The title with its matches marked, when it matched. */
  titleSnippet?: string
}

export interface HistorySearchOptions {
  agent?: string
  /** Accounts by id (`''`: an agent's default folder). */
  accountIds?: string[]
  /** Sessions run in this folder or below. */
  cwdPrefix?: string
  /** Sessions run in one of these folders or below (with `cwdPrefix`, any of them). */
  cwdPrefixes?: string[]
  /** Only these sessions (`agentId:agentSessionId`): the screen's own filters, applied inside the search. */
  keys?: string[]
  /** From a paired device: the profile whose folders the search is limited to (the desktop sets the folders itself). */
  profileId?: string | null
  /** Epoch ms bounds on the session's last change. */
  since?: number
  until?: number
  limit?: number
  /** `nextCursor` of the previous page. */
  cursor?: string
}

/** How far History's full-text index is: `indexed` of `total` sessions are up to date. */
export interface HistoryIndexProgress {
  indexing: boolean
  indexed: number
  total: number
}

export interface HistorySearchResult {
  /** Index matches first, best first, then the sessions only the plain search matches. */
  entries: HistoryMatch[]
  /** Matches in all, on every page. */
  total: number
  /** Position of the first entry in that order. */
  start: number
  errors: { account: string; message: string }[]
  progress: HistoryIndexProgress
  nextCursor?: string
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

/** Marks the error of a prompt dropped before it was sent because its session was interrupted. */
export const PROMPT_WITHDRAWN = 'workhub:prompt-withdrawn'

/** The chat as Markdown plus the session's name (for the file name); the path is chosen in main's save dialog. */
export interface ConversationExport {
  name: string
  markdown: string
}

export type ConversationExportResult = { ok: true; path: string } | { ok: false; canceled: true } | { ok: false; canceled: false; error: string }

export interface SessionsApi {
  list(): Promise<SessionView[]>
  /**
   * The chat main keeps for a live session (bounded), so a window that loads later rebuilds it:
   * live messages numbered at or below its `seq` are already in it. Desktop windows only.
   */
  journal(id: string): Promise<ChatJournal | null>
  /** The main window follows session events now: the sessions open at the last quit are reopened then. */
  ready(): void
  /** Returns at once with the session in `starting`; progress arrives through onChanged. */
  start(input: StartSessionInput): Promise<SessionView>
  /**
   * Reopens a closed session by its identity (the sidebar): the open one when it already runs, and
   * one start per identity even when a Slack wake opens it at the same moment.
   */
  reopen(identity: string, input: StartSessionInput): Promise<SessionView>
  /**
   * Runs one prompt turn. On agents that take no input mid-turn it waits for the session's prompt
   * in flight; one still waiting when the session is interrupted fails with `PROMPT_WITHDRAWN`.
   * With a `token`, `onPromptStarted` reports when it actually goes out.
   */
  prompt(id: string, text: string, images?: ImageInput[], token?: number): Promise<string>
  /** Takes back a prompt sent with `token` that still waits for its turn; false once it went out. */
  withdrawPrompt(id: string, token: number): Promise<boolean>
  /** Answers the "no output" notice with Keep waiting: the silence counts again from now. */
  keepWaiting(id: string): Promise<void>
  /**
   * A prompt sent from this window with a token went out to the agent. `seq`: the number main's
   * chat journal gives it, so the broadcast of the same prompt is not shown again here.
   */
  onPromptStarted(cb: (id: string, token: number, seq?: number) => void): () => void
  /**
   * A prompt sent from this window with a token settled. It travels with the session's events, so
   * it arrives after the turn's last message; `prompt()`'s own answer can overtake them.
   */
  onPromptSettled(cb: (id: string, token: number) => void): () => void
  cancel(id: string): Promise<void>
  stop(id: string): Promise<void>
  /** `answers` answer a question (question text to answer); see `AgentRuntime.respondPermission`. */
  respondPermission(id: string, requestId: string, optionId: string | null, answers?: Record<string, string>): void
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /**
   * Switches what the session shows; app and console hand the same agent session over. While a
   * turn runs the hand-over waits for its end (`pendingMode`) unless `now` is set.
   */
  setMode(id: string, mode: SessionMode, options?: SetModeOptions): Promise<void>
  /** Stops the session if it runs and drops it from the open sessions (it stays in History). */
  close(id: string): Promise<void>
  /**
   * Closes the session and removes the worktree Workhub created for it (its branch stays). Without
   * `force`, a worktree with uncommitted changes or unpushed commits is kept, the session stays
   * open and the answer says what it holds.
   */
  closeRemovingWorktree(id: string, force: boolean): Promise<{ ok: true } | { ok: false; blocked: WorktreeStatus }>
  setModel(id: string, modelId: string | null): Promise<void>
  /** Switches the session's agent mode (an id of `availableModes`). */
  setAgentMode(id: string, modeId: string): Promise<void>
  /**
   * Runs a command that Claude Code only handles in its terminal UI (`/login`, `/remote-control`): the
   * session moves to its console and the command is typed there. False when the console did not come
   * up in time.
   */
  /**
   * Opens a Claude session's Terminal view and types a terminal-bound slash command there (`/login`,
   * `/remote-control`, `/plugin`, ...). Main validates it against the session's own command list.
   */
  typeInConsole(id: string, command: string): Promise<boolean>
  mcp(id: string, action: 'refresh' | 'reconnect' | 'enable' | 'disable', server?: string): void
  /** One subagent's conversation (prompt, steps, answer); null when the agent keeps none. */
  subagent(id: string, subagentId: string): Promise<SubagentConversation | null>
  /** Shows a file the session's agent touched in the file manager; false when it is outside the session's folder or missing. */
  revealFile(id: string, path: string): Promise<boolean>
  /**
   * Uncommitted changes in the session's folder: its repository, or each repository right inside
   * a folder of repositories. Null when the session is unknown or the folder holds no repository.
   */
  localChanges(id: string): Promise<LocalChanges | null>
  /**
   * The files of the session's folder (relative paths) for the composer's `@` menu: its repository's
   * tracked and not-ignored files, or a bounded walk outside a repository. `truncated`: cut at the cap.
   * Not available to paired phones.
   */
  files(id: string): Promise<{ files: string[]; truncated: boolean }>
  /** Names the session (empty or null: back to its agent's name); stored by the session's identity. */
  rename(id: string, name: string | null): Promise<void>
  /** Saves a conversation as a Markdown file the user picks in a save dialog (desktop windows only). */
  exportConversation(conversation: ConversationExport): Promise<ConversationExportResult>
  /** `seq`: the event's number in main's chat journal, when it belongs to the chat (see `journal`). */
  onEvent(cb: (e: AgentEvent, seq?: number) => void): () => void
  onChanged(cb: (s: SessionView) => void): () => void
  /** A finished session left the list (an automation replaced it). */
  onRemoved(cb: (id: string) => void): () => void
  /** Earlier messages of a resumed session, to show before the new turns. */
  onReplay(cb: (id: string, messages: HistoryMessage[], seq?: number) => void): () => void
}

export interface HistoryApi {
  list(): Promise<HistoryResult>
  /** Lists again, a page of sessions further back for every account that has more. */
  listOlder(): Promise<HistoryResult>
  /** Full-text search of past sessions (titles, prompts, folders and conversations), with snippets. */
  search(query: string, options?: HistorySearchOptions): Promise<HistorySearchResult>
  /** How far the search index is. */
  indexProgress(): Promise<HistoryIndexProgress>
  /** The index made progress (or finished). */
  onIndexProgress(cb: (progress: HistoryIndexProgress) => void): () => void
  /** The past sessions with these agent session ids (every account's copy): names closed sidebar rows. */
  find(keys: string[]): Promise<HistoryItem[]>
  /** Opens a session's folder in the file manager; false when it is not an existing folder. */
  revealFolder(path: string): Promise<boolean>
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
  /**
   * For each known agent id, whether its executable is installed (found on PATH); for a profile
   * that runs in WSL, what that host offers (`pending` while it connects, `unsupported` there).
   */
  availability(): Promise<Record<string, boolean>>
  availability(profileId: string | null): Promise<Record<string, AgentAvailability>>
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
  /** The model runs Workhub started by itself over the same days (Slack reads, Listen summaries), every profile together. */
  background?: BackgroundSpend
}

export interface UsageApi {
  /** The last reads, and a fresh read when `refresh` is set. Empty while the option is off. */
  get(refresh?: boolean): Promise<AccountUsage[]>
  /**
   * The refresh button: reads every account again, skipping the readers' caches (Kiro's 15-minute
   * spacing too). A second press within 30 s returns the previous result.
   */
  refreshNow(): Promise<AccountUsage[]>
  /**
   * Kiro credits spent today and over the last 7 days, from its local session files. Kiro does
   * not expose the credits left; null when no Kiro session data is found.
   */
  kiroSpend(): Promise<CreditSpend | null>
  /**
   * Spend of agents billed by API key (OpenCode, Codex or Claude on an API key, ACP agents that
   * report a cost), per agent over the last 7 days, in USD. Empty when none spent anything.
   */
  apiSpend(): Promise<ApiAgentSpend[]>
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
  /** Each session's own ceilings (overriding its account's), by session identity. */
  sessionBudgets(): Promise<Record<string, SessionCeilings>>
  /** Sets a session's own ceilings; null or an empty map goes back to the account's. */
  setSessionBudget(identity: string, ceilings: SessionCeilings | null): Promise<void>
  onSessionBudgetsChanged(cb: (budgets: Record<string, SessionCeilings>) => void): () => void
}

/** The OS family the app runs on; the renderer uses it for shortcut labels and window chrome. */
export type Platform = 'mac' | 'windows' | 'linux'

export function toPlatform(nodePlatform: string): Platform {
  return nodePlatform === 'darwin' ? 'mac' : nodePlatform === 'win32' ? 'windows' : 'linux'
}

/** Appearance preference: follow the OS or force one theme. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** Colors for the native window controls overlay: CSS hex colors. */
export interface ChromeColors {
  color: string
  symbolColor: string
}

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

/** A folder of a profile, as the sidebar's folder list shows it. */
export interface WorkspaceFolder {
  path: string
  name: string
  /** One of the profile's own folders (the folders inside it follow it). */
  root: boolean
}

export interface HubApi {
  platform: Platform
  /**
   * Tells the main process the theme preference so native chrome (title bar, dialogs) follows it,
   * with the colors the window controls overlay (Windows, Linux) should take: the app's background
   * and text, which a terminal theme applied to the app changes beyond light/dark.
   */
  setTheme(theme: ThemePreference, chrome?: ChromeColors): void
  getDefaultCwd(): Promise<string>
  pickFolder(): Promise<string | null>
  /** The profile's folders and the folders inside each (Workhub 1's "All folders"); empty without a profile. */
  profileFolders(profileId: string | null): Promise<WorkspaceFolder[]>
  /**
   * Opens an http(s) link the way the profile chose (its browser or Chrome profile), or in the
   * Slack app for a Slack link. Without a profile, the one the link belongs to, else the active one.
   */
  openExternal(url: string, profileId?: string | null): void
  /** The profiles of a Chrome app (default: Google Chrome), read from its data folder; empty when not found or off macOS. */
  chromeProfiles(app?: string): Promise<ChromeProfile[]>
  config: ConfigApi
  sessions: SessionsApi
  history: HistoryApi
  agents: AgentsApi
  usage: UsageApi
  notifications: NotificationsApi
  codeHost: CodeHostApi
  tickets: TicketsApi
  updates: UpdatesApi
  quit: QuitApi
  health: HealthApi
  flowMaps: FlowMapsApi
  boards: BoardsApi
  plan: PlanApi
  planner: PlannerApi
  metricAlerts: MetricAlertsApi
  listen: ListenApi
  prEvents: PrEventsApi
  links: LinksApi
  slack: SlackApi
  automations: AutomationsApi
  aiReview: AiReviewApi
  continuity: ContinuityApi
  /** What agents asked of other sessions, waiting for the user (never offered to paired devices). */
  sessionRequests: SessionRequestsApi
  /** What agents changed of automations, flow maps, milestones and inbox items, for Keep or Revert on Home (never offered to paired devices). */
  agentChanges: AgentChangesApi
  localReview: LocalReviewApi
  files: FilesApi
  tray: TrayApi
  windows: WindowsApi
  menu: MenuApi
  settings: SettingsWindowApi
  setup: SetupApi
  /** Where a profile's sessions run: WSL distributions and the status of each host (Settings → Profiles; never offered to paired devices). */
  hosts: HostsApi
  /**
   * Opens the sign-in window for a tool of the fixed list (`SIGN_IN_TOOLS`), with a Claude
   * account's config folder when `accountId` names one. Main runs the tool's own command; false
   * when it refused (unknown tool or account). Never offered to paired devices.
   */
  signIn(tool: SignInTool, accountId?: string): Promise<boolean>
  /** The sign-in window's own calls. */
  signInPane: SignInPaneApi
  /** Workhub's MCP server and skills for agents (Settings → Agents). */
  agentTools: AgentToolsApi
  profileEnv: ProfileEnvApi
  /** The same, for an agent account's environment (ids are account ids). */
  accountEnv: ProfileEnvApi
  systemNotifications: SystemNotificationsApi
  /** Settings → Remote access: pairing phones and what they may do. */
  remote: RemoteApi
  diagnostics: DiagnosticsApi
  storage: StorageApi
  analytics: AnalyticsApi
}

/** Where the app keeps its state (Settings → Advanced → Data). */
/** What an export of diagnostics did: `canceled` when the person closed the folder picker. */
export type DiagnosticsExportResult = { ok: true; folder: string; files: number } | { ok: false; canceled: boolean; error?: string }

export interface StorageInfo {
  /** The database file (`workhub.db` in the data folder). */
  path: string
  /** Its size on disk in bytes, write-ahead log included. */
  sizeBytes: number
  /** The folder of the daily copies. */
  backupFolder: string
  /** The newest copy, if any. */
  lastBackup: string | null
  /** Set when a damaged database was moved aside and a fresh one started (see troubleshooting). */
  recovered: { movedTo: string; at: number; reason: string } | null
}

export type StorageBackupResult = { ok: true; path: string } | { ok: false; error: string }

/** A group of tables in the database: usage detail (turns, sessions, links, tags), usage summaries (`turns_daily`), History's search index, events (pull request and ticket timelines, automation runs) and app state. */
export type StorageGroupName = 'usageDetail' | 'usageSummaries' | 'historyIndex' | 'events' | 'pullRequests' | 'state'

/** What the data takes in the database (Settings → Advanced → Data). */
export interface StorageUsage {
  groups: { group: StorageGroupName; rows: number; bytes: number | null }[]
  /** Space deleted rows left behind, which Compact now gives back; null when not known. */
  freeBytes: number | null
  /** The file and its write-ahead log. */
  fileBytes: number
  /** Usage detail, events and automation runs are kept this many months (then daily summaries). */
  retentionMonths: number
  /** When the maintenance last ran; null before its first run. */
  lastRunAt: number | null
}

export type StorageCompactResult = { ok: true; beforeBytes: number; afterBytes: number } | { ok: false; error: string }

/** A copy the database can be restored from: a backup, or the file an earlier restore set aside. */
export interface StorageRestorePoint {
  path: string
  kind: 'automatic' | 'manual' | 'beforeRestore'
  /** When the copy was last written (epoch ms). */
  at: number
  sizeBytes: number
}

/**
 * A restore asked for: `ok` means the copy passed its checks and the app is restarting to swap it in.
 * `reason` says why it was refused: not one of the listed copies, unreadable, damaged, or made by a
 * newer Workhub.
 */
export type StorageRestoreResult = { ok: true } | { ok: false; reason: 'unknown' | 'unreadable' | 'damaged' | 'newerSchema' | 'failed'; error: string }

export interface StorageApi {
  info(): Promise<StorageInfo>
  /** Copies the database now, to a new `workhub-YYYY-MM-DD-HHmm.db` (the daily copy is kept apart). */
  backup(): Promise<StorageBackupResult>
  /** Opens the backups folder in the file manager. */
  revealBackups(): void
  /** Rows and approximate size per group of data, and the retention. */
  usage(): Promise<StorageUsage>
  /** Runs the retention now, then VACUUM: the file shrinks to what it holds. */
  compact(): Promise<StorageCompactResult>
  /** The backups and the copies earlier restores set aside, newest first. */
  restorePoints(): Promise<StorageRestorePoint[]>
  /** Checks the copy, then restarts the app and swaps it in (the current database kept as a copy). */
  restore(path: string): Promise<StorageRestoreResult>
}

/**
 * What a renderer tells the main log: long tasks it saw (summed over a few seconds) and errors.
 * Durations, counts and error messages only: never prompts, messages or settings.
 */
export type RendererReport =
  | { kind: 'longtask'; count: number; maxMs: number; totalMs: number }
  | { kind: 'error' | 'rejection'; message: string; source?: string }

export interface DiagnosticsApi {
  /** Adds a renderer report to the main log (throttled there too). */
  report(report: RendererReport): void
  /** Shows the log file in the file manager. */
  revealLogs(): void
  /** Asks for a folder and writes the diagnostics there (Help → Export diagnostics…). */
  exportDiagnostics(): Promise<DiagnosticsExportResult>
}
