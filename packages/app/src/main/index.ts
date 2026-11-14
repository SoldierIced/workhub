import { app, autoUpdater as nativeUpdater, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, session, shell, type BrowserWindowConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AcpRuntime, agentAvailability, discoverKiroOptions } from '@workhub/adapters/agent-acp'
import { CLAUDE_PERMISSION_MODES, ClaudeNativeRuntime, ClaudePlanUsageReader, ClaudeSessionHistory, discoverClaudeOptions } from '@workhub/adapters/agent-claude-native'
import { DemoChatSource, SlackAgentChatSource, SlackTrackingHook } from '@workhub/adapters/chat-slack'
import { ListenSummarizer } from '@workhub/adapters/listen-summary'
import { JsonConfigStore } from '@workhub/adapters/config-json'
import { SafeStorageSecretStore } from '@workhub/adapters/secrets-electron'
import { TerminalRuntime } from '@workhub/adapters/agent-terminal'
import { createCliRunner } from '@workhub/adapters/cli'
import { augmentedPath, readLoginShellPath } from '@workhub/adapters/login-path'
import { readNotificationPermission } from '@workhub/adapters/notification-permission'
import { ClaudeTranscriptReader, copyClaudeSession, readClaudeHandoffFacts } from '@workhub/adapters/transcript-claude'
import { CodexPlanUsageReader, CodexSessionHistory, CodexTranscriptReader } from '@workhub/adapters/transcript-codex'
import { KiroPlanUsageReader, KiroSessionHistory, KiroTranscriptReader, readKiroCreditEntries } from '@workhub/adapters/transcript-kiro'
import { GitReview, LocalChanges } from '@workhub/adapters/git-review'
import { GitWorktrees } from '@workhub/adapters/git-worktree'
import { JsonPrEventStore } from '@workhub/adapters/pr-events-json'
import { DemoCalendarSource, IcsCalendarSource } from '@workhub/adapters/calendar-ics'
import { OpenCodeSessionHistory, OpenCodeTranscriptReader } from '@workhub/adapters/transcript-opencode'
import { readKeychainItem, readWorkhub1Settings } from '@workhub/adapters/workhub1-import'
import {
  alertRulesOf,
  appOptions,
  canonicalUrl,
  creditSpend,
  CONNECTION_PROVIDERS,
  ConfigurationService,
  EMPTY_FACTS,
  factsFromHistory,
  knownAgents,
  placeBeside,
  hasUnread,
  historyOfSessions,
  isNotificationKind,
  importWorkhub1Secrets,
  pendingWorkhub1Secrets,
  pauseUntil,
  planWorkhub1Import,
  fillDefaultFolders,
  fillWorkhub1FolderFlags,
  linkAutomationHistory,
  type Workhub1Settings,
  TRAY_ROUTES,
  resolveEffectiveAgents,
  startOfLocalDay,
  usageAccountKey,
  validateConfig,
  type FlowAlert,
  type MetricAlert,
  type HealthAlert,
  type HealthAlertChannel,
  quietNow,
  moduleScreens,
  type FlowTraceSort,
  type HealthDetailRequest,
  type CreditSpend,
  type Result,
  type Workhub1SecretResult,
  type TicketChange,
  buildTrayPopover,
  parseTrayAction,
  stampSince,
  type SinceEntry,
  type TrayAction,
  type TrayPrEvent,
  type TrayRoute,
  type TraySession,
  type TrayState,
  sessionIdentity,
  setSessionCeiling,
  type SessionCeilings,
  type WorkhubConfig
} from '@workhub/core'
import type { AccountUsage, ConfigSnapshot, SessionMode, SessionNotification, StartSessionInput, ThemePreference, UsageAlert } from '../shared/api'
import type { PrNotification } from '../shared/pr-events-api'
import type { SlackSnapshot } from '../shared/chat-api'
import { TRAY_POPOVER_HASH, type TrayRendererState } from '../shared/tray-api'
import type { PullRequestWindowTab } from '../shared/codehost-api'
import { Notifier } from './notifier'
import { TrayService } from './tray'
import { TrayPopover } from './tray-popover'
import { TrayToday } from './tray-today'
import { flowAlertWords, healthAlertWords, isLocale, metricAlertWords, trayText } from './tray-text'
import { AppBadge, attentionBadgeCount } from './app-badge'
import { profileWorkspaces } from './workspaces'
import { startPlaced } from './session-placement'
import { NotificationPermissionCheck } from './notification-permission'
import { testNotification } from './notification-test'
import { FlowAlertWatcher, HealthWatcher, TicketWatcher, ticketSummaryWords } from './watchers'
import type { Locale } from '../renderer/i18n/translate'
import { AutomationService } from './automations'
import { registerChatIpc } from './chat-ipc'
import { AgentOptionsService, listableAgentTargets, runsKiroCli } from './agent-options'
import { agentKeyBudget, AgentUsageService, DemoUsageProvider, usageAccounts } from './agent-usage'
import { AgentReviewService, registerAgentReviewIpc, reviewLoopWindows } from './agent-review'
import { AiReviewService, registerAiReviewIpc, reviewBudgetGate } from './ai-review'
import { claudeConfigDirOf } from './claude-accounts'
import { registerListenIpc } from './listen-ipc'
import { CodeHostService, registerCodeHostIpc } from './codehost'
import { ContinuityService, type ContinuityDeps } from './continuity'
import { HealthService } from './health-service'
import { guardIpc, isTrustedRendererUrl } from './ipc-guard'
import { timeIpc } from './ipc-timing'
import { isRemoteSender, pageHistory, promptFromDevice, recordIpc, RemoteHub, RemoteService, registerRemoteIpc, readRemoteFile, touchedPaths, type RemoteState } from './remote'
import { rendererReporter, startDiagnostics } from './diagnostics'
import { permissionAllowed } from './permissions'
import { listAllHistory } from './history'
import { RecentCall } from './recent-call'
import { PrEventService, registerPrEventsIpc } from './pr-events-service'
import { SessionDriver } from './session-driver'
import { OwnerStarts } from './owner-starts'
import { resolveChoice, SessionManager, ticketPrefixes } from './session-manager'
import { registerLinksIpc } from './links'
import { LocalReviewService, opensAsProgram, registerLocalReviewIpc } from './local-review'
import { CONTROL_ENV_KEYS, controlEnv, controlSocketPath, newControlToken, startControlServer, startLoopbackControlServer, usesLoopbackControl, type ControlDeps, type ControlEndpoint } from './control-server'
import { createAutomationControl } from './automation-control'
import { createPlanControl, resolveControlProfile } from './plan-control'
import { FLOW_HISTORY_FOLDER, FlowHistoryStore } from './flow-history'
import { FLOW_MAPS_FOLDER, saveFlowMap } from './flow-maps'
import { registerFlowMapsIpc } from './flow-maps-ipc'
import { DemoMetricSource, HealthMetricSource, MetricAlertService, ProductMetricSource, type MetricAlertsState } from './metric-alerts'
import { registerMetricAlertsIpc } from './metric-alerts-ipc'
import { registerFileViewerIpc } from './file-viewer'
import { SlackWatcherService } from './slack-watcher'
import { StateFile } from './state-file'
import { registerTicketIpc } from './tickets'
import { TicketService } from './tickets-service'
import { spendSources, TokenSpendService } from './token-spend'
import { ApiSpendService, CostLedger, spendAgentId, type CostLedgerState } from './api-spend'
import { UpdateService } from './updates'
import { readUpdatePromptState, shouldPromptUpdate, type UpdatePromptState } from './update-prompt'
import { buildAppMenuTemplate } from './app-menu'
import { SessionNames } from './session-names'
import { OpenSessions, type SavedOpenSessions } from './open-sessions'
import { boundsOnScreen, SessionWindows, type SavedSessionWindows, type WindowBounds } from './session-windows'
import { SettingsWindow, settingsSectionArg, type SavedSettingsWindow } from './settings-window'
import { chromeColorsFrom, type ChromeColors } from './chrome-colors'
import { broadcastingConfigStore } from './config-broadcast'
import type { MenuCommand, SessionSnapshot } from '../shared/windows-api'
import { createLinkService } from './link-service'
import { listChromeProfiles, systemLinkDeps } from './link-system'
import { accountSessionEnv, profileSessionEnv, saveAccountEnv, saveProfileEnv, storedAccountEnvNames, storedProfileEnvNames } from './profile-env'
import { showMainOnActivate } from './activation'
import { AgentToolsService, registerAgentToolsIpc, WORKHUB_MCP_SCRIPT, workhubMcpLaunch } from './agent-tools'
import { SetupInstaller } from './setup-install'
import { registerSetupInstallIpc } from './setup-ipc'
import { probe, SetupService } from './setup-service'
import { CalendarService } from './calendar-service'
import { CalendarStateStore, CalendarWatcher } from './calendar-watcher'
import { demoScenario, seedScenarioConfig, seedScenarioState } from './demo-scenario'
import { BriefService } from './plan-briefs'
import { meetingReminderWords, planView, registerPlanIpc } from './plan-ipc'
import { PlannerService, type PlannerState } from './planner-service'
import { addControlInboxItems, registerPlannerIpc } from './planner-ipc'
import { expandHome } from './automations'
import { gatePrompt, owningProfile, productCalendarEvents, ticketsInProgress, type CalendarState, type DueAction } from '@workhub/core'
import type { SetupPage } from '../shared/setup-api'

// The control endpoint of a Workhub this one was started from (a dev run launched from a session of
// the installed app) must not leak into this app's processes: sessions get this app's own endpoint
// or none, never the parent's. Dropped before anything spawns.
for (const key of CONTROL_ENV_KEYS) delete process.env[key]

// Dev layout: packages/app/out/main -> packages/app. A packaged app finds its extra resources
// (the Claude bridge) under process.resourcesPath instead.
const appRoot = resolve(__dirname, '../..')
const repoRoot = resolve(appRoot, '../..')

/**
 * Where config.json and secrets.json live. WORKHUB_DATA_DIR wins; a dev run uses a folder inside
 * the repo (git-ignored) so it never touches a real install's data; a packaged app uses userData.
 */
const dataDir = process.env['WORKHUB_DATA_DIR']
  ? resolve(process.env['WORKHUB_DATA_DIR'])
  : app.isPackaged
    ? app.getPath('userData')
    : join(appRoot, '.dev-data')

if (!app.isPackaged) {
  // Keep Chromium's own files and the safeStorage key apart from any installed Workhub.
  app.setName('Workhub 2 Dev')
  app.setPath('userData', join(dataDir, 'electron'))
}

// One instance per data folder (Electron keys the lock on userData): launching the app again (a
// Start menu entry, a desktop launcher) brings the running one up, which matters once closing the
// window only hides it in the menu bar / notification area.
const firstInstance = app.requestSingleInstanceLock()
if (!firstInstance) app.quit()
else app.on('second-instance', () => showMain())

// Always on: a rotated log in <dataDir>/logs with errors, event-loop stalls and slow IPC (Help → Reveal Logs).
const diagnostics = startDiagnostics(dataDir, { version: app.getVersion(), packaged: app.isPackaged })

/** Help → Reveal Logs: the log file selected in the file manager, written up to now. */
function revealLogs(): void {
  diagnostics.flush()
  shell.showItemInFolder(diagnostics.logPath)
}

/** Every window's handlers, reachable by a paired device too (Settings → Remote access); filled by registerIpc. */
const recordedIpc = recordIpc(timeIpc(guardIpc(ipcMain, (url) => isTrustedRendererUrl(url, rendererOrigin)), diagnostics))
const remoteHub = new RemoteHub({
  handlers: recordedIpc.handlers,
  profileFolders: async (profileId) => {
    const config = await configuration.current()
    const profile = profileId ? config.profiles.find((p) => p.id === profileId) : undefined
    return profile ? (await profileWorkspaces(profile, homedir())).map((f) => f.path) : []
  },
  log: diagnostics.log
})
/** Tells every window, and every paired device, that the config changed. */
const configChanged = () => {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('config:changed'))
  remoteHub.tap('config:changed', [])
}
// Every write tells every window (`config:changed`): a change in the Settings window shows in the main window.
const configStore = broadcastingConfigStore(new JsonConfigStore(join(dataDir, 'config.json')), configChanged)
const secrets = new SafeStorageSecretStore(join(dataDir, 'secrets.json'), safeStorage)
const configuration = new ConfigurationService(configStore, secrets)
// WORKHUB_DEMO_SCENARIO=team-lead (`npm run demo`): the milestones, inbox and metric alerts of the scenario are written before
// the services read their state files; its profile is saved once the app is ready (see below). Files that exist are kept.
const scenario = demoScenario()
if (scenario) seedScenarioState(dataDir)
let loadError: string | undefined
// WORKHUB_DEMO_CODEHOST=1 reads synthetic pull requests instead of a real host (screenshots, demos).
// The demo moves on one step at a time (`prEvents.demoAdvance`) so pull request events can be seen.
let demoPrStep = 0
const codeHost = new CodeHostService(() => configuration.current(), { demo: process.env['WORKHUB_DEMO_CODEHOST'] === '1', demoStep: () => demoPrStep })
const prEvents = new PrEventService({
  source: codeHost,
  store: new JsonPrEventStore(join(dataDir, 'pr-events.json')),
  config: () => configuration.current(),
  emit: (batch) => send('prEvents:events', batch),
  demo: process.env['WORKHUB_DEMO_CODEHOST'] === '1' ? { advance: () => ++demoPrStep } : undefined
})
// WORKHUB_DEMO_HEALTH=1 serves synthetic environments, so Health can be shown without a cluster.
// Flow-map measures kept hour by hour for a week, so maps draw from disk and read only new hours.
const flowHistory = new FlowHistoryStore(join(dataDir, FLOW_HISTORY_FOLDER))
flowHistory.prune()
const health = new HealthService({ configuration, secrets, demo: process.env['WORKHUB_DEMO_HEALTH'] === '1', flowMapsDir: join(dataDir, FLOW_MAPS_FOLDER), flowHistory })
// WORKHUB_DEMO_TICKETS=1 serves synthetic tickets, so the UI can be shown without credentials.
const ticketService = new TicketService(configuration, secrets, process.env['WORKHUB_DEMO_TICKETS'] === '1', undefined, scenario ?? undefined)
// WORKHUB_DEMO_CALENDAR=1 serves synthetic meetings around now, so Plan can be shown without a calendar address.
const calendar = new CalendarService({ configuration, secrets, source: new IcsCalendarSource(), demo: process.env['WORKHUB_DEMO_CALENDAR'] === '1' ? new DemoCalendarSource(Date.now, scenario ? productCalendarEvents : undefined) : null })

let win: BrowserWindow | null = null
/** What session and sub-agent windows follow too: the sessions' live state and what their screens show. */
const SHARED_CHANNELS = new Set(['session:event', 'session:changed', 'session:removed', 'session:replay', 'automations:prompted', 'automations:turnEnded', 'aiReview:changed', 'agentReview:changed', 'usage:changed'])
const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  if (SHARED_CHANNELS.has(channel)) sessionWindows.broadcastShared(channel, args)
  settingsWindow.send(channel, args)
  remoteHub.tap(channel, args)
}
// Sessions in windows of their own ("Open in New Window"); the session's runtime stays here, shared.
const sessionWindows = new SessionWindows({
  create: (hash, size, bounds) =>
    createAuxWindow(hash, 'Workhub 2', size, boundsOnScreen(bounds, screen.getAllDisplays().map((d) => d.workArea), size)),
  mainWindow: () => (win && !win.isDestroyed() ? win : null),
  showMain: () => showMain(),
  exists: (id) => sessions.list().some((s) => s.id === id),
  identityOf: (id) => {
    const view = sessions.list().find((s) => s.id === id)
    return view ? sessionIdentity(view) : undefined
  },
  store: new StateFile<SavedSessionWindows>(join(dataDir, 'session-windows.json'), 500)
})
// Settings in a window of its own, one at a time (⌘,, the gear button, the menu bar icon, setup fixes).
const settingsWindow = new SettingsWindow({
  create: (hash, size, bounds) => createAuxWindow(hash, 'Workhub 2', size, bounds),
  screens: () => screen.getAllDisplays().map((d) => d.workArea),
  quitting: () => allowWindowClose,
  store: new StateFile<SavedSettingsWindow>(join(dataDir, 'settings-window.json'), 500)
})

// Menu bar / notification area icon (tray.ts) and what it shows that main does not keep elsewhere.
let trayService: TrayService | null = null
/** The window a click on the icon opens (macOS, Windows); Linux keeps the native menu. */
let trayPopover: TrayPopover | null = null
/** Since when each session shows its state (the popover's times). */
let sessionSince = new Map<string, SinceEntry>()
let trayLocale: Locale = 'en'
/** True once the renderer reported its language; until then the tray follows the system locale. */
let trayLocaleFromRenderer = false
/** The sessions with their unseen flags, as the renderer last reported them. */
let rendererSessions: TraySession[] | null = null
let lastSlack: SlackSnapshot | null = null
const recentPrEvents: TrayPrEvent[] = []
/** Options read synchronously (closing the window); refreshed on every options save and tray refresh. */
let keepInTray = true
const scheduleTray = () => trayService?.schedule()

/** The number of sessions that need a look, on the app icon (Dock, taskbar button, launcher). */
const appBadge = new AppBadge({
  platform: process.platform,
  setBadgeCount: (count) => void app.setBadgeCount(count),
  setOverlay: (bitmap, description) => {
    if (!win || win.isDestroyed()) return
    win.setOverlayIcon(bitmap ? nativeImage.createFromBitmap(bitmap.data, { width: bitmap.size, height: bitmap.size, scaleFactor: 2 }) : null, description)
  },
  describe: (count) => trayText(trayLocale).tn('tray.tooltip.attention', count)
})

/** Whether macOS shows this app's notifications (Settings warns when it does not). */
const notificationPermission = new NotificationPermissionCheck({
  platform: process.platform,
  supported: () => Notification.isSupported(),
  readPrefs: () => readNotificationPermission({ execPath: process.execPath }),
  createProbe: () => new Notification({ title: app.getName(), silent: true })
})

/** Every OS notification goes through here: per-kind switches and "Pause notifications". */
const notifier = new Notifier({
  options: async () => appOptions(await configuration.current()),
  supported: () => Notification.isSupported(),
  create: (content) => notificationPermission.observe(new Notification(content)),
  logPath: process.env['WORKHUB_NOTIFICATION_LOG'],
  onShown: scheduleTray,
  // Paired phones get the same notification, over their channel or by push (Settings → Remote access).
  mirror: (n) => remoteService.notify(n),
  // Quiet hours (Settings → Alerts): the profile the notification is about, else the active one.
  quiet: async (kind, profileId, now) => {
    const config = await configuration.current()
    const id = profileId ?? config.activeProfileId
    return quietNow(kind, config.profiles.find((p) => p.id === id)?.alerts?.quietHours, now)
  }
})

/** Remote access: this desktop's identity, the relay connection and the paired devices (Settings → Remote access). */
const remoteService = new RemoteService({
  store: new StateFile<RemoteState>(join(dataDir, 'remote.json'), 200),
  secrets,
  hub: remoteHub,
  connect: (url) => new WebSocket(url),
  defaultName: () => hostname().replace(/\.local$/, ''),
  onChanged: (status) => send('remote:changed', status),
  log: diagnostics.log
})

// Workhub 1's Agent SDK bridge, run with Electron's own Node. Packaged: staged into the resources
// folder with its node_modules (scripts/stage-bridge.mjs); dev: straight from the adapters source.
const bridgeDir = app.isPackaged ? join(process.resourcesPath, 'bridge') : join(repoRoot, 'packages', 'adapters', 'src', 'agent-claude-native', 'bridge')

/**
 * The PATH agents and terminals start with: the login shell's (read once, in the background), so an
 * app opened from the Finder or the Dock finds the same CLIs as a terminal does. Until it is read,
 * and when it cannot be, the inherited PATH plus the usual CLI folders. Windows: unchanged.
 */
let cliPath = augmentedPath({ platform: process.platform, inherited: process.env['PATH'], loginShell: null })
void readLoginShellPath().then((loginShell) => {
  if (loginShell) cliPath = augmentedPath({ platform: process.platform, inherited: process.env['PATH'], loginShell })
})
const sessionPath = (): string | undefined => (process.platform === 'win32' ? undefined : cliPath)
// The Claude Code binary the Agent SDK ships with: the terminal's `claude` when the user has none.
const bundledClaudeDir = join(
  app.isPackaged ? join(bridgeDir, 'node_modules') : join(repoRoot, 'node_modules'),
  '@anthropic-ai',
  `claude-agent-sdk-${process.platform}-${process.arch}`
)
const fallbackPath = existsSync(bundledClaudeDir) ? [bundledClaudeDir] : []
const terminal = new TerminalRuntime({ path: sessionPath, fallbackPath })
// Agent adapters installed with the app (claude-agent-acp) are found through PATH.
const extraPath = app.isPackaged
  ? [join(bridgeDir, 'node_modules', '.bin')]
  : [join(repoRoot, 'node_modules', '.bin'), join(appRoot, 'node_modules', '.bin')]
const runtimes = {
  native: new ClaudeNativeRuntime({ bridgeDir, path: sessionPath }),
  acp: new AcpRuntime({
    clientName: 'workhub',
    clientVersion: app.getVersion(),
    extraPath,
    path: sessionPath
  }),
  terminal
}
const claudeHistory = new ClaudeSessionHistory({ bridgeDir })
// Kiro's data folder (~/.kiro); WORKHUB_KIRO_DIR points the readers elsewhere (smoke runs, demos).
const kiroDir = process.env['WORKHUB_KIRO_DIR'] ? resolve(process.env['WORKHUB_KIRO_DIR']) : undefined
// Past sessions per agent id; the readers behind them are kiro, opencode and codex (PLAN D9).
const historySources = { claude: claudeHistory, kiro: new KiroSessionHistory({ kiroDir }), opencode: new OpenCodeSessionHistory(), codex: new CodexSessionHistory() }
// Models and modes each agent offers before a session starts (Kiro: its listing commands; Claude Code:
// what it reports when a session starts, read without a prompt; others: their last session).
const agentOptions = new AgentOptionsService({
  discover: (agent, account) => {
    if (runsKiroCli(agent)) return discoverKiroOptions(createCliRunner(cliPath.split(delimiter)), agent.command)
    if (agent.adapter === 'native') return discoverClaudeOptions({ bridgeDir, path: sessionPath }, account?.configDir).then((found) => ({ ...found, modes: [] }))
    return null
  },
  // Claude Code's permission modes are known before any session: Settings and the New session dialog offer them.
  fixedModes: (agent) => (agent.adapter === 'native' ? CLAUDE_PERMISSION_MODES : undefined),
  state: new StateFile(join(dataDir, 'agent-options.json'), 500)
})
/** Kiro credits spent today and this week, read at most once a minute. */
let kiroSpendCache: { at: number; value: CreditSpend | null } | null = null
async function kiroSpend(): Promise<CreditSpend | null> {
  const now = Date.now()
  if (kiroSpendCache && now - kiroSpendCache.at < 60_000) return kiroSpendCache.value
  const entries = await readKiroCreditEntries({ kiroDir, since: startOfLocalDay(now, 6) }).catch(() => [])
  const value = entries.length ? creditSpend(entries, now) : null
  kiroSpendCache = { at: now, value }
  return value
}
// The cost other agents report in their session updates, per day (API-billed agents' spend).
const costLedger = new CostLedger(new StateFile<CostLedgerState>(join(dataDir, 'api-spend-ledger.json'), 1_000))
/** A session reported its running cost: kept for the API spend of agents not read from files. */
function recordSessionCost(sessionId: string, amount: number): void {
  const view = sessions.list().find((v) => v.id === sessionId)
  if (!view?.agentId) return
  const agent = configCache ? knownAgents(configCache).find((a) => a.id === view.agentId) : undefined
  costLedger.record(spendAgentId(agent, view.agentId), view.agentSessionId ?? view.id, amount)
}
// Token spend per folder for Home: scanned in the background from start-up, cached on disk.
const tokenSpend = new TokenSpendService({
  config: () => configuration.current(),
  store: new StateFile(join(dataDir, 'token-spend.json'), 2_000),
  sources: async () => spendSources(await configuration.current(), homedir(), kiroDir),
  emit: () => send('usage:folderSpendChanged'),
  begin: (label) => diagnostics.activity.begin(label),
  onScanned: ({ ms, files, failed }) => diagnostics.log.info(`token spend scan ${failed ? 'failed' : 'done'} in ${ms}ms, ${files} files`)
})
// Spend of agents billed by API key, per agent and day (Home's usage and token spend cards).
const apiSpend = new ApiSpendService({ config: () => configuration.current(), home: homedir(), costs: (include) => tokenSpend.costs(include), ledger: costLedger })
// The names the user gave sessions, by identity (Rename…).
const sessionNames = new SessionNames(new StateFile(join(dataDir, 'session-names.json'), 300))
// Tools an agent runs can ask Workhub for things (review, flow maps, Plan): a Unix socket, or on
// Windows a loopback port with a per-launch token, known once it listens.
const loopbackControl = usesLoopbackControl()
const controlToken = newControlToken()
// Set only once the endpoint listens; sessions started before (or when it cannot listen) get none.
let controlEndpoint: ControlEndpoint | null = null
const sessions = new SessionManager({
  config: configuration,
  worktrees: new GitWorktrees(),
  sessionEnv: (sessionId) => controlEnv(sessionId, controlEndpoint),
  // Workhub's MCP server (Settings → Agents → Workhub tools), for sessions that reach the endpoint.
  sessionMcp: async (env) => {
    if (!appOptions(await configuration.current()).workhubMcp) return []
    return workhubMcpLaunch(env, { node: process.execPath, script: join(bridgeDir, WORKHUB_MCP_SCRIPT) })
  },
  names: sessionNames,
  profileEnv: async (profileId, cwd) => {
    const config = await configuration.current()
    return profileSessionEnv(config.profiles.find((p) => p.id === profileId), cwd, secrets, homedir())
  },
  accountEnv: (account) => accountSessionEnv(account, secrets),
  runtimes,
  terminal,
  transcripts: [new ClaudeTranscriptReader(), new KiroTranscriptReader({ kiroDir }), new OpenCodeTranscriptReader(), new CodexTranscriptReader()],
  history: historySources,
  onAgentOptions: (agentId, accountId, options) => agentOptions.record(agentId, accountId, options),
  emitEvent: (e) => {
    if (e.type === 'monitor' && e.snapshot.cost?.currency === 'USD') recordSessionCost(e.sessionId, e.snapshot.cost.amount)
    driver.onEvent(e)
    continuity.onEvent(e)
    aiReview.onEvent(e)
    agentReview.onEvent(e)
    send('session:event', e)
  },
  emitChanged: (s) => {
    driver.onChanged(s)
    continuity.onChanged(s)
    aiReview.onChanged(s)
    send('session:changed', s)
    sessionWindows.sessionChanged(s.id)
    openSessions.changed()
  },
  emitRemoved: (id) => {
    send('session:removed', id)
    sessionWindows.closeSession(id)
    openSessions.changed()
  },
  emitReplay: (id, messages) => send('session:replay', id, messages),
  emitConfigChanged: configChanged
})
// The sessions open at the last quit, reopened once the main window listens (Settings → General).
const openSessions = new OpenSessions({
  store: new StateFile<SavedOpenSessions>(join(dataDir, 'open-sessions.json'), 500),
  list: () => sessions.list(),
  engineOf: (id) => sessions.engineOf(id),
  start: (input, extra) => sessions.start(input, { restored: true, ...extra }),
  setMode: (id, mode) => sessions.setMode(id, mode),
  folderExists: (path) => stat(path).then((s) => s.isDirectory(), () => false),
  enabled: async () => appOptions(await configuration.current()).reopenSessions,
  groups: async () => (await configuration.current()).sessionGroups,
  log: (message, err) => diagnostics.log.error(`${message}: ${err instanceof Error ? `${err.name}: ${err.message}` : 'failed'}`)
})
// Alerts found before the renderer listens (the first read runs at start-up) wait for it.
let usageAlertsReady = false
const pendingUsageAlerts: UsageAlert[] = []
// Plan usage per Claude and Codex account (Settings → Usage, opt-in per agent). WORKHUB_DEMO_USAGE=1
// serves synthetic windows instead, so the cards, budgets and gate can be shown without accounts.
const demoUsage = process.env['WORKHUB_DEMO_USAGE'] === '1'
// The Kiro usage session's id (one session reused across reads, see KiroPlanUsageReader).
const kiroUsageState = new StateFile<{ sessionId: string | null }>(join(dataDir, 'kiro-usage.json'), 200)
let configCache: WorkhubConfig | null = null
let kiroUsageReader: KiroPlanUsageReader | null = null
// Each session's own usage ceilings, by session identity (set from the session's side panel).
const sessionBudgets = new StateFile<Record<string, SessionCeilings>>(join(dataDir, 'session-budgets.json'), 200)
/** Only windows with a valid ceiling (1-100) from what the renderer sent. */
function cleanSessionCeilings(raw: unknown): SessionCeilings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  let out: SessionCeilings = {}
  for (const [window, value] of Object.entries(raw)) if (typeof value === 'number') out = setSessionCeiling(out, window, value)
  return out
}
const usage = new AgentUsageService({
  providers: demoUsage
    ? [new DemoUsageProvider('claude'), new DemoUsageProvider('codex'), new DemoUsageProvider('kiro')]
    : [
        new ClaudePlanUsageReader({ userAgent: `workhub/${app.getVersion()}` }),
        new CodexPlanUsageReader(),
        kiroUsageReader = new KiroPlanUsageReader({
          command: () => {
            const kiro = configCache && knownAgents(configCache).find((a) => a.id === 'kiro')
            return kiro && runsKiroCli(kiro) ? kiro.command : 'kiro-cli'
          },
          probeDir: join(dataDir, 'kiro-usage'),
          legacySessionsDir: join(kiroDir ?? join(homedir(), '.kiro'), 'sessions', 'cli'),
          state: {
            load: () => kiroUsageState.load({ sessionId: null }).sessionId,
            save: (sessionId) => kiroUsageState.save({ sessionId })
          },
          path: () => cliPath
        })
      ],
  load: async () => {
    const config = await configuration.current()
    configCache = config
    const options = appOptions(config)
    const claude = usageAccounts(config, 'claude', homedir())
    const codex = usageAccounts(config, 'codex', homedir())
    // Kiro has one sign-in per machine: a single default account.
    const kiro = knownAgents(config).some((a) => a.id === 'kiro') ? [{ agentId: 'kiro', accountId: null, name: '' }] : []
    return {
      accounts: [...(options.claudePlanUsage ? claude : []), ...(options.codexUsage ? codex : []), ...(options.kiroUsage ? kiro : [])],
      budget: options.usageBudget,
      knownKeys: [...claude, ...codex, ...kiro].map((a) => usageAccountKey(a.agentId, a.accountId))
    }
  },
  emit: (u: AccountUsage[]) => {
    send('usage:changed', u)
    scheduleTray()
  },
  alert: (alerts: UsageAlert[]) => (usageAlertsReady ? send('usage:alerts', alerts) : pendingUsageAlerts.push(...alerts)),
  alertState: new StateFile(join(dataDir, 'usage-alerts.json'), 500)
})
const budgetOf = (agentId: string, accountId: string | null) => usage.budgetOf(agentId, accountId)

const updates = new UpdateService((s) => send('updates:changed', s), (url) => openLink(null, url))
// "A new version is available": after an automatic check, at most once a day, never for a skipped version.
const updatePromptFile = new StateFile<UpdatePromptState>(join(dataDir, 'update-prompt.json'), 0)
const saveUpdatePrompt = (patch: UpdatePromptState) => {
  updatePromptFile.save({ ...readUpdatePromptState(updatePromptFile.load({})), ...patch })
  updatePromptFile.flush()
}
/** While the app stays open (menu bar), the automatic check runs again this often. */
const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000
async function automaticUpdateCheck(): Promise<void> {
  if (!appOptions(await configuration.current()).checkForUpdates) return
  const status = await updates.check()
  const state = readUpdatePromptState(updatePromptFile.load({}))
  if (status.state !== 'available' || !shouldPromptUpdate(state, status.version, Date.now())) return
  // With the window closed (menu bar only) the prompt waits for the next check.
  if (!win || win.isDestroyed()) return
  saveUpdatePrompt({ lastPromptAt: Date.now() })
  send('updates:prompt', status)
}

// Slack watcher and automations (P6a). WORKHUB_DEMO_SLACK=1 reads synthetic Slack instead of
// asking an agent, and never touches a Claude account's settings.
const driver = new SessionDriver(sessions, (id, text) => send('automations:prompted', id, text))
driver.onTurnEnded = (id, stopReason) => send('automations:turnEnded', id, stopReason)
const demoSlack = process.env['WORKHUB_DEMO_SLACK'] === '1' ? new DemoChatSource() : null
// One start per session identity: the sidebar's reopen and a Slack wake for the same session share it.
const ownerStarts = new OwnerStarts({ views: () => sessions.list(), start: (input) => sessions.start(input) })

const slack = new SlackWatcherService({
  configuration,
  source: demoSlack ?? new SlackAgentChatSource({ bridgeDir, cwd: dataDir }),
  hook: new SlackTrackingHook({
    dir: join(dataDir, 'slack-hook'),
    sourceScript: app.isPackaged ? join(process.resourcesPath, 'chat-slack', 'slack-track-hook.mjs') : join(repoRoot, 'packages', 'adapters', 'src', 'chat-slack', 'hook', 'slack-track-hook.mjs')
  }),
  demo: demoSlack,
  state: new StateFile(join(dataDir, 'slack-state.json'), 500),
  driver,
  startSession: (input) => sessions.start(input),
  ownerStarts,
  home: homedir(),
  usage: () => usage.current(),
  budgetOf,
  myPullRequests: async () => {
    const lists = await codeHost.lists((await configuration.current()).activeProfileId ?? null)
    return new Set(lists.mine.map((i) => canonicalUrl(i.pr.url)))
  },
  prState: async (url) => {
    const r = await codeHost.view((await configuration.current()).activeProfileId ?? null, url)
    return r.ok ? r.view.detail.state : undefined
  },
  emit: (snap) => {
    lastSlack = snap
    // PR windows show Slack badges and a Slack tab too: every window gets the snapshot.
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('slack:changed', snap))
    scheduleTray()
  },
  notice: (n) => send('slack:notice', n)
})
const automations = new AutomationService({
  configuration,
  driver,
  startSession: (input) => sessions.start(input),
  watcher: slack,
  state: new StateFile(join(dataDir, 'automations-state.json'), 300),
  home: homedir(),
  usage: () => usage.current(),
  budgetOf,
  emit: (snap) => {
    send('automations:changed', snap)
    scheduleTray()
  },
  configChanged: () => send('config:changed'),
  notice: (n) => send('slack:notice', n)
})

// Plan: reminders and meeting briefs (calendar-state.json keeps what fired and which briefs started).
const calendarState = new CalendarStateStore(new StateFile<CalendarState>(join(dataDir, 'calendar-state.json'), 500))
const briefs = new BriefService({
  config: () => configuration.current(),
  startSession: (input) => sessions.start(input),
  sessions: driver,
  rename: (id, name) => {
    try {
      sessions.rename(id, name)
    } catch {
      // The session went away before it was named.
    }
  },
  store: calendarState,
  gate: (config, target, origin) => {
    if (gatePrompt(agentKeyBudget(config, target.agentKey, budgetOf), origin === 'rule' ? 'automation' : 'user').kind !== 'send') return 'A usage ceiling of this account is reached (Settings → Usage)'
    if (origin !== 'rule') return null
    const at = target.agentKey.indexOf(':')
    const agentId = at < 0 ? target.agentKey : target.agentKey.slice(0, at)
    const accountId = at < 0 ? null : target.agentKey.slice(at + 1) || null
    const percent = agentId === 'claude' ? usage.current().find((u) => u.agentId === 'claude' && u.accountId === accountId)?.windows.find((w) => w.window === '5h')?.percent : undefined
    return percent !== undefined && percent >= target.usageThreshold ? `The account's 5 h usage is at ${Math.round(percent)}%` : null
  },
  context: async (profileId) => {
    const [lists, tickets] = await Promise.all([
      Promise.race([codeHost.lists(profileId), new Promise<null>((r) => setTimeout(() => r(null), 8_000))]).catch(() => null),
      ticketService.call(profileId, (t, ignored) => t.listAssigned({ ignoredStatuses: ignored }))
    ])
    const pr = (i: { pr: { title: string; url: string; author: string; owner: string; repo: string } }) => ({ title: i.pr.title, url: i.pr.url, author: i.pr.author, repo: `${i.pr.owner}/${i.pr.repo}` })
    return {
      mine: (lists?.mine ?? []).map(pr),
      toReview: (lists?.toReview ?? []).map(pr),
      tickets: tickets.ok ? ticketsInProgress(tickets.value).map((t) => ({ key: t.key, title: t.title, status: t.status, ...(t.assignee ? { assignee: t.assignee } : {}) })) : []
    }
  },
  formatTime: (ms) => new Intl.DateTimeFormat(trayLocale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms),
  resolveFolder: async (folder) => {
    const path = resolve(expandHome(folder || '~', homedir()))
    return (await stat(path).then((s) => s.isDirectory(), () => false)) ? path : null
  },
  home: homedir(),
  changed: (profileId) => send('plan:changed', profileId),
  resumes: (config, agentKey) => knownAgents(config).find((a) => a.id === (agentKey.split(':')[0] ?? agentKey))?.adapter === 'native'
})

// The monitor's "Local changes" of a session's folder (read-only git commands).
const localGit = new GitReview()

// AI review before a pull request: a reviewer agent on a separate checkout of the dev session's branch.
const aiReview = new AiReviewService({
  config: () => configuration.current(),
  sessions,
  driver,
  git: new GitReview(),
  state: new StateFile(join(dataDir, 'ai-review-state.json'), 500),
  workDir: join(dataDir, 'ai-review'),
  emit: (snap) => send('aiReview:changed', snap),
  notice: (n) => send('aiReview:notice', n),
  showPrompt: (id, text) => send('automations:prompted', id, text),
  showTurnEnd: (id, stopReason) => send('automations:turnEnded', id, stopReason),
  ticketPrefixes,
  ticketTitle: async (profileId, key) => {
    if (!profileId) return undefined
    const r = await ticketService.call(profileId, (t) => t.getTicket(key))
    return r.ok ? r.value?.title : undefined
  },
  canStartReview: reviewBudgetGate((config, agentKey) => agentKeyBudget(config, agentKey, budgetOf))
})

// The human review of a session's local changes; review messages go to the session like the AI review's.
const localReview = new LocalReviewService({
  sessions,
  deliver: (id, text) => driver.deliver(id, text),
  changes: new LocalChanges(),
  myPullRequests: async (profileId) => {
    const lists = await Promise.race([codeHost.lists(profileId), new Promise<null>((r) => setTimeout(() => r(null), 5_000))]).catch(() => null)
    return lists?.mine ?? []
  },
  emit: (sessionId, delivery) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('localReview:delivery', sessionId, delivery)),
  history: (sessionId) => sessions.history(sessionId)
})

// Continuity across accounts and agents: Claude account failover and hand-off to another agent.
const transcriptReaderFor = (id: string | undefined) =>
  id === 'kiro' ? new KiroTranscriptReader() : id === 'opencode' ? new OpenCodeTranscriptReader() : id === 'codex' ? new CodexTranscriptReader() : id === 'claude' ? new ClaudeTranscriptReader() : null
// What a hand-off brief knows of a session: its goal, links, files and commands.
const handoffFacts: ContinuityDeps['facts'] = async (view, agent, account, config) => {
  if (!view.agentSessionId) return EMPTY_FACTS
  const family = agent?.accountsOf ?? agent?.id ?? view.agentId
  if (family === 'claude') {
    const configDir = claudeConfigDirOf(config, account, homedir())
    return (await readClaudeHandoffFacts({ sessionId: view.agentSessionId, cwd: view.cwd, configDir, ticketPrefixes: ticketPrefixes(config) })) ?? EMPTY_FACTS
  }
  const source = historySources[family as keyof typeof historySources]
  const messages = source ? await source.messages(view.agentSessionId, view.cwd, account?.configDir).catch(() => []) : []
  const monitor = await transcriptReaderFor(agent?.transcript)
    ?.read({ agentSessionId: view.agentSessionId, cwd: view.cwd, configDir: account?.configDir, ticketPrefixes: ticketPrefixes(config) })
    .catch(() => null)
  return factsFromHistory(messages, monitor ?? {})
}
// Puts a session next to another in the sidebar (a hand-off, an agent reviewer).
const placeInSidebar: ContinuityDeps['placeBeside'] = async (member, anchorKey) => {
  const config = await configuration.current()
  const groups = config.sessionGroups
  if (!groups) return
  const next = placeBeside(groups, member, anchorKey)
  if (next === groups) return
  const r = await configuration.saveSessionGroups(next)
  if (r.ok) configChanged()
}
const continuity = new ContinuityService({
  config: () => configuration.current(),
  sessions,
  budgetOf,
  claudeConfigDir: (account, config) => claudeConfigDirOf(config, account, homedir()),
  copySession: (input) => copyClaudeSession(input),
  facts: handoffFacts,
  git: async (cwd) => {
    const probe = await new GitReview().probe(cwd, 'main')
    return probe ? { branch: probe.branch, dirtyFiles: probe.dirtyFiles } : null
  },
  placeBeside: placeInSidebar,
  emitOffer: (offer) => send('continuity:offer', offer),
  emitMoved: (moved) => send('continuity:moved', moved),
  showPrompt: (id, text) => send('automations:prompted', id, text),
  showTurnEnd: (id, stopReason) => send('automations:turnEnded', id, stopReason)
})

// "Review with another agent": the session's agent writes a brief, a read-only reviewer session reviews it, and the two loop over the findings.
const agentAvailabilityOf = (config: WorkhubConfig) => agentAvailability(knownAgents(config), { extraPath, path: [sessionPath() ?? process.env['PATH'] ?? '', ...fallbackPath].filter(Boolean).join(delimiter) })
const agentReview = new AgentReviewService({
  config: () => configuration.current(),
  sessions,
  remotes: (root) => localGit.remotes(root),
  availability: agentAvailabilityOf,
  budget: (config, agentKey) => agentKeyBudget(config, agentKey, budgetOf),
  showPrompt: (id, text) => send('automations:prompted', id, text),
  showTurnEnd: (id, stopReason) => send('automations:turnEnded', id, stopReason),
  placeBeside: placeInSidebar,
  emit: (loops) => send('agentReview:changed', loops)
})

async function snapshot(): Promise<ConfigSnapshot> {
  const config = await configuration.current()
  const withSecret = await Promise.all(config.connections.map(async (c) => ((c.secretRef && (await secrets.has(c.secretRef))) ? c.id : null)))
  return {
    config,
    issues: validateConfig(config),
    agents: knownAgents(config),
    providers: [...CONNECTION_PROVIDERS],
    connectionsWithSecret: withSecret.filter((x): x is string => x !== null),
    dataDir,
    loadError
  }
}

/** Every config write is refused while the file on disk could not be read, so it is never clobbered. */
function guarded<A extends unknown[]>(fn: (...args: A) => Promise<Result<WorkhubConfig>>) {
  return async (_e: unknown, ...args: A): Promise<Result<WorkhubConfig>> => {
    if (loadError) return { ok: false, issues: [{ path: 'config', message: `config file not loaded: ${loadError}` }] }
    try {
      const r = await fn(...args)
      if (r.ok) scheduleMenu()
      return r
    } catch (err) {
      // The real error goes to the log; the user gets a sentence, never a dumped validation error.
      console.error('config write failed', err)
      return { ok: false, issues: [{ path: 'config', code: 'unexpected', message: 'the change could not be saved' }] }
    }
  }
}

/** Toolbar colors per theme; they match the renderer's --wh-bg and --wh-text tokens. */
const CHROME = {
  dark: { color: '#0e1014', symbolColor: '#e8eaef' },
  light: { color: '#f5f6f8', symbolColor: '#14171c' }
} as const
const TITLE_BAR_HEIGHT = 48

/** The renderer's own colors, once it reported them (a terminal theme applied to the app changes them). */
let chromeOverride: ChromeColors | null = null

function chromeColors(): ChromeColors {
  return chromeOverride ?? (nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light)
}

/**
 * Window chrome per platform: macOS keeps its traffic lights inset into the sidebar; Windows and
 * Linux draw their window controls as an overlay on the right of the toolbar.
 */
function windowChrome(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
  return { titleBarStyle: 'hidden', titleBarOverlay: { ...chromeColors(), height: TITLE_BAR_HEIGHT } }
}

/**
 * The overlay controls (Windows, Linux) of every window follow the theme: nativeTheme fires
 * `updated` on a light/dark change and the renderer reports its colors on every theme change.
 */
function syncTitleBarOverlay(): void {
  if (process.platform === 'darwin') return
  // The tray popover has no overlay, but its solid background follows the light or dark look.
  trayPopover?.syncTheme()
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.setTitleBarOverlay({ ...chromeColors(), height: TITLE_BAR_HEIGHT })
    } catch {
      // A window without the overlay (the tray popover, the file viewer) throws; nothing to sync there.
    }
  }
}

/** Every external link goes through here (see link-service.ts). */
const links = createLinkService(systemLinkDeps(() => configuration.current(), sessionPath))
const openLink = (profileId: string | null, url: string): Promise<void> => links.open(url, profileId)

// Workhub's skills and MCP server for agents (Settings → Agents → Workhub tools).
const agentTools = new AgentToolsService({
  config: () => configuration.current(),
  home: homedir(),
  skillsDir: app.isPackaged ? join(process.resourcesPath, 'skills') : join(repoRoot, 'skills'),
  node: process.execPath,
  script: join(bridgeDir, WORKHUB_MCP_SCRIPT),
  socket: () => (controlEndpoint && 'socket' in controlEndpoint ? controlEndpoint.socket : null),
  run: (command, args, options) => probe(command, args, options),
  env: () => ({ ...process.env, PATH: [sessionPath() ?? process.env['PATH'] ?? '', ...fallbackPath].filter(Boolean).join(delimiter) })
})
// One install at a time (the installer keeps the guard), started from the setup checklist.
const setupInstaller = new SetupInstaller()
const setup = new SetupService({
  config: () => configuration.current(),
  hasSecret: (ref) => secrets.has(ref),
  path: () => [sessionPath() ?? process.env['PATH'] ?? '', ...fallbackPath].filter(Boolean).join(delimiter),
  home: homedir(),
  agentSkills: () => agentTools.skillsSummary(),
  slackFailure: async () => {
    const snapshot = await slack.snapshot()
    return snapshot.health === 'failing' ? (snapshot.lastError ?? 'failing') : null
  }
})

/** Setup windows (welcome, setup check, how Workhub works): one of each at a time. */
const setupWindows = new Map<SetupPage, BrowserWindow>()
const SETUP_HASH: Record<SetupPage, { hash: string; size: AuxWindowSize }> = {
  welcome: { hash: '#welcome', size: { width: 760, height: 640, minWidth: 620, minHeight: 520 } },
  check: { hash: '#setup', size: { width: 720, height: 680, minWidth: 560, minHeight: 440 } },
  help: { hash: '#howitworks', size: { width: 720, height: 680, minWidth: 560, minHeight: 440 } }
}

function openSetupWindow(page: SetupPage): void {
  const open = setupWindows.get(page)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    open.focus()
    return
  }
  const { hash, size } = SETUP_HASH[page]
  const created = createAuxWindow(hash, 'Workhub 2', size)
  setupWindows.set(page, created)
  created.on('closed', () => setupWindows.delete(page))
}

// Listing the history starts a process per account that reads every transcript's head: calls made
// meanwhile share it, and the sidebar's lookups (several right after start-up) take one up to 10 s old.
const namedHistory = new RecentCall(async () => {
  const config = await configuration.current()
  const result = await diagnostics.activity.run('history list', async () => listAllHistory(config, homedir(), historySources))
  // A session the user named shows that name in the history too; an automation's runs say which one they are.
  const named = result.entries.map((e) => ({ ...e, title: sessionNames.get(e.agentSessionId) ?? e.title }))
  return { ...result, entries: linkAutomationHistory(named, config.automations ?? [], automations.engine.snapshot().owned, homedir()) }
})

function registerIpc(): void {
  // Every handler answers only the app's own renderer (see ipc-guard.ts).
  // Every handler is timed too: a slow one or one that fails is logged by its channel (see ipc-timing.ts).
  const ipc = recordedIpc.ipc
  const report = rendererReporter(diagnostics.log)
  ipc.on('diag:report', (e, r: unknown) => report(e.sender === win?.webContents ? 'main' : 'aux', r))
  ipc.on('diag:revealLogs', revealLogs)
  ipc.on('hub:setTheme', (_e, theme: ThemePreference, chrome?: unknown) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme
    // The same light/dark with another palette fires no `updated`: sync here as well.
    if (chrome !== undefined) chromeOverride = chromeColorsFrom(chrome)
    syncTitleBarOverlay()
  })
  nativeTheme.on('updated', syncTitleBarOverlay)
  ipc.handle('hub:defaultCwd', () => homedir())
  ipc.handle('hub:pickFolder', async (e) => {
    // The picker sits on the window that asked (Settings has a window of its own), not always on the main one.
    const owner = BrowserWindow.fromWebContents(e.sender) ?? win!
    const r = await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'], defaultPath: homedir() })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  // Only the folders the profile lists (and their children) are read: never a path the renderer names.
  ipc.handle('hub:profileFolders', async (_e, profileId: unknown) => {
    const config = await configuration.current()
    const profile = typeof profileId === 'string' ? config.profiles.find((p) => p.id === profileId) : undefined
    return profile ? profileWorkspaces(profile, homedir()) : []
  })

  ipc.handle('config:get', () => snapshot())
  ipc.handle('config:saveConnection', guarded((c, s) => configuration.saveConnection(c, s)))
  ipc.handle('config:deleteConnection', guarded((id: string) => configuration.deleteConnection(id)))
  ipc.handle('config:saveAccount', guarded((a) => configuration.saveAccount(a)))
  ipc.handle('config:deleteAccount', guarded((id: string) => configuration.deleteAccount(id)))
  ipc.handle(
    'config:saveProfile',
    guarded(async (p) => {
      const r = await configuration.saveProfile(p)
      // A profile saved in the welcome window shows up in the main window too.
      if (r.ok) configChanged()
      return r
    })
  )
  ipc.handle(
    'config:deleteProfile',
    guarded(async (id: string) => {
      const names = (await configuration.current()).profiles.find((p) => p.id === id)?.envNames ?? []
      const r = await configuration.deleteProfile(id)
      if (r.ok && names.length) await saveProfileEnv(id, {}, names, secrets)
      return r
    })
  )
  ipc.handle('config:setActiveProfile', guarded((id: string) => configuration.setActiveProfile(id)))
  ipc.handle('config:effectiveAgents', async (_e, profileId: string | null) =>
    resolveEffectiveAgents(await configuration.current(), profileId)
  )
  ipc.handle(
    'config:saveOptions',
    guarded(async (o) => {
      const r = await configuration.saveOptions(o)
      if (r.ok) {
        void usage.refresh()
        void refreshOptionsCache()
      }
      return r
    })
  )
  ipc.handle('config:saveSessionGroups', guarded((g) => configuration.saveSessionGroups(g)))
  ipc.on('notifications:show', (_e, n: SessionNotification) => showSessionNotification(n))
  // Workhub 1's settings are only ever read (`defaults export`); nothing is written back.
  ipc.handle('config:previewWorkhub1Import', async () => {
    try {
      const v1 = await readWorkhub1Settings()
      if (!v1) return { available: false }
      const config = await configuration.current()
      // Names only: the Workhub 1 connections still waiting for their token (nothing is read from the Keychain here).
      const pendingSecrets = (await pendingWorkhub1Secrets(v1, config, secrets)).map(({ connection }) => ({ connectionId: connection.id, name: connection.name || connection.id }))
      return { available: true, plan: planWorkhub1Import(v1, config, homedir()), pendingSecrets }
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipc.handle(
    'config:applyWorkhub1Import',
    guarded(async () => {
      const v1 = await readWorkhub1Settings()
      if (!v1) return { ok: false, issues: [{ path: 'import', message: 'Workhub 1 settings not found' }] }
      const result = await configuration.applyImport(planWorkhub1Import(v1, await configuration.current(), homedir()))
      // Profiles imported earlier get the folder switches they still leave unset.
      if (result.ok) return (await fillWorkhub1FolderFlagsFrom(v1)) ?? result
      return result
    })
  )
  // Copies the tokens of Workhub 1's Keychain items into the SecretStore. Only statuses go back.
  ipc.handle('config:importWorkhub1Secrets', async (): Promise<Workhub1SecretResult[]> => {
    if (process.platform !== 'darwin' || loadError) return []
    try {
      const v1 = await readWorkhub1Settings()
      if (!v1) return []
      const results = await importWorkhub1Secrets(v1, configuration, secrets, (item) => readKeychainItem(item))
      if (results.some((r) => r.status === 'imported')) send('config:changed')
      return results
    } catch {
      return []
    }
  })
  ipc.on('hub:openExternal', (_e, url: unknown, profileId: unknown) => {
    if (typeof url === 'string') void links.open(url, typeof profileId === 'string' ? profileId : null)
  })
  ipc.handle('links:chromeProfiles', (_e, app: unknown) => listChromeProfiles(typeof app === 'string' ? app : undefined))

  ipc.handle('updates:status', () => updates.status())
  ipc.handle('updates:check', () => updates.check())
  ipc.handle('updates:install', () => updates.install())
  ipc.handle('updates:restart', () => updates.restart())
  ipc.handle('updates:skip', (_e, version: unknown) => {
    if (typeof version === 'string' && version) saveUpdatePrompt({ skippedVersion: version })
  })
  ipc.handle('history:list', () => namedHistory.get())
  ipc.handle('history:find', async (_e, keys: unknown) => {
    if (!Array.isArray(keys)) return []
    const wanted = new Set(keys.filter((k): k is string => typeof k === 'string'))
    if (!wanted.size) return []
    return historyOfSessions((await namedHistory.get(10_000)).entries, wanted)
  })
  ipc.handle('history:revealFolder', async (_e, path: string) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return false
    const isFolder = await stat(path).then((s) => s.isDirectory(), () => false)
    if (!isFolder) return false
    // A macOS bundle (`Some.app`) is a folder that opening would launch: it is shown in its folder instead.
    if (opensAsProgram(path, { isDirectory: true })) {
      shell.showItemInFolder(path)
      return true
    }
    return (await shell.openPath(path)) === ''
  })
  ipc.handle('agents:availability', async () =>
    agentAvailability(knownAgents(await configuration.current()), {
      extraPath,
      path: [sessionPath() ?? process.env['PATH'] ?? '', ...fallbackPath].filter(Boolean).join(delimiter)
    })
  )
  ipc.handle('agents:options', async (_e, agentKey: string, refresh?: boolean) => {
    const config = await configuration.current()
    const choice = typeof agentKey === 'string' ? resolveChoice(config, config.activeProfileId ?? null, agentKey) : null
    if (!choice) return { models: [], modes: [], source: 'none', modeSemantics: 'none' }
    return agentOptions.get(choice.agent, choice.account, refresh === true)
  })
  ipc.handle('usage:get', (_e, refresh?: boolean) => (refresh ? usage.refresh() : usage.current()))
  ipc.handle('usage:refreshNow', () => usage.refresh({ force: true }))
  ipc.handle('usage:kiroSpend', () => kiroSpend())
  ipc.handle('usage:apiSpend', () => apiSpend.summary())
  ipc.handle('usage:folderSpend', (_e, profileId?: string | null) => tokenSpend.forProfile(typeof profileId === 'string' ? profileId : null))
  ipc.handle('usage:sessionBudgets', () => sessionBudgets.load({}))
  ipc.handle('usage:setSessionBudget', (_e, identity: unknown, ceilings: unknown) => {
    if (typeof identity !== 'string' || !identity) return
    const all = sessionBudgets.load({})
    const own = cleanSessionCeilings(ceilings)
    if (Object.keys(own).length) all[identity] = own
    else delete all[identity]
    // `load` merges over the fallback, so a removed entry must be written as a whole new object.
    sessionBudgets.save({ ...all })
    sessionBudgets.flush()
    send('usage:sessionBudgetsChanged', all)
  })
  ipc.on('usage:notify', (_e, n: { title: string; body: string }) => showUsageNotification(n))
  ipc.on('usage:ready', () => {
    usageAlertsReady = true
    if (pendingUsageAlerts.length) send('usage:alerts', pendingUsageAlerts.splice(0))
  })

  ipc.handle('setup:run', () => setup.run())
  registerSetupInstallIpc(ipc, { install: (id) => setupInstaller.install(id) })
  registerAgentToolsIpc(ipc, agentTools)
  ipc.on('setup:openWindow', (_e, page: SetupPage) => {
    if (page === 'welcome' || page === 'check' || page === 'help') openSetupWindow(page)
  })
  // A setup window's fix button (or a link inside Settings) asks for a Settings tab.
  ipc.on('setup:openSettings', (_e, tab: unknown) => {
    if (typeof tab === 'string') settingsWindow.open(settingsSectionArg(tab))
  })
  ipc.on('settings:open', (_e, section: unknown) => settingsWindow.open(settingsSectionArg(section)))
  ipc.on('settings:setDirty', (e, dirty: unknown) => settingsWindow.setDirty(e.sender.id, dirty === true))
  ipc.on('settings:close', (e) => settingsWindow.close(e.sender.id))
  ipc.handle('setup:completeWelcome', async () => {
    if (!loadError) await configuration.saveOptions({ welcomeDone: true })
    configChanged()
    setupWindows.get('welcome')?.close()
  })
  ipc.handle('profileEnv:stored', async (_e, profileId: string) => {
    const config = await configuration.current()
    return storedProfileEnvNames(config.profiles.find((p) => p.id === profileId), secrets)
  })
  ipc.handle('profileEnv:save', async (_e, profileId: string, values: Record<string, string>, removed: string[]) => {
    if (typeof profileId !== 'string' || !values || typeof values !== 'object' || !Array.isArray(removed)) return
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string'))
    await saveProfileEnv(profileId, clean, removed.filter((n) => typeof n === 'string'), secrets)
  })
  ipc.handle('accountEnv:stored', async (_e, accountId: string) => {
    const config = await configuration.current()
    return storedAccountEnvNames(config.accounts.find((a) => a.id === accountId), secrets)
  })
  ipc.handle('accountEnv:save', async (_e, accountId: string, values: Record<string, string>, removed: string[]) => {
    if (typeof accountId !== 'string' || !values || typeof values !== 'object' || !Array.isArray(removed)) return
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string'))
    await saveAccountEnv(accountId, clean, removed.filter((n) => typeof n === 'string'), secrets)
  })
  ipc.handle('systemNotifications:status', async () => ({ supported: await notificationPermission.allowed() }))
  ipc.handle('systemNotifications:test', (_e, body: unknown) => {
    if (!Notification.isSupported()) return { outcome: 'failed', error: 'notifications are not supported here' }
    return testNotification(() => notificationPermission.observe(new Notification({ title: app.getName(), body: String(typeof body === 'string' ? body : '').slice(0, 200) })), showMain)
  })
  ipc.on('systemNotifications:openSettings', () => {
    const target =
      process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.Notifications-Settings.extension' : process.platform === 'win32' ? 'ms-settings:notifications' : null
    if (target) void shell.openExternal(target)
  })
  openTicketWindow = registerTicketIpc({
    ipcMain: ipc,
    openLink,
    service: ticketService,
    createWindow: createAuxWindow,
    mainWindow: () => win,
    broadcast: (channel, ...args) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args))
  }).openWindow

  ipc.handle('sessions:list', () => sessions.list())
  ipc.on('sessions:ready', (e) => {
    if (win && !win.isDestroyed() && e.sender === win.webContents) void openSessions.restore()
  })
  // The New session dialog's Group: main saves the place, so it follows the session's identity.
  ipc.handle('sessions:start', (_e, input: StartSessionInput) =>
    startPlaced(input, {
      start: (rest) => sessions.start(rest),
      groups: async () => (await configuration.current()).sessionGroups,
      saveGroups: (g) => configuration.saveSessionGroups(g),
      replaceIdentity: (oldKey, newKey) => configuration.replaceSessionIdentity(oldKey, newKey),
      current: (id) => sessions.list().find((v) => v.id === id),
      changed: configChanged
    })
  )
  ipc.handle('sessions:reopen', (_e, identity: string, input: StartSessionInput) => {
    if (typeof identity !== 'string' || !identity) throw new Error('an identity is required')
    return ownerStarts.start(identity, input)
  })
  // A renderer's prompt carries a token: main says when it actually goes out (it may wait behind
  // a review or a Slack wake) and the renderer can take it back until then.
  ipc.handle('sessions:prompt', (e, id: string, text: string, images, token?: unknown) => {
    // A paired phone shows its own bubble; the windows get it the way they get Workhub's own prompts.
    if (isRemoteSender(e.sender.id)) {
      return promptFromDevice(
        {
          prompt: (sid, t, imgs, options) => sessions.prompt(sid, t, imgs, options),
          showPrompt: (sid, t) => send('automations:prompted', sid, t),
          showTurnEnd: (sid, stopReason) => send('automations:turnEnded', sid, stopReason)
        },
        id,
        text,
        images
      )
    }
    if (typeof token !== 'number') return sessions.prompt(id, text, images)
    const onStart = () => {
      if (!e.sender.isDestroyed()) e.sender.send('sessions:promptStarted', id, token)
    }
    // Sent like the session's events (not with the invoke's answer, which can overtake them), so
    // the window ends the turn after its last message.
    const settled = () => {
      if (!e.sender.isDestroyed()) e.sender.send('sessions:promptSettled', id, token)
    }
    return sessions.prompt(id, text, images, { key: `${e.sender.id}:${token}`, onStart }).finally(settled)
  })
  ipc.handle('sessions:withdrawPrompt', (e, id: string, token: unknown) => typeof token === 'number' && sessions.withdrawPrompt(id, `${e.sender.id}:${token}`))
  ipc.handle('sessions:setMode', (_e, id: string, mode: SessionMode, options?: { now?: unknown }) => sessions.setMode(id, mode, { now: options?.now === true }))
  ipc.handle('sessions:close', (_e, id: string) => sessions.close(id))
  ipc.handle('sessions:closeRemovingWorktree', (_e, id: string, force: boolean) => sessions.closeRemovingWorktree(id, force === true))
  ipc.handle('sessions:setModel', (_e, id: string, model: string | null) => sessions.setModel(id, model))
  ipc.handle('sessions:setAgentMode', (_e, id: string, modeId: string) => {
    if (typeof modeId !== 'string' || !modeId) throw new Error('a mode id is required')
    return sessions.setAgentMode(id, modeId)
  })
  ipc.on('sessions:mcp', (_e, id: string, action: 'refresh' | 'reconnect' | 'enable' | 'disable', server?: string) => sessions.mcp(id, action, server))
  ipc.handle('sessions:subagent', (_e, id: string, subagentId: string) => sessions.subagent(id, subagentId))
  ipc.handle('sessions:revealFile', async (_e, id: string, path: string) => {
    const target = sessions.fileInSession(id, path)
    if (!target || !(await stat(target).then(() => true, () => false))) return false
    shell.showItemInFolder(target)
    return true
  })
  ipc.handle('sessions:localChanges', async (_e, id: string) => {
    const cwd = sessions.cwdOf(id)
    return cwd ? localGit.localChanges(cwd, sessions.changePathsOf(id)) : null
  })
  ipc.handle('sessions:rename', (_e, id: string, name: string | null) => {
    if (name !== null && typeof name !== 'string') throw new Error('a name is required')
    sessions.rename(id, name)
  })
  ipc.on('windows:openSession', (_e, id: string) => sessionWindows.open(id))
  ipc.on('windows:openSubagent', (_e, id: string, subagentId: string) => sessionWindows.openSubagent(id, subagentId))
  ipc.on('windows:dock', (_e, id: string) => sessionWindows.dock(id))
  ipc.handle('windows:detached', () => sessionWindows.detached())
  ipc.handle('windows:snapshot', (e, id: string) => sessionWindows.snapshot(id, e.sender))
  ipc.on('windows:snapshotReply', (_e, requestId: string, snapshot: SessionSnapshot | null) => sessionWindows.reply(requestId, snapshot))
  ipc.handle('sessions:cancel', (_e, id: string) => sessions.cancel(id))
  ipc.handle('sessions:stop', (_e, id: string) => sessions.stop(id))
  ipc.on('sessions:permission', (_e, id: string, requestId: string, optionId: string | null, answers?: unknown) =>
    sessions.respondPermission(id, requestId, optionId, validAnswers(answers))
  )
  ipc.on('sessions:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipc.on('sessions:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))

  registerCodeHostIpc(ipc, { service: codeHost, openWindow: openPullRequestWindow, showInWorkhub: showPullRequestInMain, openExternal: (url, profileId) => openLink(profileId, url) })
  registerLinksIpc({ ipcMain: ipc, loadConfig: () => configuration.current(), mainWindow: () => win })
  registerPrEventsIpc(ipc, { service: prEvents, notify: showPullRequestNotification, recognizes: (profileId, url) => codeHost.recognizes(profileId, url) })
  ipc.handle('health:get', (_e, profileId: string | null, force?: boolean) => health.get(profileId, force === true))
  ipc.handle('health:details', (_e, profileId: string | null, environmentId: string, request: HealthDetailRequest, force?: boolean) => health.details(profileId, environmentId, request, force === true))
  ipc.handle('health:flowMaps', (_e, profileId: string | null) => health.flowMaps(profileId))
  ipc.handle('health:flowMapStates', (_e, profileId: string | null, environmentId: unknown) => (typeof environmentId === 'string' ? health.flowMapStates(profileId, environmentId) : {}))
  ipc.handle('health:flowMap', (_e, profileId: string | null, environmentId: string, mapId: string, hours: number, force?: boolean, storedOnly?: boolean) => health.flowMap(profileId, environmentId, mapId, hours, force === true, storedOnly === true))
  ipc.handle('health:flowTraces', (_e, profileId: string | null, environmentId: string, mapId: string, hours: number, sort: FlowTraceSort) => health.flowTraces(profileId, environmentId, mapId, hours, sort))
  ipc.handle('health:flowTrace', (_e, profileId: string | null, environmentId: string, mapId: string, traceId: string) => health.flowTrace(profileId, environmentId, mapId, traceId))
  ipc.handle('health:flowTraceLogs', (_e, profileId: string | null, environmentId: string, mapId: string, traceId: string) => health.flowTraceLogs(profileId, environmentId, mapId, traceId))
  registerFlowMapsIpc(ipc, {
    dir: join(dataDir, FLOW_MAPS_FOLDER),
    pickFiles: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'JSON', extensions: ['json'] }], defaultPath: homedir() })
      return r.canceled ? [] : r.filePaths
    },
    showItemInFolder: (path) => shell.showItemInFolder(path),
    createWindow: (hash, title) => createAuxWindow(hash, title, { width: 1320, height: 900, minWidth: 760, minHeight: 520 }),
    mainWindow: () => win,
    writeImage: async (dataUrl) => {
      const image = nativeImage.createFromDataURL(dataUrl)
      if (image.isEmpty()) return false
      // Electron 45's clipboard is the W3C-shaped one: items of MIME-typed blobs.
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
      return true
    }
  })
  registerMetricAlertsIpc(ipc, metricAlerts)
  registerRemoteIpc(ipc, remoteService)
  // A paired device reads a file the agent made inside the session's folder, or an image outside it that
  // the session's own agent read or wrote (see remote/allowlist.ts). Containment is checked again on the
  // real paths, symlinks resolved, and secret-like names are refused (remote/files.ts).
  ipc.handle('remote:file', (_e, id: unknown, path: unknown) => {
    if (typeof id !== 'string' || typeof path !== 'string') throw new Error('a session and a path are required')
    const view = sessions.list().find((v) => v.id === id)
    if (!view) throw new Error('the session is not open')
    return readRemoteFile(view.cwd, path, async () => touchedPaths(view.cwd, await sessions.history(id)))
  })
  // A paired device reads an open session's conversation a page at a time (see remote/history.ts):
  // it only sees live events, so this is how it shows what was said before it connected.
  ipc.handle('remote:history', async (_e, id: unknown, before: unknown) => {
    if (typeof id !== 'string') throw new Error('a session is required')
    if (before !== undefined && (typeof before !== 'number' || !Number.isInteger(before) || before < 0)) throw new Error('before must be a message index')
    if (!sessions.list().some((v) => v.id === id)) throw new Error('the session is not open')
    return pageHistory(await sessions.history(id), before)
  })
  registerChatIpc(ipc, { slack, automations, configuration, guarded })
  // The chat's Listen button: a long agent message is summarized (one small Haiku query) before it is read aloud.
  const listenSummarizer = new ListenSummarizer({ bridgeDir, cwd: dataDir })
  registerListenIpc(ipc, {
    summarize: (request) => listenSummarizer.summarize(request),
    config: () => configuration.current(),
    session: (id) => sessions.list().find((v) => v.id === id) ?? null,
    home: homedir(),
    log: (m) => diagnostics.log.warn(m)
  })
  registerAiReviewIpc(ipc, aiReview)
  registerAgentReviewIpc(ipc, agentReview, reviewLoopWindows((hash, title) => createAuxWindow(hash, title, REVIEW_LOOP_WINDOW_SIZE)))
  registerLocalReviewIpc(ipc, localReview, { openWindow: openLocalReviewWindow, openPath: (path) => shell.openPath(path), showItemInFolder: (path) => shell.showItemInFolder(path) })
  registerFileViewerIpc(ipc, {
    createWindow: (hash, title) => createAuxWindow(hash, title, FILE_WINDOW_SIZE),
    home: homedir(),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openPath: (path) => shell.openPath(path),
    writeClipboard: (text) => clipboard.writeText(text),
    pastedImagesDir: join(dataDir, 'pasted-images')
  })
  ipc.handle('continuity:options', (_e, id: string) => continuity.options(id))
  ipc.handle('continuity:failover', (_e, id: string, request) => continuity.failover(id, request))
  ipc.handle('continuity:handoff', (_e, id: string, request) => continuity.handoff(id, request))
  ipc.handle('health:test', (_e, connection, secret, indexToProbe?: string) => health.test(connection, secret, indexToProbe))
  registerPlanIpc(ipc, { calendar, briefs })
  registerPlannerIpc(ipc, planner, {
    alert: async (profileId, key) => (await metricAlerts.list(profileId)).alerts.find((a) => a.key === key),
    alertSent: (profileId, key) => metricAlerts.setStatus(profileId, key, { type: 'sendToInbox' }),
    createWindow: (hash, title) => createAuxWindow(hash, title, PLAN_ITEM_WINDOW_SIZE)
  })
  ipc.on('tray:state', (_e, state: TrayRendererState) => {
    if (isLocale(state?.locale) && state.locale !== trayLocale) {
      trayLocale = state.locale
      trayLocaleFromRenderer = true
      scheduleMenu()
    }
    if (Array.isArray(state?.sessions)) rendererSessions = state.sessions.slice(0, 500).filter(validTraySession)
    scheduleTray()
    appBadge.setCount(attentionBadgeCount(rendererSessions ?? []))
  })
  // The popover's own channels; actions are checked again here, field by field.
  ipc.handle('trayPopover:get', () => trayPopover?.currentView() ?? null)
  ipc.on('trayPopover:perform', (_e, raw: unknown) => {
    const action = parseTrayAction(raw)
    if (!action) return
    if (action.kind !== 'pause' && action.kind !== 'resume') trayPopover?.hide()
    void performTrayAction(action)
  })
  ipc.on('trayPopover:hide', (e) => {
    if (trayPopover?.owns(e.sender)) trayPopover.hide()
  })
}

/** A question's answers from the renderer: question text to answer, strings only; anything else is dropped. */
function validAnswers(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const entries = Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length <= 10_000)
  return entries.length > 0 ? Object.fromEntries(entries.slice(0, 10)) : undefined
}

const SESSION_STATES = new Set(['starting', 'ready', 'busy', 'stopped', 'error'])
const ATTENTION_KINDS = new Set(['error', 'needsAnswer', 'replied'])
function validTraySession(s: TraySession): boolean {
  return (
    !!s &&
    typeof s.id === 'string' &&
    typeof s.title === 'string' &&
    SESSION_STATES.has(s.state) &&
    (s.unseen === undefined || ATTENTION_KINDS.has(s.unseen)) &&
    (s.awaitingAnswer === undefined || typeof s.awaitingAnswer === 'boolean') &&
    (s.agentId === undefined || (typeof s.agentId === 'string' && s.agentId.length <= 100))
  )
}

/** Brings the main window up (it may be hidden in the menu bar) and the app to the front. */
function showMain(): void {
  if (!win || win.isDestroyed()) createWindow()
  const w = win!
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}

/** A PR window's "Show in Workhub": the main window comes up on Pull requests with that PR selected. */
function showPullRequestInMain(url: string, profileId: string | null): void {
  showMain()
  send('codeHost:focus', url, profileId)
}

/** Where "Check for updates" takes the user: General, pointing at its Updates group. */
const UPDATES_SETTINGS = 'general#updates'

/** Brings the main window to `route`; Settings opens its own window on `section` (`general#updates` also points at one of its groups). */
function navigate(route: TrayRoute, section?: string): void {
  if (route === 'settings') return settingsWindow.open(settingsSectionArg(section))
  showMain()
  send('tray:navigate', route)
}

/** A notification worded by the renderer; a click opens its session, or its screen. */
function showSessionNotification(n: SessionNotification): void {
  if (!n || typeof n.title !== 'string' || typeof n.sessionId !== 'string') return
  const kind = isNotificationKind(n.kind) ? n.kind : 'replied'
  const route = n.route && TRAY_ROUTES.includes(n.route) ? n.route : undefined
  // An automation's sessions follow its own Notify setting (default: only failures).
  const view = sessions.list().find((s) => s.id === n.sessionId)
  if (view && (kind === 'replied' || kind === 'needsAnswer' || kind === 'error') && !automations.notifies(sessionIdentity(view), kind)) return
  void notifier.show(kind, n, () => {
    if (route) return navigate(route)
    showMain()
    send('notifications:open', n.sessionId)
  }, { sessionId: n.sessionId }, `session:${n.sessionId}`)
}

/** A usage alert (worded by the renderer); a click brings the window up on Home. */
function showUsageNotification(n: { title: string; body: string }): void {
  void notifier.show('usage', n, () => {
    showMain()
    send('usage:open')
  })
}

/** An OS notification about a pull request event; a click opens that pull request. */
function showPullRequestNotification(n: PrNotification): void {
  if (typeof n?.title !== 'string') return
  recentPrEvents.unshift({ profileId: n.profileId, url: n.url, title: n.title })
  recentPrEvents.splice(10)
  scheduleTray()
  void notifier.show('prEvent', n, () => {
    if (win && !win.isDestroyed()) showMain()
    openPullRequestWindow(n.profileId || null, n.url)
  }, { url: n.url, profileId: n.profileId })
}

let openTicketWindow: ((profileId: string, key: string) => void) | null = null

function ticketNotification(profileId: string, change: TicketChange): void {
  const { t } = trayText(trayLocale)
  const words =
    change.kind === 'status'
      ? { title: t('notify.ticket.status', { key: change.key, from: change.from, to: change.to }), body: t('notify.ticket.statusBody', { title: change.title }) }
      : change.kind === 'assigned'
        ? { title: t('notify.ticket.assigned', { key: change.key }), body: t('notify.ticket.assignedBody', { title: change.title, status: change.status }) }
        : { title: t('notify.ticket.left', { key: change.key }), body: t('notify.ticket.leftBody', { title: change.title }) }
  void notifier.show('tickets', words, () => openTicketWindow?.(profileId, change.key), { ticket: change.key })
}

function healthNotification(alert: HealthAlert, channels: HealthAlertChannel[]): void {
  void notifier.show('health', healthAlertWords(alert, trayText(trayLocale).t), () => navigate('health'), { environmentId: alert.environmentId }, undefined, channels)
}

const healthWatcher = new HealthWatcher({
  activeProfileId: async () => (await configuration.current()).activeProfileId ?? null,
  read: (profileId) => health.get(profileId),
  alert: healthNotification,
  alertSettings: async (profileId) => (await configuration.current()).profiles.find((p) => p.id === profileId)?.health?.alerts,
  changed: scheduleTray,
  cooldowns: (() => {
    const file = new StateFile<{ firedAt: Record<string, number> }>(join(dataDir, 'health-alerts.json'), 500)
    return { load: () => file.load({ firedAt: {} }).firedAt ?? {}, save: (firedAt) => file.save({ firedAt }), flush: () => file.flush() }
  })()
})

function flowAlertNotification(alert: FlowAlert): void {
  void notifier.show('flowMaps', flowAlertWords(alert, trayText(trayLocale).t), () => navigate('flowMaps'), { mapId: alert.mapId, environmentId: alert.environmentId })
}

const flowAlertWatcher = new FlowAlertWatcher({
  activeProfileId: async () => (await configuration.current()).activeProfileId ?? null,
  enabled: async (profileId) => {
    const profile = (await configuration.current()).profiles.find((p) => p.id === profileId)
    const screens = profile ? moduleScreens(profile.modules) : []
    return screens.includes('flowMaps') && screens.includes('health')
  },
  environments: async (profileId) => {
    const view = await health.get(profileId)
    return view.state === 'ready' ? view.environments.map((e) => ({ id: e.id, name: e.name })) : []
  },
  maps: (profileId) => health.flowMaps(profileId),
  read: (profileId, environmentId, mapId, hours) => health.flowMap(profileId, environmentId, mapId, hours),
  alert: flowAlertNotification,
  cooldowns: (() => {
    const file = new StateFile<{ firedAt: Record<string, number> }>(join(dataDir, 'flow-alerts.json'), 500)
    return { load: () => file.load({ firedAt: {} }).firedAt ?? {}, save: (firedAt) => file.save({ firedAt }), flush: () => file.flush() }
  })()
})

/** A meeting reminder; a click joins the call when there is a link, else shows the Plan screen. */
function meetingReminder(profileId: string, action: DueAction): void {
  const now = Date.now()
  const words = meetingReminderWords(action, now, trayText(trayLocale))
  const url = action.event.meetingUrl
  void notifier.show('meeting', words, () => {
    if (url) return void openLink(profileId, url)
    showMain()
    send('plan:focus')
  }, { eventId: action.event.id, rule: action.ruleId })
}

/** Demo calendar: a brief rule matched. Nothing starts; "Prepare brief" on the meeting does, on request. */
async function demoBriefNotice(action: DueAction): Promise<void> {
  const { t } = trayText(trayLocale)
  const words = { title: t('notify.brief.demo', { title: action.event.title || t('plan.untitled') }), body: t('notify.brief.demoBody') }
  void notifier.show('meeting', words, () => {
    showMain()
    send('plan:focus')
  }, { eventId: action.event.id, rule: action.ruleId })
}

const calendarWatcher = new CalendarWatcher({
  profiles: () => calendar.plannerProfiles(),
  read: async (profileId) => {
    const r = await calendar.read(profileId)
    return r && (r.state === 'ready' || r.state === 'demo') ? { events: r.events, settings: r.settings } : null
  },
  store: calendarState,
  remind: meetingReminder,
  // The synthetic calendar never starts a brief by itself (that would spend tokens just for opening the demo): it says so.
  brief: (profileId, action) =>
    process.env['WORKHUB_DEMO_CALENDAR'] === '1' ? demoBriefNotice(action) : briefs.brief(profileId, action.event, { ruleId: action.ruleId, ...(action.automationId ? { automationId: action.automationId } : {}) }),
  log: (m) => diagnostics.log.warn(m)
})

function metricAlertNotification(profileId: string, alerts: MetricAlert[]): void {
  void notifier.show('metricAlert', metricAlertWords(alerts, trayText(trayLocale).t), () => {
    navigate('health')
    send('metricAlerts:open', profileId)
  }, { profileId, alerts: alerts.map((a) => a.key) })
}

const demoHealth = process.env['WORKHUB_DEMO_HEALTH'] === '1'
/** Every profile with the Health module on, with its alert rules. */
const metricAlertProfiles = async () =>
  (await configuration.current()).profiles.filter((p) => moduleScreens(p.modules).includes('health')).map((p) => ({ id: p.id, rules: alertRulesOf(p.health?.alertRules) }))
const healthMetricSource = new HealthMetricSource((profileId) => health.get(profileId))
const demoMetricSource = new DemoMetricSource(async (profileId) => (await metricAlertProfiles()).find((p) => p.id === profileId)?.rules.businessDays ?? [1, 2, 3, 4, 5])
const productMetricSource = new ProductMetricSource(async (profileId) => (await metricAlertProfiles()).find((p) => p.id === profileId)?.rules.businessDays ?? [1, 2, 3, 4, 5])
// WORKHUB_DEMO_HEALTH=1 adds a month of synthetic product metrics, so the Alerts tab has something to show.
const metricAlerts = new MetricAlertService({
  profiles: metricAlertProfiles,
  sources: () => (demoHealth ? [healthMetricSource, demoMetricSource, ...(scenario ? [productMetricSource] : [])] : [healthMetricSource]),
  store: new StateFile<MetricAlertsState>(join(dataDir, 'metric-alerts.json'), 1_000),
  notify: metricAlertNotification,
  changed: (profileId) => send('metricAlerts:changed', profileId),
  demo: demoHealth
})

// Plan milestones and inbox (planner-state.json: per profile, user data rather than settings).
const planner = new PlannerService({
  profiles: async () => (await configuration.current()).profiles,
  store: new StateFile<PlannerState>(join(dataDir, 'planner-state.json'), 500),
  tracker: (profileId, connectionId) => ticketService.trackerFor(profileId, connectionId),
  // Every window: the main one, and the windows of single inbox items and milestones.
  changed: (profileId) => BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.webContents.send('planner:changed', profileId))
})

const ticketWatcher = new TicketWatcher({
  activeProfileId: async () => (await configuration.current()).activeProfileId ?? null,
  enabled: async () => appOptions(await configuration.current()).notifyTickets,
  list: (profileId) => ticketService.call(profileId, (t, ignored) => t.listAssigned({ ignoredStatuses: ignored })),
  store: new StateFile(join(dataDir, 'ticket-watch.json'), 500),
  announce: ticketNotification,
  // A burst (a profile not read for a day, a capped list) folds into one notification.
  announceSummary: (_profileId, changes) => void notifier.show('tickets', ticketSummaryWords(changes, trayText(trayLocale).t), () => navigate('tickets'))
})

async function refreshOptionsCache(): Promise<void> {
  const options = appOptions(await configuration.current())
  keepInTray = options.keepInTray
  appBadge.setEnabled(options.showAppBadge)
  scheduleTray()
}

/** The popover's "Today": the active profile's next meetings and the Plan tasks due. */
const trayToday = new TrayToday({ readCalendar: (profileId) => calendar.read(profileId), dueToday: (profileId) => planner.dueToday(profileId) })

/** Everything the menu bar icon shows, read fresh. */
async function trayState(): Promise<TrayState> {
  const config = await configuration.current()
  const options = appOptions(config)
  keepInTray = options.keepInTray
  const profileId = config.activeProfileId ?? null
  const listed = rendererSessions ?? sessions.list().filter((v) => !v.readOnly).map((v) => ({ id: v.id, title: v.label, state: v.state, agentId: v.agentId }))
  const stamped = stampSince(sessionSince, listed, Date.now())
  sessionSince = stamped.since
  const sessionsNow = stamped.sessions
  const [lists, today] = await Promise.all([codeHost.lists(profileId).catch(() => null), trayToday.read(profileId)])
  const agentNames = new Map(knownAgents(config).map((a) => [a.id, a.name]))
  const slackOn = lastSlack && lastSlack.health !== 'off'
  const me = lastSlack?.me ?? ''
  const openThreads = lastSlack?.threads.filter((th) => !th.closed) ?? []
  return {
    appName: app.getName(),
    sessions: sessionsNow,
    usage: usage.current().map((a) => ({ name: a.name || agentNames.get(a.agentId) || a.agentId, agentId: a.agentId, windows: a.windows, error: Boolean(a.error) })),
    pullRequests: lists && lists.state !== 'notConnected' ? { toReview: lists.toReview.length, mine: lists.mine.length } : null,
    prEvents: recentPrEvents,
    health: healthWatcher.summary(),
    slack: slackOn && lastSlack ? { health: lastSlack.health, open: openThreads.length, unread: openThreads.filter((th) => hasUnread(th, me)).length, error: lastSlack.lastError } : null,
    automations: automations
      .snapshot()
      .automations.filter((a) => a.definition.enabled && a.active)
      .map((a) => ({
        id: a.definition.id,
        name: a.definition.name,
        health: a.health,
        startedToday: a.startedToday,
        ...(a.waitReason ? { waitReason: a.waitReason.split('.')[0]! } : {}),
        ...(a.lastError ? { lastError: a.lastError } : {})
      })),
    notifications: notifier.recent().map((n) => ({ id: n.id, title: n.title, at: n.at, ...(n.sessionId ? { sessionId: n.sessionId } : {}) })),
    calendar: today.calendar,
    planDueToday: today.planDueToday,
    popover: options.trayPopover,
    pausedUntil: options.notificationsPausedUntil,
    // WORKHUB_SHOW_UPDATE_MENU=1 shows the item in a dev run, to try where it leads (the check itself needs a packaged build).
    canCheckForUpdates: app.isPackaged || process.env['WORKHUB_SHOW_UPDATE_MENU'] === '1'
  }
}

async function performTrayAction(action: TrayAction): Promise<void> {
  switch (action.kind) {
    case 'open':
      return showMain()
    case 'openSession':
      showMain()
      return send('notifications:open', action.id)
    case 'navigate':
      return navigate(action.route)
    case 'openPullRequest':
      return openPullRequestWindow(action.profileId || null, action.url)
    case 'openMeeting': {
      // Only a link the popover was given for that meeting is opened; without one, Plan shows it.
      const url = trayToday.joinUrl(action.id)
      if (url) return void openLink((await configuration.current()).activeProfileId ?? null, url)
      return navigate('plan')
    }
    case 'openSettings':
      return settingsWindow.open(settingsSectionArg(action.section))
    case 'openNotification':
      notifier.openRecent(action.id)
      return
    case 'clearNotifications':
      notifier.clearRecent()
      return
    case 'newSession':
      showMain()
      return send('tray:newSession')
    case 'pause':
    case 'resume': {
      if (loadError) return
      const until = action.kind === 'pause' ? pauseUntil(action.preset, new Date()) : 0
      const r = await configuration.saveOptions({ notificationsPausedUntil: until })
      if (r.ok) configChanged()
      return scheduleTray()
    }
    case 'checkForUpdates':
      // Straight to the Updates group, highlighted, where the check's result shows.
      navigate('settings', UPDATES_SETTINGS)
      void updates.check()
      return
    case 'quit':
      return app.quit()
  }
}

/** One window per pull request; opening an open one brings it to the front. */
const prWindows = new Map<string, BrowserWindow>()

function openPullRequestWindow(profileId: string | null, url: string, tab?: PullRequestWindowTab): void {
  const open = prWindows.get(url)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    open.focus()
    if (tab) open.webContents.send('codeHost:showTab', tab)
    return
  }
  const hash = `#pr?profile=${encodeURIComponent(profileId ?? '')}&url=${encodeURIComponent(url)}${tab ? `&tab=${tab}` : ''}`
  // Wide by default: the conversation sits beside the description and the diff gets the full width.
  const prWin = createAuxWindow(hash, 'Pull request', { width: 1280, height: 860, minWidth: 720, minHeight: 480 })
  prWindows.set(url, prWin)
  prWin.on('closed', () => prWindows.delete(url))
}

/** One review window per session; opening an open one brings it to the front. */
const reviewWindows = new Map<string, BrowserWindow>()

function openLocalReviewWindow(sessionId: string, reload = false): void {
  const open = reviewWindows.get(sessionId)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    // Drafts live in the main process, so a reload only refreshes the diff.
    if (reload) open.webContents.reload()
    open.focus()
    return
  }
  const reviewWin = createAuxWindow(`#review?session=${encodeURIComponent(sessionId)}`, 'Workhub 2', { width: 1280, height: 820, minWidth: 900, minHeight: 560 })
  reviewWindows.set(sessionId, reviewWin)
  reviewWin.on('closed', () => reviewWindows.delete(sessionId))
}

interface AuxWindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

const TICKET_WINDOW_SIZE: AuxWindowSize = { width: 820, height: 760, minWidth: 560, minHeight: 420 }
const FILE_WINDOW_SIZE: AuxWindowSize = { width: 900, height: 760, minWidth: 420, minHeight: 320 }
const REVIEW_LOOP_WINDOW_SIZE: AuxWindowSize = { width: 860, height: 820, minWidth: 480, minHeight: 400 }
const PLAN_ITEM_WINDOW_SIZE: AuxWindowSize = { width: 720, height: 780, minWidth: 460, minHeight: 400 }

/** A secondary window (a pull request, a ticket) on the same renderer, routed by its hash. */
function createAuxWindow(hash: string, title: string, size: AuxWindowSize = TICKET_WINDOW_SIZE, bounds?: WindowBounds): BrowserWindow {
  const aux = new BrowserWindow({
    ...size,
    ...(bounds ?? {}),
    title,
    backgroundColor: chromeColors().color,
    ...windowChrome(),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  // Links inside the app never navigate or open windows of their own.
  aux.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env['ELECTRON_RENDERER_URL']) void aux.loadURL(process.env['ELECTRON_RENDERER_URL'] + hash)
  else void aux.loadFile(rendererFile, { hash: hash.replace(/^#/, '') })
  return aux
}

const rendererFile = join(__dirname, '../renderer/index.html')
/** The only pages allowed to talk to the main process. */
const rendererOrigin = { fileUrl: pathToFileURL(rendererFile).href, devServerUrl: process.env['ELECTRON_RENDERER_URL'] }

/**
 * Every window and webview the app ever creates stays on the app's renderer: navigations and
 * redirects away from it are refused (web links go to the default browser instead), new windows
 * are denied, and <webview> tags never attach. A window that rendered untrusted Markdown (a pull
 * request, a ticket) can then never turn into a remote page that still holds `window.hub`.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (url === contents.getURL()) return
    event.preventDefault()
    void openLink(null, url)
  })
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererOrigin)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  // Links in agent replies open in the default browser, never inside the app.
  contents.setWindowOpenHandler(({ url }) => {
    void openLink(null, url)
    return { action: 'deny' }
  })
})

/** Web permission requests and checks are denied by default (see permissions.ts). */
function denyWebPermissions(): void {
  const trusted = (url: string | null) => isTrustedRendererUrl(url, rendererOrigin)
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(permissionAllowed(permission, details.requestingUrl || contents.getURL(), trusted))
  )
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permissionAllowed(permission, contents?.getURL(), trusted))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Workhub 2',
    backgroundColor: chromeColors().color,
    ...windowChrome(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // Navigation and new-window guards for every window: see 'web-contents-created' above.
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(rendererFile)
  appBadge.refresh()
  // "Keep running in the menu bar": closing hides the window; sessions, watchers and notifications go on.
  win.on('close', (event) => {
    if (allowWindowClose || !keepInTray || !trayService) return
    event.preventDefault()
    win?.hide()
  })
}

/** The renderer's popover route (main.tsx), in the dev server or the built files. */
function loadPopover(popover: BrowserWindow): void {
  if (process.env['ELECTRON_RENDERER_URL']) void popover.loadURL(process.env['ELECTRON_RENDERER_URL'] + TRAY_POPOVER_HASH)
  else void popover.loadFile(rendererFile, { hash: TRAY_POPOVER_HASH.slice(1) })
}

/**
 * Where a menu command runs: a session command in the focused session window (else the main
 * window's selection); navigation and new sessions always in the main window, brought up first.
 */
function runMenuCommand(command: MenuCommand): void {
  const focused = BrowserWindow.getFocusedWindow()
  const sessionWindow = sessionWindows.sessionOf(focused) !== undefined
  const sessionCommand = command.kind === 'closeSession' || command.kind === 'showMode' || command.kind === 'openInWindow'
  if (sessionCommand && sessionWindow && focused) return focused.webContents.send('menu:command', command)
  if (sessionCommand && focused !== win) return
  if (command.kind === 'navigate' && command.route === 'settings') return settingsWindow.open()
  showMain()
  send('menu:command', command)
}

let menuTimer: ReturnType<typeof setTimeout> | null = null
/** The application menu follows the active profile's agents and the UI language. */
function scheduleMenu(): void {
  if (menuTimer) return
  menuTimer = setTimeout(() => {
    menuTimer = null
    void refreshMenu()
  }, 100)
}

async function refreshMenu(): Promise<void> {
  const config = await configuration.current().catch(() => null)
  const agents = config ? resolveEffectiveAgents(config, config.activeProfileId ?? null) : []
  const { t } = trayText(trayLocale)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenuTemplate({
        platform: process.platform,
        appName: app.getName(),
        agents: agents.map((a) => ({ key: a.key, label: a.label, agentId: a.agent.id })),
        t,
        run: runMenuCommand,
        openHelp: () => void openLink(null, HELP_URL),
        openSetup: openSetupWindow,
        revealLogs,
        developer: !app.isPackaged
      })
    )
  )
}

/** Help → the project's page (the release repository's README). */
const HELP_URL = 'https://github.com/SoldierIced/workhub#readme'

/** The menu bar / notification area icon; a dev run is named "Workhub 2 Dev" there too. */
function startTray(): void {
  // Linux (AppIndicator) sends no clicks, so it keeps the native menu only.
  const popover =
    process.platform === 'darwin' || process.platform === 'win32'
      ? new TrayPopover({
          platform: process.platform,
          preload: join(__dirname, '../preload/index.js'),
          load: loadPopover,
          refresh: () => void trayService?.refresh(),
          pinned: process.env['WORKHUB_TRAY_POPOVER_PIN'] === '1',
          dark: () => nativeTheme.shouldUseDarkColors
        })
      : null
  trayPopover = popover
  trayService = new TrayService({
    appName: app.getName(),
    platform: process.platform,
    iconDir: app.isPackaged ? join(process.resourcesPath, 'tray') : join(appRoot, 'build', 'tray'),
    state: trayState,
    text: () => trayText(trayLocale),
    perform: (action) => void performTrayAction(action),
    activate: showMain,
    logPath: process.env['WORKHUB_TRAY_LOG'],
    popover: popover ?? undefined,
    onState: (state) => popover?.setView(buildTrayPopover(state))
  })
  trayService.start()
  popover?.prepare()
  // WORKHUB_TRAY_POPOVER_PIN=1 opens the popover once the page is up and keeps it open (screenshots).
  if (popover && process.env['WORKHUB_TRAY_POPOVER_PIN'] === '1') setTimeout(() => popover.show(trayService?.bounds() ?? { x: 0, y: 0, width: 0, height: 0 }), 2500)
  // Usage, pull request lists and Health change on their own; the menu catches up once a minute.
  setInterval(scheduleTray, 60_000).unref?.()
}

/** Marks that Workhub 1's folder switches were filled into the profiles once (see `fillWorkhub1FolderFlags`). */
const workhub1FolderFlags = new StateFile<{ done: boolean }>(join(dataDir, 'workhub1-folder-flags.json'), 0)

/** Fills the folder switches Workhub 1 turned on into the profiles that leave them unset; the new config when one changed. */
async function fillWorkhub1FolderFlagsFrom(v1: Workhub1Settings): Promise<Result<WorkhubConfig> | undefined> {
  let last: Result<WorkhubConfig> | undefined
  for (const profile of fillWorkhub1FolderFlags(v1, await configuration.current(), homedir())) {
    last = await configuration.saveProfile(profile)
    if (!last.ok) break
  }
  if (last?.ok) send('config:changed')
  return last
}

/** Once, at the first launch that finds Workhub 1's settings: profiles imported before the folder switches were imported get them. */
async function fillWorkhub1FolderFlagsOnce(): Promise<void> {
  if (loadError || workhub1FolderFlags.load({ done: false }).done) return
  try {
    const v1 = await readWorkhub1Settings()
    if (!v1) return
    await fillWorkhub1FolderFlagsFrom(v1)
    workhub1FolderFlags.save({ done: true })
    workhub1FolderFlags.flush()
  } catch {
    // Tried again at the next launch.
  }
}

/** Profiles with folders and no default folder get their first folder, so "New session" says where it starts. */
async function fillDefaultFoldersOnStart(): Promise<void> {
  if (loadError) return
  let changed = false
  for (const profile of fillDefaultFolders((await configuration.current()).profiles)) {
    if (!(await configuration.saveProfile(profile)).ok) break
    changed = true
  }
  if (changed) send('config:changed')
}

let controlServer: import('node:http').Server | null = null
/** How the control endpoint finds the profile of a request (the calling session's, a named one, the one owning the caller's folder, the active one). */
const controlProfiles = {
  sessionProfile: (id: string) => sessions.list().find((s) => s.id === id)?.profileId,
  // A reviewer may read the plan but never change it (writes answer 403).
  sessionReadOnly: (id: string) => sessions.list().find((s) => s.id === id)?.readOnly === true,
  profiles: async () => {
    const config = await configuration.current()
    return { ids: config.profiles.map((p) => p.id), active: config.activeProfileId ?? null }
  },
  folderProfile: async (path: string) => owningProfile(path, (await configuration.current()).profiles, homedir())?.id
}
void app.whenReady().then(async () => {
  // A second launch only hands over to the running app (its 'second-instance'): it must not touch
  // the socket, the config or any other file the running app owns.
  if (!firstInstance) return
  // Agents gain models between sessions (a Claude Code update, an alias that moved, a new Kiro): read
  // them again for every agent and account that can be listed once start-up has settled.
  setTimeout(() => {
    void configuration
      .current()
      .then((config) => agentOptions.refreshAll(listableAgentTargets(knownAgents(config), config.accounts)))
      .catch((err: unknown) => diagnostics.log.warn(`agent options: ${err instanceof Error ? err.message : String(err)}`))
  }, 8_000).unref()
  const controlDeps: ControlDeps = {
    openReview: (sessionId, repos) => {
      const v = sessions.list().find((s) => s.id === sessionId)
      if (!v) return { ok: false, status: 404, error: 'unknown session' }
      if (v.readOnly) return { ok: false, status: 403, error: 'a reviewer session cannot open a review' }
      localReview.request(sessionId, repos)
      openLocalReviewWindow(sessionId, true)
      return { ok: true }
    },
    saveFlowMap: (map) => saveFlowMap(join(dataDir, FLOW_MAPS_FOLDER), map, { keepAlerts: true }),
    addInboxItems: async (body) => {
      // A reviewer cannot propose items; a request without a session may (see resolveControlProfile).
      const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
      const who = await resolveControlProfile(controlProfiles, { session: b['session'], profile: b['profile'] }, { write: true })
      if (!who.ok) return who
      return addControlInboxItems({ service: planner, ...controlProfiles }, body)
    },
    plan: createPlanControl({
      ...controlProfiles,
      planner,
      agenda: (profileId) => planView({ calendar, briefs }, profileId),
      profile: async (profileId) => (await configuration.current()).profiles.find((p) => p.id === profileId)
    }),
    automations: createAutomationControl({
      ...controlProfiles,
      snapshot: () => automations.snapshot(),
      save: (a) => automations.save(a),
      agentKeys: async (profileId) => resolveEffectiveAgents(await configuration.current(), profileId).map((a) => a.key),
      history: () => namedHistory.get(10_000),
      messages: async (entry) => {
        const source = historySources[entry.agentId as keyof typeof historySources]
        if (!source) return []
        const config = await configuration.current()
        const account = entry.accountId ? (config.accounts.find((a) => a.id === entry.accountId) ?? null) : null
        const configDir = entry.agentId === 'claude' ? claudeConfigDirOf(config, account, homedir()) : (account?.configDir ?? undefined)
        return source.messages(entry.agentSessionId, entry.cwd ?? homedir(), configDir)
      },
      newId: () => crypto.randomUUID().slice(0, 8)
    }),
    log: (m) => diagnostics.log.warn(m)
  }
  if (loopbackControl) {
    const started = await startLoopbackControlServer(controlToken, controlDeps)
    controlServer = started?.server ?? null
    if (started) controlEndpoint = { url: started.url, token: controlToken }
  } else {
    const socket = controlSocketPath(dataDir)
    controlServer = await startControlServer(socket, controlDeps)
    if (controlServer) controlEndpoint = { socket }
  }
  try {
    await configuration.load()
    // Account environment values written by older builds move from config.json to the secret store.
    const moved = await configuration.migrateAccountEnv()
    if (moved) diagnostics.log.info(`moved ${moved} account environment value(s) to the secret store`)
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
  }
  if (scenario && !loadError) {
    try {
      if (await seedScenarioConfig(configuration, dataDir)) diagnostics.log.info(`demo scenario "${scenario}" seeded in ${dataDir}`)
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
      diagnostics.log.error(loadError)
    }
  }
  const startup = diagnostics.activity.begin('startup')
  denyWebPermissions()
  registerIpc()
  void remoteService.start()
  await refreshMenu()
  createWindow()
  // One after the other: both rewrite profiles.
  void fillWorkhub1FolderFlagsOnce().then(fillDefaultFoldersOnStart, () => undefined)
  await refreshOptionsCache()
  try {
    startTray()
  } catch {
    // No status area (some Linux desktops): closing the window then quits, as without the option.
    trayService = null
    trayPopover?.destroy()
    trayPopover = null
  }
  usage.start()
  tokenSpend.start()
  // Opt-in: nothing contacts GitHub unless the user turned this on (or presses "Check now").
  // A version found by these automatic checks is announced in a prompt, at most once a day.
  if (app.isPackaged) {
    setTimeout(() => void automaticUpdateCheck(), 10_000)
    setInterval(() => void automaticUpdateCheck(), UPDATE_RECHECK_MS)
  }
  prEvents.start()
  slack.start()
  void automations.start()
  aiReview.start()
  healthWatcher.start()
  flowAlertWatcher.start()
  metricAlerts.start()
  ticketWatcher.start()
  // The first calendar check runs before the renderer reports its language: word it in the system's.
  if (!trayLocaleFromRenderer) {
    const system = app.getLocale().slice(0, 2)
    if (isLocale(system)) trayLocale = system
  }
  calendarWatcher.start()
  planner.start()
  // First run: no profile yet and the welcome was not finished.
  const first = await configuration.current()
  if (!loadError && first.profiles.length === 0 && !appOptions(first).welcomeDone) openSetupWindow('welcome')
  startup()
  diagnostics.log.info('ready')
})

// macOS: clicking the Dock icon brings the hidden window back.
app.on('activate', (_event, hasVisibleWindows) => {
  if (showMainOnActivate(hasVisibleWindows)) showMain()
})

let quitting = false
/** Set once the app is quitting (or installing an update): closing the window then really closes it. */
let allowWindowClose = false
// macOS installs an update by closing every window before 'before-quit'.
nativeUpdater.on('before-quit-for-update', () => {
  allowWindowClose = true
  sessionWindows.suspend()
  settingsWindow.flush()
  openSessions.freeze()
})
app.on('before-quit', (event) => {
  void remoteService.stop()
  allowWindowClose = true
  // Session windows closing from here on stay remembered: the next launch reopens them.
  sessionWindows.suspend()
  settingsWindow.flush()
  openSessions.freeze()
  if (quitting) return
  diagnostics.log.info('quit')
  diagnostics.flush()
  flowHistory.flush()
  // Give agent processes a chance to exit before the app does.
  event.preventDefault()
  quitting = true
  usage.stop()
  kiroUsageReader?.dispose()
  tokenSpend.stop()
  prEvents.stop()
  slack.stop()
  automations.stop()
  aiReview.stop()
  localReview.stop()
  controlServer?.close()
  healthWatcher.stop()
  flowAlertWatcher.stop()
  metricAlerts.stop()
  ticketWatcher.stop()
  calendarWatcher.stop()
  planner.stop()
  sessionNames.flush()
  void sessions.stopAll().finally(() => app.quit())
})
// Kept in the menu bar, the app outlives its windows (a window closed some other way than its
// close button is opened again from the icon); otherwise closing the last window quits.
app.on('window-all-closed', () => {
  if (!(keepInTray && trayService) || allowWindowClose) app.quit()
})
// The hidden popover is a window too: once every other window is closed, the rule above applies.
app.on('browser-window-created', (_event, created) => {
  created.on('closed', () => {
    if (trayPopover?.isWindow(created)) return
    const others = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== created && !trayPopover?.isWindow(w))
    if (others.length === 0 && trayPopover && (!(keepInTray && trayService) || allowWindowClose)) app.quit()
  })
})
