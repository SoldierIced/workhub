import { app, autoUpdater as nativeUpdater, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, safeStorage, screen, shell, utilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { AcpRuntime, agentAvailability, discoverKiroOptions } from '@workhub/adapters/agent-acp'
import { CLAUDE_PERMISSION_MODES, ClaudeNativeRuntime, ClaudePlanUsageReader, ClaudeSessionHistory, discoverClaudeOptions } from '@workhub/adapters/agent-claude-native'
import { DemoChatSource, SlackAgentChatSource, SlackTrackingHook } from '@workhub/adapters/chat-slack'
import { ListenSummarizer } from '@workhub/adapters/listen-summary'
import { JsonConfigStore } from '@workhub/adapters/config-json'
import { EncryptionUnavailableError, SafeStorageSecretStore } from '@workhub/adapters/secrets-electron'
import { TerminalRuntime } from '@workhub/adapters/agent-terminal'
import { createCliRunner } from '@workhub/adapters/cli'
import { augmentedPath, pathKeyOf, refreshLoginPath, utf8LocaleEnv, withFoldersFirst } from '@workhub/adapters/login-path'
import { ManagedToolsInstaller } from '@workhub/adapters/managed-tools'
import { readNotificationPermission } from '@workhub/adapters/notification-permission'
import { ClaudeTranscriptReader, copyClaudeSession, readClaudeHandoffFacts } from '@workhub/adapters/transcript-claude'
import { CodexPlanUsageReader, CodexSessionHistory, CodexTranscriptReader } from '@workhub/adapters/transcript-codex'
import { KiroPlanUsageReader, KiroSessionHistory, KiroTranscriptReader, readKiroCreditEntries } from '@workhub/adapters/transcript-kiro'
import { GitReview, LocalChanges, LocalReverter } from '@workhub/adapters/git-review'
import { GitWorktrees } from '@workhub/adapters/git-worktree'
import { AutomationRunLog, BackgroundRuns, BACKUP_FOLDER, backupDatabase, DB_FILE, describeImport, importLegacyJson, listBackups, SessionRecords, SqliteFlowMaps, SqliteHistoryIndex, SqlitePrEventStore, Timelines, TurnIngest, repoProjects, WorkhubDb, type ProjectResolver } from '@workhub/adapters/sqlite-store'
import { DemoCalendarSource, IcsCalendarSource } from '@workhub/adapters/calendar-ics'
import { OpenCodeSessionHistory, OpenCodeTranscriptReader } from '@workhub/adapters/transcript-opencode'
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
  fillDefaultFolders,
  linkAutomationHistory,
  type HistoryEntry,
  type HistoryMessage,
  resolveEffectiveAgents,
  startOfLocalDay,
  usageAccountKey,
  validateConfig,
  quietNow,
  moduleScreens,
  type BoardsState,
  type CreditSpend,
  type Result,
  sessionIdentity,
  type SessionCeilings,
  type WorkhubConfig
} from '@workhub/core'
import type { AccountUsage, ConfigSnapshot, HistorySearchOptions, HistorySearchResult, UsageAlert } from '../shared/api'
import { Notifier } from './notifier'
import { createQuitGuard, watchSystemShutdown } from './quit-guard-electron'
import { TrayToday } from './tray-today'
import { trayText } from './tray-text'
import { AppBadge, attentionBadgeCount } from './app-badge'
import { profileWorkspaces } from './workspaces'
import { NotificationPermissionCheck } from './notification-permission'
import { FlowAlertWatcher, HealthWatcher, TicketWatcher, ticketSummaryWords } from './watchers'
import { AutomationService } from './automations'
import { registerChatIpc } from './chat-ipc'
import { registerSessionFilesIpc } from './session-files-ipc'
import { AgentOptionsService, listableAgentTargets, runsKiroCli } from './agent-options'
import { agentKeyBudget, AgentUsageService, DemoUsageProvider, usageAccounts } from './agent-usage'
import { AgentReviewService, registerAgentReviewIpc, reviewLoopWindows } from './agent-review'
import { AiReviewService, registerAiReviewIpc, reviewBudgetGate } from './ai-review'
import { claudeConfigDirOf } from './claude-accounts'
import { registerListenIpc } from './listen-ipc'
import { CodeHostService, registerCodeHostIpc } from './codehost'
import { PullRequestCreateService, registerPullRequestCreateIpc } from './pull-request-create'
import { ContinuityService, type ContinuityDeps } from './continuity'
import { HealthService } from './health-service'
import { guardIpc, isTrustedRendererUrl } from './ipc-guard'
import { timeIpc } from './ipc-timing'
import { recordIpc, RemoteActivityLog, RemoteHub, RemoteService, type RemoteHubDeps, type RemoteState } from './remote'
import { startDiagnostics } from './diagnostics'
import { createDiagnosticsExporter } from './diagnostics-export-app'
import { createUsageCsvExporter } from './usage-csv'
import { jobReports } from './job-reporter'
import { ChatJournals } from './chat-journal'
import { HISTORY_LIST_DEPTH, listAllHistory, searchAllHistory } from './history'
import { HistoryIndexer } from './history-indexer'
import { createTranscriptReader } from './transcript-worker-electron'
import { RecentCall } from './recent-call'
import { PrEventService, registerPrEventsIpc } from './pr-events-service'
import { OutputCoalescer } from './output-coalescer'
import { routeSessionEvent } from './terminal-routing'
import { SessionDriver } from './session-driver'
import { OwnerStarts } from './owner-starts'
import { resolveChoice, SessionManager, ticketPrefixes } from './session-manager'
import { registerLinksIpc } from './links'
import { LocalReviewService, registerLocalReviewIpc } from './local-review'
import { CONTROL_ENV_KEYS, controlEnv, controlSocketPath, newControlToken, reviewPathOutside, startControlServer, startLoopbackControlServer, usesLoopbackControl, type ControlDeps, type ControlEndpoint } from './control-server'
import { createAnalyticsControl } from './analytics-control'
import { ControlTokens } from './control-auth'
import { kiroUsageProbeEnabled } from './kiro-usage-probe'
import { AnalyticsQueries, type QueryWorker } from './analytics-queries'
import { StorageMaintenance } from './storage-maintenance'
import { DatabaseRestore } from './database-restore'
import { createAutomationControl } from './automation-control'
import { agentChangesWindow, createAgentChanges, journalControl, registerAgentChangesIpc, type AgentChangeState } from './agent-changes'
import { createPlanControl, resolveControlProfile } from './plan-control'
import { registerSessionRequestsIpc, SessionRequests } from './session-control'
import { FlowHistoryStore } from './flow-history'
import { saveFlowMap } from './flow-maps'
import { registerFlowMapsIpc } from './flow-maps-ipc'
import { boardsOn, createBoards, createBoardSaver } from './boards'
import { registerBoardsIpc } from './boards-ipc'
import { DemoMetricSource, HealthMetricSource, MetricAlertService, ProductMetricSource, type MetricAlertsState } from './metric-alerts'
import { registerMetricAlertsIpc } from './metric-alerts-ipc'
import { registerFileViewerIpc } from './file-viewer'
import { SlackWatcherService } from './slack-watcher'
import { registerTicketIpc } from './tickets'
import { TicketService } from './tickets-service'
import type { SpendSources, WorktreeLink } from '@workhub/adapters/token-spend'
import { ingestsTranscripts, spendSources, TokenSpendService, turnOwners, turnProjects } from './token-spend'
import { AnalyticsRecorder } from './analytics-recorder'
import { registerAnalyticsIpc, REPORT_BUDGET_MS } from './analytics-ipc'
import { ProjectBudgetAlerts, type MonthRow } from './project-budget-alerts'
import { ApiSpendService, CostLedger, spendAgentId, type CostLedgerState } from './api-spend'
import { backgroundUsage } from './background-usage'
import { UpdateService } from './updates'
import { readUpdatePromptState, shouldPromptUpdate, type UpdatePromptState } from './update-prompt'
import { buildAppMenuTemplate, isSessionCommand } from './app-menu'
import { SessionNames } from './session-names'
import { OpenSessions, type SavedOpenSessions } from './open-sessions'
import { boundsOnScreen, SessionWindows, type SavedSessionWindows } from './session-windows'
import { SettingsWindow, settingsSectionArg, type SavedSettingsWindow } from './settings-window'
import { broadcastingConfigStore } from './config-broadcast'
import type { MenuCommand } from '../shared/windows-api'
import { createLinkService } from './link-service'
import { systemLinkDeps } from './link-system'
import { accountSessionEnv, profileSessionEnv } from './profile-env'
import { showMainOnActivate } from './activation'
import { AgentToolsService, WORKHUB_MCP_SCRIPT, workhubMcpLaunch } from './agent-tools'
import { SetupInstaller } from './setup-install'
import { InstallQueue } from './setup-queue'
import { installContext, probe, SetupService } from './setup-service'
import { registerSignInIpc, SignInService } from './sign-in'
import { CalendarService, usableRead } from './calendar-service'
import { CalendarStateStore, CalendarWatcher } from './calendar-watcher'
import { demoScenario, demoSecretStore, seedScenarioAnalytics, seedScenarioConfig, seedScenarioState } from './demo-scenario'
import { BriefService } from './plan-briefs'
import { planView, registerPlanIpc } from './plan-ipc'
import { PlannerService, type PlannerState } from './planner-service'
import { addControlInboxItems, registerPlannerIpc } from './planner-ipc'
import { expandHome } from './automations'
import { defaultStartMode, gatePrompt, installPlanEntry, installQueue, owningProfile, profileFolderPaths, profileRefreshMs, productCalendarEvents, ticketsInProgress, type CalendarState } from '@workhub/core'
import { createWindows, FILE_WINDOW_SIZE, PLAN_ITEM_WINDOW_SIZE, REVIEW_LOOP_WINDOW_SIZE } from './windows'
import { createBroadcast } from './broadcast'
import { createTrayController } from './tray-controller'
import { createNotifications } from './notifications'
import { startServices, stopServices } from './lifecycle'
import { registerHubIpc } from './ipc/hub'
import { registerConfigIpc } from './ipc/config'
import { registerNotificationsIpc } from './ipc/notifications'
import { registerUpdatesIpc } from './ipc/updates'
import { registerHistoryIpc } from './ipc/history'
import { registerUsageIpc } from './ipc/usage'
import { registerSetupIpc } from './ipc/setup'
import { registerSessionsIpc } from './ipc/sessions'
import { registerHealthIpc } from './ipc/health'
import { registerStorageIpc } from './ipc/storage'
import { registerRemoteAccessIpc } from './ipc/remote'
import { windowsAppUserModelId } from './app-identity'

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

// Before any window or notification: the installed app takes the installer's id, so Windows groups
// it with its pinned taskbar icon instead of giving it a button of its own.
const appUserModelId = windowsAppUserModelId(process.platform, app.isPackaged)
if (appUserModelId) app.setAppUserModelId(appUserModelId)

// One instance per data folder (Electron keys the lock on userData): launching the app again (a
// Start menu entry, a desktop launcher) brings the running one up, which matters once closing the
// window only hides it in the menu bar / notification area.
const firstInstance = app.requestSingleInstanceLock()
if (!firstInstance) app.quit()
else app.on('second-instance', () => showMain())

// Always on: a rotated log in <dataDir>/logs with errors, event-loop stalls and slow IPC (Help → Reveal Logs).
const diagnostics = startDiagnostics(dataDir, { version: app.getVersion(), packaged: app.isPackaged })

// The app's state between launches (open sessions, watcher memory, ledgers, flow maps) lives in one
// SQLite database in the data folder; config.json and secrets.json stay files. A second instance
// (quitting at once, see above) never touches it: it gets a throwaway in-memory database.
function openDatabase(): WorkhubDb {
  if (!firstInstance) return WorkhubDb.open(':memory:', { log: () => {} })
  try {
    return WorkhubDb.open(join(dataDir, DB_FILE), { log: (m) => diagnostics.log.error(m) })
  } catch (err) {
    // Locked, disk full, read-only, no access: nothing to recover automatically, and starting with
    // empty state would hide the user's data. Say so and quit; the file is left as it is.
    const message = err instanceof Error ? err.message : String(err)
    diagnostics.log.error(message)
    diagnostics.flush()
    dialog.showErrorBox('Workhub 2 cannot open its database', `${message}\n\nThe data folder is ${dataDir}. See docs/troubleshooting.md, "The database".`)
    process.exit(1)
  }
}
const db = openDatabase()
if (firstInstance) diagnostics.log.info(`database ${db.path} schema=${db.schemaVersion()}`)
const recovery = db.recovered()
if (recovery) diagnostics.log.warn(`database was moved aside to ${recovery.movedTo} at ${new Date(recovery.at).toISOString()}: ${recovery.reason}`)
// WORKHUB_DEMO_SCENARIO=team-lead (`npm run demo`): the milestones, inbox and metric alerts of the scenario are written as
// JSON files before the first import, which stores them (never again once it ran); its profile is saved once the app is ready (see below).
const scenario = demoScenario()
if (scenario && firstInstance) seedScenarioState(dataDir, Date.now(), db)
// The JSON state files of earlier versions move into the database once and are renamed to `.migrated`.
if (firstInstance) {
  try {
    const imported = importLegacyJson(db, dataDir, (m) => diagnostics.log.warn(m))
    diagnostics.log.info(describeImport(imported) ?? 'legacy JSON import: nothing to import')
  } catch (err) {
    // Nothing was renamed (the files are moved only after the commit): the next start tries again.
    diagnostics.log.error(`legacy JSON import failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
// What the usage reports read: sessions and their links and tags, every automation run, and the
// pull request and ticket timelines (the turns come from the transcript scan, see `turnIngest`).
const sessionRecords = new SessionRecords(db)
const automationRuns = new AutomationRunLog(db)
// Agents' read-only SQL (the analytics endpoint) runs in a utility process on its own read-only
// connection to the same file; a query past its time budget gets the process killed.
const spawnAnalyticsWorker = (serviceName: string) => (): QueryWorker => {
  const child = utilityProcess.fork(join(__dirname, 'analytics-worker.js'), [], { serviceName, stdio: 'ignore' })
  return {
    post: (m) => child.postMessage(m),
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', (code) => fn(code)),
    kill: () => child.kill()
  }
}
const analyticsQueries = new AnalyticsQueries({ path: db.path, spawn: spawnAnalyticsWorker('Workhub analytics'), log: (m) => diagnostics.log.warn(m) })
// The Usage and reports screen's queries, in a second process of the same worker: they never wait
// behind an agent's query (or get it killed), and their longer budget suits a large `turns` table.
const usageReports = new AnalyticsQueries({ path: db.path, spawn: spawnAnalyticsWorker('Workhub usage reports'), budgetMs: REPORT_BUDGET_MS, log: (m) => diagnostics.log.warn(m) })
const timelines = new Timelines(db)
// The demo's weeks of synthetic sessions and turns, written once into an empty database.
if (scenario && firstInstance && seedScenarioAnalytics(db, dataDir)) diagnostics.log.info('demo scenario: synthetic usage history seeded')

/** A copy of the database in `<data folder>/backups`: the day's automatic one, or a new dated one when `manual`. */
async function backupDb(manual: boolean): Promise<string | null> {
  const path = await backupDatabase(db, join(dataDir, BACKUP_FOLDER), { manual })
  if (path) diagnostics.log.info(`database backed up to ${path}`)
  return path
}
if (firstInstance) {
  const daily = () => void backupDb(false).catch((err: unknown) => diagnostics.log.warn(`database backup failed: ${err instanceof Error ? err.message : String(err)}`))
  setTimeout(daily, 30_000).unref?.()
  setInterval(daily, 24 * 3_600_000).unref?.()
}
// 12 months of usage detail, then daily summaries; Compact now runs VACUUM with both workers stopped.
const storageMaintenance = new StorageMaintenance({ db, stats: () => usageReports.storage(), exclusive: (task) => usageReports.exclusive(() => analyticsQueries.exclusive(task)), log: (m) => diagnostics.log.info(m) })
if (firstInstance) storageMaintenance.start()
// Restore…: checked now, swapped in on the way out once the database is closed (see will-quit), then relaunched.
const databaseRestore = new DatabaseRestore({
  dbPath: join(dataDir, DB_FILE),
  backupDir: join(dataDir, BACKUP_FOLDER),
  stopJobs: () => storageMaintenance.stop(),
  relaunchAndQuit: () => {
    app.relaunch()
    app.quit()
  },
  showError: (m) => dialog.showErrorBox('Workhub 2 could not restore the backup', m),
  log: (m) => diagnostics.log.info(m)
})

/** Help → Export diagnostics…: logs, versions, job table, database size and the redacted config in a folder. */
jobReports.attach(diagnostics.log)
const exportDiagnostics = createDiagnosticsExporter({
  window: () => windows.liveMain(),
  logsDir: diagnostics.logsDir,
  flush: () => diagnostics.flush(),
  jobs: () => jobReports.table(),
  storage: () => ({ path: db.path, sizeBytes: db.sizeBytes(), backupFolder: '', lastBackup: listBackups(join(dataDir, BACKUP_FOLDER))[0] ?? null, recovered: db.recovered() }),
  config: () => configuration.current()
})

/** Help → Reveal Logs: the log file selected in the file manager, written up to now. */
function revealLogs(): void {
  diagnostics.flush()
  shell.showItemInFolder(diagnostics.logPath)
}

/** The agent and account a start resolves to, as the session manager picks them (the profile that owns the folder wins). */
const startModeOf: RemoteHubDeps['startMode'] = async (input) => {
  const config = await configuration.current()
  const owner = owningProfile(input.cwd, config.profiles, homedir())
  const owned = owner && owner.id !== input.profileId && resolveChoice(config, owner.id, input.agentKey) ? owner.id : input.profileId
  const choice = resolveChoice(config, owned, input.agentKey)
  if (!choice) return null
  return {
    configured: defaultStartMode(config, choice.agent.id, choice.account),
    modes: async () => {
      const options = await agentOptions.get(choice.agent, choice.account)
      return { modes: options.modes, permissionModes: options.modeSemantics === 'permission' }
    }
  }
}
/** Every window's handlers, reachable by a paired device too (Settings → Remote access); filled by registerIpc. */
const recordedIpc = recordIpc(timeIpc(guardIpc(ipcMain, (url) => isTrustedRendererUrl(url, windows.rendererOrigin)), diagnostics))
/** The latest sub-agents and background tasks of each session, for a device that connects late. */
const remoteActivity = new RemoteActivityLog()
const remoteHub = new RemoteHub({
  handlers: recordedIpc.handlers,
  profileFolders: async (profileId) => {
    const config = await configuration.current()
    const profile = profileId ? config.profiles.find((p) => p.id === profileId) : undefined
    return profile ? (await profileWorkspaces(profile, homedir())).map((f) => f.path) : []
  },
  startMode: startModeOf,
  firstPrompt: (id) => chatJournal.firstPrompt(id),
  log: diagnostics.log
})
/** The main window, the secondary windows and the guards every window gets (windows.ts). */
const windows = createWindows({
  preload: join(__dirname, '../preload/index.js'),
  rendererFile: join(__dirname, '../renderer/index.html'),
  mainCreated: () => appBadge.refresh(),
  allowMainClose: () => allowWindowClose || !tray.keepInTray() || !tray.running(),
  syncPopoverTheme: () => tray.popover()?.syncTheme(),
  openLink: (url) => void openLink(null, url),
  log: diagnostics.log
})
const { showMain, createAuxWindow, openSetupWindow, openPullRequestWindow, openLocalReviewWindow } = windows
// Every session's chat, so a window that loads later rebuilds it; chat messages go out numbered.
const chatJournal = new ChatJournals()
/** Every send to the windows and paired devices goes through here (broadcast.ts). */
const broadcast = createBroadcast({
  journal: chatJournal,
  main: () => windows.liveMain(),
  sessionWindows: () => sessionWindows,
  settingsWindow: () => settingsWindow,
  hub: remoteHub
})
const send = broadcast.send
/** Tells every window, and every paired device, that the config changed. */
const configChanged = () => {
  broadcast.toWindowsAndDevices('config:changed')
}
// Every write tells every window (`config:changed`): a change in the Settings window shows in the main window.
const configPath = join(dataDir, 'config.json')
const configStore = broadcastingConfigStore(new JsonConfigStore(configPath), configChanged)
const safeSecrets = new SafeStorageSecretStore(join(dataDir, 'secrets.json'), safeStorage)
// A demo (synthetic data) still seeds its profile on a machine without an OS keyring.
const secrets = scenario ? demoSecretStore(safeSecrets, (err) => err instanceof EncryptionUnavailableError) : safeSecrets
const configuration = new ConfigurationService(configStore, secrets)
let loadError: string | undefined
// The main window asked for the sessions of the last run; they are reopened once the config loads.
let sessionsWanted = false
// WORKHUB_DEMO_CODEHOST=1 reads synthetic pull requests instead of a real host (screenshots, demos).
// The demo moves on one step at a time (`prEvents.demoAdvance`) so pull request events can be seen.
let demoPrStep = 0
const codeHost = new CodeHostService(() => configuration.current(), { demo: process.env['WORKHUB_DEMO_CODEHOST'] === '1', demoStep: () => demoPrStep, onListsChanged: () => scheduleTray(), onChanged: (url, profileId) => broadcast.toWindows('codeHost:changed', url, profileId) })
const prEvents = new PrEventService({
  source: codeHost,
  store: new SqlitePrEventStore(db),
  config: () => configuration.current(),
  emit: (batch) => send('prEvents:events', batch),
  onEvents: (batch) => automations.onPrEvents(batch),
  record: (profileId, events) => void timelines.appendPrEvents(profileId, events),
  demo: process.env['WORKHUB_DEMO_CODEHOST'] === '1' ? { advance: () => ++demoPrStep } : undefined
})
// WORKHUB_DEMO_HEALTH=1 serves synthetic environments, so Health can be shown without a cluster.
// Flow-map measures kept hour by hour (the screens read a week), so maps draw from the database and read only new hours.
const flowHistory = new FlowHistoryStore(db, Date.now, (m) => diagnostics.log.warn(m))
if (firstInstance) flowHistory.prune()
const flowMaps = new SqliteFlowMaps(db)
// Live boards: one row of the database per profile; announced to windows only (never to a paired device).
const boards = createBoards({
  stateFor: (profileId) => db.state<BoardsState>('boards:' + profileId, 5000),
  changed: (profileId, boardId) => broadcast.toWindows('boards:changed', profileId, boardId)
})
const health = new HealthService({ configuration, secrets, demo: process.env['WORKHUB_DEMO_HEALTH'] === '1', flowMaps, flowHistory })
// WORKHUB_DEMO_TICKETS=1 serves synthetic tickets, so the UI can be shown without credentials.
const ticketService = new TicketService(configuration, secrets, process.env['WORKHUB_DEMO_TICKETS'] === '1', undefined, scenario ?? undefined)
// WORKHUB_DEMO_CALENDAR=1 serves synthetic meetings around now, so Plan can be shown without a calendar address.
const calendar = new CalendarService({ configuration, secrets, source: new IcsCalendarSource(), demo: process.env['WORKHUB_DEMO_CALENDAR'] === '1' ? new DemoCalendarSource(Date.now, scenario ? productCalendarEvents : undefined) : null })

// Terminal output goes out batched (one message per frame per channel), only to the windows that can show it; everything else at once.
const sessionOutput = new OutputCoalescer((e) => routeSessionEvent(e, broadcast.sessionEvents))
// Sessions in windows of their own ("Open in New Window"); the session's runtime stays here, shared.
const sessionWindows = new SessionWindows({
  create: (hash, size, bounds) =>
    createAuxWindow(hash, 'Workhub 2', size, boundsOnScreen(bounds, screen.getAllDisplays().map((d) => d.workArea), size)),
  mainWindow: () => windows.liveMain(),
  showMain: () => showMain(),
  exists: (id) => sessions.list().some((s) => s.id === id),
  identityOf: (id) => {
    const view = sessions.list().find((s) => s.id === id)
    return view ? sessionIdentity(view) : undefined
  },
  store: db.state<SavedSessionWindows>('session-windows', 500)
})
// Settings in a window of its own, one at a time (⌘,, the gear button, the menu bar icon, setup fixes).
const settingsWindow = new SettingsWindow({
  create: (hash, size, bounds) => createAuxWindow(hash, 'Workhub 2', size, bounds),
  screens: () => screen.getAllDisplays().map((d) => d.workArea),
  quitting: () => allowWindowClose,
  store: db.state<SavedSettingsWindow>('settings-window', 500)
})

// Menu bar / notification area icon (tray-controller.ts) and what it shows that main does not keep elsewhere.
const tray = createTrayController({
  preload: join(__dirname, '../preload/index.js'),
  iconDir: app.isPackaged ? join(process.resourcesPath, 'tray') : join(appRoot, 'build', 'tray'),
  configuration,
  codeHost,
  sessions: () => sessions,
  usage: () => usage,
  health: () => healthWatcher,
  automations: () => automations,
  notifier: () => notifier,
  today: () => trayToday,
  updates: () => updates,
  showMain,
  loadPopover: windows.loadPopover,
  openPullRequestWindow,
  openSettings: (section) => settingsWindow.open(settingsSectionArg(section)),
  navigate: (route, section) => navigate(route, section),
  openLink: (profileId, url) => openLink(profileId, url),
  send,
  loadError: () => loadError,
  configChanged,
  scheduleMenu: () => scheduleMenu(),
  setBadgeCount: (rendered) => appBadge.setCount(attentionBadgeCount(rendered))
})
const scheduleTray = tray.schedule

/** The number of sessions that need a look, on the app icon (Dock, taskbar button, launcher). */
const appBadge = new AppBadge({
  platform: process.platform,
  setBadgeCount: (count) => void app.setBadgeCount(count),
  setOverlay: (bitmap, description) => {
    const win = windows.liveMain()
    if (!win) return
    win.setOverlayIcon(bitmap ? nativeImage.createFromBitmap(bitmap.data, { width: bitmap.size, height: bitmap.size, scaleFactor: 2 }) : null, description)
  },
  describe: (count) => trayText(tray.locale()).tn('tray.tooltip.attention', count)
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
  store: db.state<RemoteState>('remote', 200),
  secrets,
  hub: remoteHub,
  connect: (url) => new WebSocket(url),
  defaultName: () => hostname().replace(/\.local$/, ''),
  onChanged: (status) => send('remote:changed', status),
  log: diagnostics.log,
  // A pushed notification about a waiting request may deny it (main/remote/permission-tickets.ts).
  pendingPermissions: (id) => sessions.list().find((s) => s.id === id)?.pendingPermissions ?? []
})

/** The OS notifications Workhub words itself and where a click leads (notifications.ts). */
const notifications = createNotifications({
  configuration,
  notifier: () => notifier,
  sessions: () => sessions,
  automations: () => automations,
  sessionWindows: () => sessionWindows,
  liveMain: () => windows.liveMain(),
  showMain,
  openSettings: (section) => settingsWindow.open(settingsSectionArg(section)),
  openPullRequestWindow,
  openTicketWindow: () => openTicketWindow,
  openLink: (profileId, url) => openLink(profileId, url),
  send,
  locale: () => tray.locale(),
  notePrEvent: (event) => tray.notePrEvent(event),
  scheduleTray,
  log: (m) => diagnostics.log.warn(m)
})
const { navigate, showPullRequestInMain, showSessionNotification, showUsageNotification, showPullRequestNotification, ticketNotification, healthNotification, flowAlertNotification, meetingReminder, demoBriefNotice, metricAlertNotification } = notifications

// Workhub 1's Agent SDK bridge, run with Electron's own Node. Packaged: staged into the resources
// folder with its node_modules (scripts/stage-bridge.mjs); dev: straight from the adapters source.
const bridgeDir = app.isPackaged ? join(process.resourcesPath, 'bridge') : join(repoRoot, 'packages', 'adapters', 'src', 'agent-claude-native', 'bridge')

/**
 * The PATH agents and terminals start with: the login shell's (read once, in the background), so an
 * app opened from the Finder or the Dock finds the same CLIs as a terminal does. Until it is read,
 * and when it cannot be, the inherited PATH plus the usual CLI folders. Windows: unchanged.
 */
Object.assign(process.env, utf8LocaleEnv(process.platform, process.env))
const launchPath = process.env[pathKeyOf(process.env)]
// The tools Workhub installs for itself (Node.js, Git on Windows, gh, glab, npm agents) live in its
// data folder and come first on every PATH, Windows included, so a clean machine needs nothing else.
const managedTools = new ManagedToolsInstaller({
  toolsDir: join(dataDir, 'tools'),
  platform: process.platform,
  arch: process.arch,
  // Chromium's network stack: the system proxy settings apply, as in a browser.
  fetch: (url, init) => net.fetch(url, init),
  env: () => process.env
})
const toolFolders = managedTools.pathFolders()
let cliPath = withFoldersFirst(augmentedPath({ platform: process.platform, inherited: launchPath, loginShell: null }), toolFolders)
// The same PATH goes into this process's environment, which gh, glab and git inherit: they would
// otherwise run under the Finder's bare PATH while Setup (sessionPath) finds them. Read again after
// a Setup install, which may have added a folder to the shell profile.
const refreshCliPath = async (): Promise<void> => {
  const path = await refreshLoginPath(process.env, launchPath)
  if (path) cliPath = withFoldersFirst(path, toolFolders)
  process.env[pathKeyOf(process.env)] = withFoldersFirst(process.env[pathKeyOf(process.env)] ?? '', toolFolders)
}
process.env[pathKeyOf(process.env)] = process.platform === 'win32' ? withFoldersFirst(launchPath ?? '', toolFolders) : cliPath
void refreshCliPath()
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
// Claude transcripts are parsed in a utility process, never on this one (a 50 MB file froze every window).
const transcriptReader = createTranscriptReader((m) => diagnostics.log.warn(m))
const claudeHistory = new ClaudeSessionHistory({ bridgeDir, transcripts: transcriptReader.read })
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
  state: db.state('agent-options', 500)
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
const costLedger = new CostLedger(db.state<CostLedgerState>('api-spend-ledger', 1_000))
/** A session reported its running cost: kept for the API spend of agents not read from files. */
function recordSessionCost(sessionId: string, amount: number): void {
  const view = sessions.list().find((v) => v.id === sessionId)
  if (!view?.agentId) return
  const agent = configCache ? knownAgents(configCache).find((a) => a.id === view.agentId) : undefined
  costLedger.record(spendAgentId(agent, view.agentId), view.agentSessionId ?? view.id, amount)
}
// Every assistant turn of every transcript (tokens, cost, agent time) for the usage reports: read
// after each spend scan, from the same folders, only what was appended since the last one.
// Never in a demo: the demo's history is synthetic (see `seedScenarioAnalytics`).
let owners: ReturnType<typeof turnOwners> | null = null
let projects: ProjectResolver | null = null
const turnWorktrees = new Map<string, WorktreeLink | null>()
const turnIngest = new TurnIngest(db, {
  accountOf: (agent, dir) => owners?.accountOf(agent, dir) ?? null,
  profileOf: (cwd) => owners?.profileOf(cwd) ?? null,
  projects: (paths) => (projects ? projects(paths) : repoProjects(paths, turnWorktrees)),
  log: (m) => diagnostics.log.info(m)
})
// A project crossing 80 % or 100 % of its monthly budget is announced after the scan that read the turn.
const projectBudgetAlerts = new ProjectBudgetAlerts({
  options: async () => appOptions(await configuration.current()),
  month: async (since, until) => (await usageReports.report({ name: 'totals', query: { since, until, groupBy: 'project' } })) as MonthRow[],
  store: db.state<unknown>('project-budget-alerts', 500),
  text: () => trayText(tray.locale()),
  locale: () => tray.locale(),
  show: (words) => showUsageNotification(words),
  log: (m) => diagnostics.log.warn(m)
})
async function scanTurns(sources: SpendSources): Promise<void> {
  const config = await configuration.current()
  owners = turnOwners(config, homedir())
  turnWorktrees.clear()
  projects = await turnProjects(config, homedir(), turnWorktrees)
  const started = Date.now()
  try {
    const r = await turnIngest.scan(sources)
    if (r.read) diagnostics.log.info(`turn scan done in ${Date.now() - started}ms: ${r.read}/${r.files} transcripts read, ${r.turns} turns`)
  } catch (err) {
    diagnostics.log.warn(`turn scan failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  void projectBudgetAlerts.check()
}
// The model runs Workhub starts by itself (Slack reads, Listen summaries) as usage: one turn each.
const background = backgroundUsage(new BackgroundRuns(db), { log: (m) => diagnostics.log.warn(m) })
// Token spend per folder for Home: scanned in the background from start-up, cached on disk.
const tokenSpend = new TokenSpendService({
  background: () => background.week(),
  config: () => configuration.current(),
  store: db.state('token-spend', 2_000),
  sources: async () => spendSources(await configuration.current(), homedir(), kiroDir),
  emit: () => send('usage:folderSpendChanged'),
  begin: (label) => diagnostics.activity.begin(label),
  onScanned: ({ ms, files, failed }) => diagnostics.log.info(`token spend scan ${failed ? 'failed' : 'done'} in ${ms}ms, ${files} files`),
  ...(ingestsTranscripts() ? { turns: scanTurns } : {})
})
// Spend of agents billed by API key, per agent and day (Home's usage and token spend cards).
const apiSpend = new ApiSpendService({ config: () => configuration.current(), home: homedir(), costs: (include) => tokenSpend.costs(include), ledger: costLedger })
// The names the user gave sessions, by identity (Rename…).
const sessionNames = new SessionNames(db.state('session-names', 300))
// Tools an agent runs can ask Workhub for things (review, flow maps, Plan): a Unix socket, or on
// Windows a loopback port with a per-launch token, known once it listens.
const loopbackControl = usesLoopbackControl()
const controlToken = newControlToken()
// Set only once the endpoint listens; sessions started before (or when it cannot listen) get none.
let controlEndpoint: ControlEndpoint | null = null
// Each session's own token for the endpoint, minted at its start and revoked when it is removed.
const controlTokens = new ControlTokens()
// The sessions Workhub runs and what their monitors relate them to, for the usage reports.
const analyticsRecorder = new AnalyticsRecorder({
  records: sessionRecords,
  agentOf: (v) => spendAgentId(configCache ? knownAgents(configCache).find((a) => a.id === v.agentId) : undefined, v.agentId),
  log: (m) => diagnostics.log.warn(m) })
const sessions = new SessionManager({
  config: configuration,
  log: (m) => diagnostics.log.warn(m),
  worktrees: new GitWorktrees(),
  text: (key, params) => trayText(tray.locale()).t(key, params),
  sessionEnv: (sessionId) => controlEnv(sessionId, controlEndpoint, () => controlTokens.mint(sessionId)),
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
    analyticsRecorder.onEvent(e)
    remoteActivity.onEvent(e)
    sessionOutput.push(e)
  },
  emitChanged: (s) => {
    // A session that stopped wrote its transcript: History's search index reads it again shortly.
    if (s.state === 'stopped' || s.state === 'error') historyIndexer.refreshSoon()
    driver.onChanged(s)
    continuity.onChanged(s)
    aiReview.onChanged(s)
    analyticsRecorder.sessionChanged(s)
    send('session:changed', s)
    sessionWindows.sessionChanged(s.id)
    openSessions.changed()
  },
  emitRemoved: (id) => {
    controlTokens.revoke(id)
    sessionRequests.forget(id)
    analyticsRecorder.sessionRemoved(id)
    remoteActivity.forget(id)
    send('session:removed', id)
    sessionWindows.closeSession(id)
    openSessions.changed()
  },
  emitReplay: (id, messages) => send('session:replay', id, messages),
  emitConfigChanged: configChanged
})
// The sessions open at the last quit, reopened once the main window listens (Settings → General).
const openSessions = new OpenSessions({
  store: db.state<SavedOpenSessions>('open-sessions', 500),
  list: () => sessions.list(),
  engineOf: (id) => sessions.engineOf(id),
  firstPrompt: (id) => chatJournal.firstPrompt(id),
  start: async (input, extra) => {
    // A session waiting stopped has no prompt loaded yet: its title comes from the stored one, else from History.
    let title = extra.title
    if (extra.dormant && !title && input.resumeAgentSessionId) {
      const past = await namedHistory.get(60_000).catch(() => null)
      title = past?.entries.find((e) => e.agentSessionId === input.resumeAgentSessionId)?.title
    }
    const { firstPrompt, ...rest } = extra
    const view = await sessions.start(input, { restored: true, ...rest, ...(title ? { title } : {}) })
    if (firstPrompt) chatJournal.restoreFirstPrompt(view.id, firstPrompt)
    return view
  },
  setMode: (id, mode) => sessions.setMode(id, mode),
  folderExists: (path) => stat(path).then((s) => s.isDirectory(), () => false),
  enabled: async () => appOptions(await configuration.current()).reopenSessions,
  startAtLaunch: async () => appOptions(await configuration.current()).startSessionsAtLaunch,
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
const kiroUsageState = db.state<{ sessionId: string | null }>('kiro-usage', 200)
let configCache: WorkhubConfig | null = null
let kiroUsageReader: KiroPlanUsageReader | null = null
// Reading Kiro plan usage starts `kiro-cli acp`, which refreshes the Kiro sign-in token: off in
// development and test runs unless WORKHUB_KIRO_USAGE=1 (see kiro-usage-probe.ts).
const kiroUsageProbe = kiroUsageProbeEnabled(app.isPackaged, process.env)
if (!kiroUsageProbe && !demoUsage) diagnostics.log.info('Kiro plan usage is off in development (set WORKHUB_KIRO_USAGE=1 to read it)')
// Each session's own usage ceilings, by session identity (set from the session's side panel).
const sessionBudgets = db.state<Record<string, SessionCeilings>>('session-budgets', 200)
const usage = new AgentUsageService({
  providers: demoUsage
    ? [new DemoUsageProvider('claude'), new DemoUsageProvider('codex'), new DemoUsageProvider('kiro')]
    : [
        new ClaudePlanUsageReader({ userAgent: `workhub/${app.getVersion()}` }),
        new CodexPlanUsageReader(),
        ...(kiroUsageProbe ? [kiroUsageReader = new KiroPlanUsageReader({
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
        })] : [])
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
      accounts: [...(options.claudePlanUsage ? claude : []), ...(options.codexUsage ? codex : []), ...(options.kiroUsage && (kiroUsageProbe || demoUsage) ? kiro : [])],
      budget: options.usageBudget,
      knownKeys: [...claude, ...codex, ...kiro].map((a) => usageAccountKey(a.agentId, a.accountId))
    }
  },
  emit: (u: AccountUsage[]) => {
    send('usage:changed', u)
    scheduleTray()
  },
  alert: (alerts: UsageAlert[]) => (usageAlertsReady ? send('usage:alerts', alerts) : pendingUsageAlerts.push(...alerts)),
  alertState: db.state('usage-alerts', 500),
  apiSpend: () => apiSpend.summary()
})
const budgetOf = (agentId: string, accountId: string | null) => usage.budgetOf(agentId, accountId)

/** Asks before quitting while sessions are busy, and can wait for them to go idle (see quit-guard.ts). */
const quitGuard = createQuitGuard({
  views: () => sessions.list(),
  queuedPrompts: () => sessions.queuedPromptCount(),
  text: () => trayText(tray.locale()),
  publish: (pending) => send('quit:pending', pending),
  showMain: () => showMain()
})
const updates = new UpdateService((s) => send('updates:changed', s), (url) => openLink(null, url))
// "A new version is available": after an automatic check, at most once a day, never for a skipped version.
const updatePromptFile = db.state<UpdatePromptState>('update-prompt', 0)
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
  if (!windows.liveMain()) return
  saveUpdatePrompt({ lastPromptAt: Date.now() })
  send('updates:prompt', status)
}

// Slack watcher and automations (P6a). WORKHUB_DEMO_SLACK=1 reads synthetic Slack instead of
// asking an agent, and never touches a Claude account's settings.
const driver = new SessionDriver(sessions, (id, text) => send('automations:prompted', id, text))
// What agents ask of other sessions over the control endpoint, waiting for the user (session-control.ts).
const sessionRequests = new SessionRequests({
  sessions: () => sessions.list(),
  profile: async (profileId) => {
    const config = await configuration.current()
    const profile = profileId ? config.profiles.find((p) => p.id === profileId) : undefined
    return { agents: resolveEffectiveAgents(config, profileId).map((a) => ({ key: a.key, name: a.label })), folders: profile ? profileFolderPaths(profile, homedir()).map((f) => f.path) : [] }
  },
  startMode: startModeOf,
  start: (input) => sessions.start(input),
  rename: (id, name) => sessions.rename(id, name),
  deliver: (id, text) => driver.deliver(id, text),
  notify: (n) => showSessionNotification(n),
  changed: (requests) => send('sessionRequests:changed', requests),
  text: (key, params) => trayText(tray.locale()).t(key, params),
  log: (m) => diagnostics.log.warn(m)
})
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
  state: db.state('slack-state', 500),
  driver,
  startSession: (input) => sessions.start(input),
  ownerStarts,
  home: homedir(),
  usage: () => usage.current(),
  budgetOf,
  background,
  myPullRequests: async () => {
    const lists = await codeHost.lists((await configuration.current()).activeProfileId ?? null)
    return new Set(lists.mine.map((i) => canonicalUrl(i.pr.url)))
  },
  prState: async (url) => {
    return codeHost.prState((await configuration.current()).activeProfileId ?? null, url)
  },
  emit: (snap) => {
    tray.setSlack(snap)
    // PR windows show Slack badges and a Slack tab too: every window gets the snapshot.
    broadcast.toWindows('slack:changed', snap)
    scheduleTray()
  },
  notice: (n) => send('slack:notice', n)
})
const automations = new AutomationService({
  configuration,
  driver,
  startSession: (input) => sessions.start(input),
  watcher: slack,
  state: db.state('automations-state', 300),
  home: homedir(),
  usage: () => usage.current(),
  budgetOf,
  emit: (snap) => {
    send('automations:changed', snap)
    scheduleTray()
  },
  configChanged: () => send('config:changed'),
  notice: (n) => send('slack:notice', n),
  recordRuns: (runs, profileOf) => void automationRuns.record(runs, profileOf),
  log: (m) => diagnostics.log.info(m)
})

// Plan: reminders and meeting briefs (the `calendar-state` key of `kv_state` keeps what fired and which briefs started).
const calendarState = new CalendarStateStore(db.state<CalendarState>('calendar-state', 500))
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
  formatTime: (ms) => new Intl.DateTimeFormat(tray.locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms),
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
  state: db.state('ai-review-state', 500),
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
  // Content HEAD does not have (an untracked or new file) goes to the system trash, never deleted.
  reverter: new LocalReverter({ trash: (path) => shell.trashItem(path) }),
  myPullRequests: async (profileId) => {
    const lists = await Promise.race([codeHost.lists(profileId), new Promise<null>((r) => setTimeout(() => r(null), 5_000))]).catch(() => null)
    return lists?.mine ?? []
  },
  emit: (sessionId, delivery) => broadcast.toWindows('localReview:delivery', sessionId, delivery),
  history: (sessionId) => sessions.history(sessionId),
  touchedRepos: async (sessionId) => {
    const cwd = sessions.cwdOf(sessionId)
    return cwd ? ((await localGit.localChanges(cwd, sessions.changePathsOf(sessionId)))?.repos ?? []) : []
  }
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
    configPath,
    loadError,
    ...(loadError ? { loadIssues: configuration.loadFailure()?.issues ?? [] } : {})
  }
}

/** Loads the config file again: after the user fixed it, the app works with it without a restart. */
async function reloadConfig(): Promise<ConfigSnapshot> {
  try {
    await configuration.load()
    loadError = undefined
    const moved = await configuration.migrateAccountEnv()
    if (moved) diagnostics.log.info(`moved ${moved} account environment value(s) to the secret store`)
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
  }
  configChanged()
  scheduleMenu()
  void refreshOptionsCache()
  if (!loadError && sessionsWanted) restoreSessions()
  return snapshot()
}

/** Never against the empty stand-in config: its start-up would drop every stored session. */
function restoreSessions(): void {
  void openSessions.restore().catch((err: unknown) => diagnostics.log.warn(`could not reopen the sessions of the last run: ${err instanceof Error ? err.message : String(err)}`))
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
const setupPath = () => [sessionPath() ?? process.env['PATH'] ?? '', ...fallbackPath].filter(Boolean).join(delimiter)
const setupInstaller = new SetupInstaller({ arch: process.arch, managed: managedTools, context: () => installContext(probe, { ...process.env, PATH: setupPath() }, process.platform) })
// "Install what is missing" and each row's Install: one queue, progress to every window.
const installs = new InstallQueue({
  install: (id, options) => setupInstaller.install(id, options),
  emit: (snapshot) => broadcast.toWindows('setup:installProgress', snapshot),
  afterEach: refreshCliPath
})
const setup = new SetupService({
  arch: process.arch,
  config: () => configuration.current(),
  hasSecret: (ref) => secrets.has(ref),
  path: setupPath,
  agents: (config) => knownAgents(config),
  home: homedir(),
  agentSkills: () => agentTools.skillsSummary(),
  slackFailure: async () => {
    const snapshot = await slack.snapshot()
    return snapshot.health === 'failing' ? (snapshot.lastError ?? 'failing') : null
  }
})
// Signing in to a tool inside Workhub (the setup rows' "Sign in"): a terminal runtime of its own,
// with the same PATH and bundled Claude Code as sessions, so a sign-in is never a session.
const signIn = new SignInService({
  config: () => configuration.current(),
  home: homedir(),
  path: () => [sessionPath() ?? process.env['PATH'] ?? '', ...fallbackPath].filter(Boolean).join(delimiter),
  terminal: new TerminalRuntime({ path: sessionPath, fallbackPath }),
  openWindow: (id, closed) => windows.openSignInWindow(id, closed),
  openUrl: (url) => void links.open(url),
  signedIn: () => broadcast.toWindows('setup:changed')
})

// Listing the history starts a process per account that reads the newest transcripts' heads: calls
// made meanwhile share it, and the sidebar's lookups (several right after start-up) take one up to
// 10 s old. Each account lists `historyDepth` sessions, deeper once the user asks for older ones;
// older sessions the search index holds are listed from it, not read again.
let historyDepth = HISTORY_LIST_DEPTH
let listedDepth = 0
const namedHistory = new RecentCall(async () => {
  const depth = historyDepth
  const config = await configuration.current()
  const result = await diagnostics.activity.run('history list', async () =>
    listAllHistory(config, homedir(), historySources, { depth, indexed: (agentId, accountId) => historyIndex?.entries(agentId, accountId) ?? [] })
  )
  listedDepth = depth
  // A session the user named shows that name in the history too; an automation's runs say which one they are.
  const named = result.entries.map((e) => ({ ...e, title: sessionNames.get(e.agentSessionId) ?? e.title }))
  return { ...result, entries: linkAutomationHistory(named, config.automations ?? [], automations.engine.snapshot().owned, homedir()) }
})

/** A past session's conversation, read with its account's config folder. */
async function pastMessages(entry: HistoryEntry): Promise<HistoryMessage[]> {
  const source = historySources[entry.agentId as keyof typeof historySources]
  if (!source) return []
  const config = await configuration.current()
  const account = entry.accountId ? (config.accounts.find((a) => a.id === entry.accountId) ?? null) : null
  const configDir = entry.agentId === 'claude' ? claudeConfigDirOf(config, account, homedir()) : (account?.configDir ?? undefined)
  return source.messages(entry.agentSessionId, entry.cwd ?? homedir(), configDir)
}

// History's full-text index lives in workhub.db; a database without FTS5 leaves search to the plain match.
let historyIndex: SqliteHistoryIndex | null = null
try {
  historyIndex = new SqliteHistoryIndex(db)
} catch (err) {
  diagnostics.log.error(`history index unavailable: ${err instanceof Error ? err.message : String(err)}`)
}
const historyIndexer = new HistoryIndexer({
  index: historyIndex ?? { isOpen: false, stamps: () => new Map(), write: () => [][Symbol.iterator](), remove: () => undefined },
  // The listing History shows, up to a minute old (a few seconds after a session stopped): indexing never starts a second read of every account.
  list: (fresh) => namedHistory.get(fresh ? 3_000 : 60_000),
  messages: pastMessages,
  onProgress: (p) => send('history:indexProgress', p),
  log: (m) => diagnostics.log.warn(m)
})

/** History search over the index plus the plain match of what it does not have yet. */
async function searchPastSessions(query: string, options: HistorySearchOptions): Promise<HistorySearchResult> {
  const listing = await namedHistory.get(30_000)
  return searchAllHistory(listing, historyIndex, query, options, historyIndexer.progress())
}

/**
 * Every window's IPC, one registrar per domain (`ipc/<domain>.ts` and the services' own `register…Ipc`).
 * New wiring: a new domain adds its registrar call here; a new channel of an existing domain goes in its file.
 */
function registerIpc(): void {
  // Every handler answers only the app's own renderer (see ipc-guard.ts).
  // Every handler is timed too: a slow one or one that fails is logged by its channel (see ipc-timing.ts).
  const ipc = recordedIpc.ipc
  registerHubIpc(ipc, {
    log: diagnostics.log,
    mainWindow: windows.main,
    revealLogs,
    exportDiagnostics,
    setChromeOverride: windows.setChromeOverride,
    syncTitleBarOverlay: windows.syncTitleBarOverlay,
    configuration,
    openLink: (url, profileId) => links.open(url, profileId)
  })
  registerConfigIpc(ipc, {
    configuration,
    secrets,
    snapshot,
    reloadConfig,
    guarded,
    configChanged,
    refreshUsage: () => void usage.refresh(),
    refreshOptionsCache: () => void refreshOptionsCache()
  })
  registerNotificationsIpc(ipc, { showSessionNotification, notificationPermission, showMain })
  registerUpdatesIpc(ipc, { updates, quitGuard, saveUpdatePrompt })
  registerHistoryIpc(ipc, {
    named: namedHistory,
    deepen: () => {
      historyDepth += HISTORY_LIST_DEPTH
    },
    listedShallower: () => listedDepth < historyDepth,
    search: searchPastSessions,
    indexer: historyIndexer
  })
  registerUsageIpc(ipc, {
    configuration,
    extraPath,
    agentPath: () => [sessionPath() ?? process.env['PATH'] ?? '', ...fallbackPath].filter(Boolean).join(delimiter),
    agentOptions,
    usage,
    kiroSpend,
    apiSpend,
    tokenSpend,
    sessionBudgets,
    send,
    showUsageNotification,
    alertsReady: () => {
      usageAlertsReady = true
      if (pendingUsageAlerts.length) send('usage:alerts', pendingUsageAlerts.splice(0))
    }
  })
  registerSignInIpc(ipc, signIn)
  registerSetupIpc(ipc, {
    setup,
    installs: {
      install: async (id) => {
        const done = installs.start([id])
        if (!done) return { ok: false, output: '', reason: 'busy' }
        const item = (await done).items[0]
        return item?.state === 'done' ? { ok: true, output: '' } : { ok: false, output: item?.detail ?? '', ...(item?.reason ? { reason: item.reason } : {}) }
      },
      plan: async (ids) => {
        const context = await installContext(probe, { ...process.env, PATH: setupPath() }, process.platform, process.arch)
        return installQueue(ids, context, managedTools.hasNode()).flatMap((id) => installPlanEntry(id, context) ?? [])
      },
      installMany: async (ids) => {
        const context = await installContext(probe, { ...process.env, PATH: setupPath() }, process.platform, process.arch)
        return installs.start(installQueue(ids, context, managedTools.hasNode())) !== null
      },
      retry: (id) => installs.retry(id) !== null,
      cancel: () => installs.cancel(),
      state: () => installs.snapshot(),
      tools: {
        folder: () => managedTools.toolsDir,
        list: () => managedTools.installed(),
        remove: async (id) => {
          const result = await managedTools.remove(id)
          await refreshCliPath()
          // An open setup check or welcome still shows the tool as installed.
          if (result.ok) broadcast.toWindows('setup:changed')
          return result
        }
      }
    },
    agentTools,
    openSetupWindow,
    setupWindow: windows.setupWindow,
    settingsWindow,
    configuration,
    loadError: () => loadError,
    configChanged,
    folders: () => {
      // Some Linux desktops have no Documents folder: the home folder stands in.
      let documents = homedir()
      try {
        documents = app.getPath('documents')
      } catch {
        /* no Documents folder */
      }
      return { home: homedir(), documents }
    }
  })
  openTicketWindow = registerTicketIpc({
    ipcMain: ipc,
    openLink,
    service: ticketService,
    createWindow: createAuxWindow,
    mainWindow: windows.main,
    broadcast: broadcast.toWindows
  }).openWindow
  registerSessionsIpc(ipc, {
    sessions,
    chatJournal,
    send,
    mainWindow: windows.main,
    liveMain: windows.liveMain,
    sessionsWanted: () => {
      sessionsWanted = true
      if (!loadError) restoreSessions()
    },
    configuration,
    configChanged,
    ownerStarts,
    driver,
    localGit,
    sessionWindows,
    continuity
  })
  registerSessionFilesIpc(ipc, { cwdOf: (id) => sessions.cwdOf(id) ?? null })
  registerCodeHostIpc(ipc, { service: codeHost, openWindow: openPullRequestWindow, showInWorkhub: showPullRequestInMain, openExternal: (url, profileId) => openLink(profileId, url) })
  registerPullRequestCreateIpc(ipc, new PullRequestCreateService({ sessions: () => sessions.list(), codeHost, brief: (id) => agentReview.briefOf(id) }))
  registerLinksIpc({ ipcMain: ipc, loadConfig: () => configuration.current(), mainWindow: windows.main })
  registerPrEventsIpc(ipc, { service: prEvents, notify: showPullRequestNotification, recognizes: (profileId, url) => codeHost.recognizes(profileId, url) })
  registerHealthIpc(ipc, health)
  registerStorageIpc(ipc, { db, dataDir, backupDb, storageMaintenance, databaseRestore })
  // The usage reports and session tags (main window only: not in the remote allowlist).
  registerAnalyticsIpc(ipc, { db, records: sessionRecords, scan: () => tokenSpend.scanNow(), reports: (r) => usageReports.report(r), exportCsv: createUsageCsvExporter({ window: windows.liveMain }) })
  registerSessionRequestsIpc(ipc, sessionRequests)
  registerAgentChangesIpc(ipc, agentChanges, agentChangesWindow((hash, title) => createAuxWindow(hash, title, { width: 780, height: 820, minWidth: 480, minHeight: 400 })))
  registerBoardsIpc(ipc, {
    boards,
    enabled: (profileId) => boardsOn({ modules: boardModules }, profileId)
  })
  registerFlowMapsIpc(ipc, {
    maps: flowMaps,
    pickFiles: async () => {
      const r = await dialog.showOpenDialog(windows.main()!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'JSON', extensions: ['json'] }], defaultPath: homedir() })
      return r.canceled ? [] : r.filePaths
    },
    saveFile: async (name, text) => {
      const r = await dialog.showSaveDialog(windows.main()!, { defaultPath: join(homedir(), name), filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (r.canceled || !r.filePath) return null
      await writeFile(r.filePath, text, { encoding: 'utf8' })
      return r.filePath
    },
    createWindow: (hash, title) => createAuxWindow(hash, title, { width: 1320, height: 900, minWidth: 760, minHeight: 520 }),
    mainWindow: windows.main,
    writeImage: async (dataUrl) => {
      const image = nativeImage.createFromDataURL(dataUrl)
      if (image.isEmpty()) return false
      // Electron 45's clipboard is the W3C-shaped one: items of MIME-typed blobs.
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
      return true
    }
  })
  registerMetricAlertsIpc(ipc, metricAlerts)
  registerRemoteAccessIpc(ipc, { remoteService, sessions, remoteActivity, localReview, aiReview, agentReview })
  registerChatIpc(ipc, { slack, automations, configuration, guarded })
  // The chat's Listen button: a long agent message is summarized (one small Haiku query) before it is read aloud.
  const listenSummarizer = new ListenSummarizer({ bridgeDir, cwd: dataDir })
  registerListenIpc(ipc, {
    summarize: (request) => listenSummarizer.summarize(request),
    config: () => configuration.current(),
    session: (id) => sessions.list().find((v) => v.id === id) ?? null,
    home: homedir(),
    log: (m) => diagnostics.log.warn(m),
    background
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
  registerPlanIpc(ipc, { calendar, briefs })
  registerPlannerIpc(ipc, planner, {
    alert: async (profileId, key) => (await metricAlerts.list(profileId)).alerts.find((a) => a.key === key),
    alertSent: (profileId, key) => metricAlerts.setStatus(profileId, key, { type: 'sendToInbox' }),
    createWindow: (hash, title) => createAuxWindow(hash, title, PLAN_ITEM_WINDOW_SIZE)
  })
  tray.registerIpc(ipc)
}

let openTicketWindow: ((profileId: string, key: string) => void) | null = null

const healthWatcher = new HealthWatcher({
  activeProfileId: async () => (await configuration.current()).activeProfileId ?? null,
  read: (profileId) => health.get(profileId),
  alert: healthNotification,
  alertSettings: async (profileId) => (await configuration.current()).profiles.find((p) => p.id === profileId)?.health?.alerts,
  changed: scheduleTray,
  cooldowns: (() => {
    const file = db.state<{ firedAt: Record<string, number> }>('health-alerts', 500)
    return { load: () => file.load({ firedAt: {} }).firedAt ?? {}, save: (firedAt) => file.save({ firedAt }), flush: () => file.flush() }
  })()
})

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
    const file = db.state<{ firedAt: Record<string, number> }>('flow-alerts', 500)
    return { load: () => file.load({ firedAt: {} }).firedAt ?? {}, save: (firedAt) => file.save({ firedAt }), flush: () => file.flush() }
  })()
})

const calendarWatcher = new CalendarWatcher({
  profiles: () => calendar.plannerProfiles(),
  read: async (profileId) => {
    return usableRead(await calendar.read(profileId))
  },
  store: calendarState,
  remind: meetingReminder,
  // The synthetic calendar never starts a brief by itself (that would spend tokens just for opening the demo): it says so.
  brief: (profileId, action) =>
    process.env['WORKHUB_DEMO_CALENDAR'] === '1' ? demoBriefNotice(action) : briefs.brief(profileId, action.event, { ruleId: action.ruleId, ...(action.automationId ? { automationId: action.automationId } : {}) }),
  log: (m) => diagnostics.log.warn(m)
})

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
  store: db.state<MetricAlertsState>('metric-alerts', 1_000),
  notify: metricAlertNotification,
  changed: (profileId) => send('metricAlerts:changed', profileId),
  demo: demoHealth
})

// Plan milestones and inbox (the `planner-state` key of `kv_state`: per profile, user data rather than settings).
const planner = new PlannerService({
  profiles: async () => (await configuration.current()).profiles,
  store: db.state<PlannerState>('planner-state', 500),
  tracker: (profileId, connectionId) => ticketService.trackerFor(profileId, connectionId),
  // Every window (the main one, and the windows of single inbox items and milestones) and every paired device.
  changed: (profileId) => broadcast.toWindowsAndDevices('planner:changed', profileId)
})
// What agents change over the control endpoint, kept for Keep or Revert on Home (desktop windows only).
const agentChanges = createAgentChanges({ store: db.state<AgentChangeState>('agent-changes', 0), changed: (list) => broadcast.toWindows('agentChanges:changed', list), automations, flowMaps, planner, sessions: () => sessions.list() })

const ticketWatcher = new TicketWatcher({
  activeProfileId: async () => (await configuration.current()).activeProfileId ?? null,
  enabled: async () => appOptions(await configuration.current()).notifyTickets,
  list: (profileId) => ticketService.call(profileId, (t, ignored) => t.listAssigned({ ignoredStatuses: ignored })),
  store: db.state('ticket-watch', 500),
  announce: ticketNotification,
  record: (profileId, changes, at) => void timelines.appendTicketChanges(profileId, changes, at),
  // A burst (a profile not read for a day, a capped list) folds into one notification.
  announceSummary: (_profileId, changes) => void notifier.show('tickets', ticketSummaryWords(changes, trayText(tray.locale()).t), () => navigate('tickets')),
  intervalMs: async (profileId) => profileRefreshMs(await configuration.current(), profileId, 'tracker')
})

async function refreshOptionsCache(): Promise<void> {
  const options = appOptions(await configuration.current())
  tray.setKeepInTray(options.keepInTray)
  quitGuard.setEnabled(options.confirmQuit)
  appBadge.setEnabled(options.showAppBadge)
  scheduleTray()
}

/** The popover's "Today": the active profile's next meetings and the Plan tasks due. */
const trayToday = new TrayToday({ readCalendar: (profileId) => calendar.read(profileId), dueToday: (profileId) => planner.dueToday(profileId) })

// Navigation, new-window and webview guards and crash recovery for every window the app creates (windows.ts).
windows.guardWebContents()

/**
 * Where a menu command runs: a session command in the focused session window (else the main
 * window's selection); navigation and new sessions always in the main window, brought up first.
 */
function runMenuCommand(command: MenuCommand): void {
  const focused = BrowserWindow.getFocusedWindow()
  const sessionWindow = sessionWindows.sessionOf(focused) !== undefined
  const sessionCommand = isSessionCommand(command)
  if (sessionCommand && sessionWindow && focused) return focused.webContents.send('menu:command', command)
  // ⌘F is also Settings' own search: another window gets the key back instead of losing it.
  if (command.kind === 'findInChat' && focused && focused !== windows.main()) return focused.webContents.send('menu:command', command)
  if (sessionCommand && focused !== windows.main()) return
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
  const { t } = trayText(tray.locale())
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
        exportDiagnostics: () => void exportDiagnostics(),
        developer: !app.isPackaged
      })
    )
  )
}

/** Help → the project's page (the release repository's README). */
const HELP_URL = 'https://github.com/SoldierIced/workhub#readme'

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
const boardModules = async (profileId: string) => (await configuration.current()).profiles.find((p) => p.id === profileId)?.modules
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
  const controlDeps: ControlDeps = journalControl({
    auth: controlTokens.auth(() => sessions.list()),
    openReview: async (sessionId, repos) => {
      const v = sessions.list().find((s) => s.id === sessionId)
      if (!v) return { ok: false, status: 404, error: 'unknown session' }
      if (v.readOnly) return { ok: false, status: 403, error: 'a reviewer session cannot open a review' }
      // An agent may only point the review at its own folder, its worktree or its profile's folders.
      const profile = (await configuration.current()).profiles.find((p) => p.id === v.profileId)
      const roots = [v.cwd, ...(profile ? profileFolderPaths(profile, homedir()).map((f) => f.path) : [])]
      const outside = reviewPathOutside(repos, roots)
      if (outside) return { ok: false, status: 400, error: `not inside this session's folder, worktree or profile folders: ${outside}` }
      localReview.request(sessionId, repos)
      openLocalReviewWindow(sessionId, true)
      return { ok: true }
    },
    saveFlowMap: (map) => saveFlowMap(flowMaps, map, { keepAlerts: true }),
    // Not a change an agent made: journalControl copies this dep as it is and records nothing for it.
    saveBoard: createBoardSaver({
      ...controlProfiles,
      boards,
      modules: boardModules,
      chatOf: (id) => {
        const view = sessions.list().find((s) => s.id === id)
        return view ? sessionIdentity(view) : undefined
      }
    }),
    addInboxItems: async (body) => {
      // A reviewer cannot propose items; the session in the body is the caller's (bound by its token).
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
      search: (query, options) => searchPastSessions(query, options),
      messages: pastMessages,
      newId: () => crypto.randomUUID().slice(0, 8),
      runs: (query) => automationRuns.list(query)
    }),
    analytics: createAnalyticsControl({ ...controlProfiles, db, queries: analyticsQueries, log: (m) => diagnostics.log.info(m) }),
    sessions: sessionRequests,
    log: (m) => diagnostics.log.warn(m)
  }, agentChanges)
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
      if (await seedScenarioConfig(configuration, dataDir)) {
        diagnostics.log.info(`demo scenario "${scenario}" seeded in ${dataDir}`)
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
      diagnostics.log.error(loadError)
    }
  }
  const startup = diagnostics.activity.begin('startup')
  windows.denyWebPermissions()
  registerIpc()
  void remoteService.start()
  await refreshMenu()
  windows.createWindow()
  // One after the other: both rewrite profiles.
  void fillDefaultFoldersOnStart().catch(() => undefined)
  await refreshOptionsCache()
  watchSystemShutdown(quitGuard)
  tray.start()
  // Each service's place in the order is in lifecycle.ts (START_ORDER).
  startServices({
    usage: () => usage.start(),
    tokenSpend: () => tokenSpend.start(),
    permissionReminders: notifications.startReminders,
    // A version found by these automatic checks is announced in a prompt, at most once a day.
    updateChecks: () => {
      if (app.isPackaged) {
        setTimeout(() => void automaticUpdateCheck(), 10_000)
        setInterval(() => void automaticUpdateCheck(), UPDATE_RECHECK_MS)
      }
    },
    prEvents: () => prEvents.start(),
    slack: () => slack.start(),
    automations: () => void automations.start(),
    aiReview: () => aiReview.start(),
    healthWatcher: () => healthWatcher.start(),
    flowAlertWatcher: () => flowAlertWatcher.start(),
    metricAlerts: () => metricAlerts.start(),
    ticketWatcher: () => ticketWatcher.start(),
    trayLocale: tray.adoptSystemLocale,
    calendarWatcher: () => calendarWatcher.start(),
    calendarOnResume: () =>
      powerMonitor.on('resume', () => {
        setTimeout(() => {
          void calendar.plannerProfiles().then(async (ps) => {
            await Promise.all(ps.map((p) => calendar.read(p.id, true).catch(() => null)))
            await calendarWatcher.tick()
          })
        }, 5_000)
      }),
    planner: () => planner.start(),
    historyIndexer: () => historyIndexer.start()
  })
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
  if (firstInstance) db.flushAll()
})
app.on('before-quit', (event) => {
  // Busy sessions: ask first (or wait for idle); nothing below runs until the quit is decided.
  if (quitGuard.intercept(() => app.quit())) return event.preventDefault()
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
  // Each service's place in the order is in lifecycle.ts (STOP_ORDER).
  stopServices({
    usage: () => usage.stop(),
    permissionReminders: notifications.stopReminders,
    kiroUsage: () => kiroUsageReader?.dispose(),
    tokenSpend: () => tokenSpend.stop(),
    prEvents: () => prEvents.stop(),
    slack: () => slack.stop(),
    automations: () => automations.stop(),
    aiReview: () => aiReview.stop(),
    localReview: () => localReview.stop(),
    controlServer: () => controlServer?.close(),
    healthWatcher: () => healthWatcher.stop(),
    flowAlertWatcher: () => flowAlertWatcher.stop(),
    metricAlerts: () => metricAlerts.stop(),
    ticketWatcher: () => ticketWatcher.stop(),
    calendarWatcher: () => calendarWatcher.stop(),
    planner: () => planner.stop(),
    historyIndexer: () => historyIndexer.stop(),
    sessionNames: () => sessionNames.flush(),
    database: () => {
      if (firstInstance) db.flushAll()
    }
  })
  void sessions.stopAll().finally(() => app.quit())
})
// Last: every pending state is written and the database closed once nothing else will write.
// A second instance only ever had the throwaway in-memory database: nothing to write.
// The analytics worker's read connection is gone first (its process has exited), so the close's
// checkpoint empties the write-ahead log and no `workhub.db-wal` outlives the app.
let dbClosed = false
app.on('will-quit', (event) => {
  historyIndexer.stop()
  transcriptReader.close()
  if (dbClosed) return
  event.preventDefault()
  const closeDb = () => {
    if (dbClosed) return
    dbClosed = true
    if (firstInstance) {
      db.close()
      databaseRestore.finish()
    }
    // A quit asked for again from here is ignored once will-quit was cancelled; everything ran, so exit.
    app.exit(0)
  }
  void Promise.all([analyticsQueries.closeAndWait(2000), usageReports.closeAndWait(2000)]).then(closeDb, closeDb)
})
// Kept in the menu bar, the app outlives its windows (a window closed some other way than its
// close button is opened again from the icon); otherwise closing the last window quits.
app.on('window-all-closed', () => {
  if (!(tray.keepInTray() && tray.running()) || allowWindowClose) app.quit()
})
// The hidden popover is a window too: once every other window is closed, the rule above applies.
app.on('browser-window-created', (_event, created) => {
  created.on('closed', () => {
    const trayPopover = tray.popover()
    if (trayPopover?.isWindow(created)) return
    const others = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== created && !trayPopover?.isWindow(w))
    if (others.length === 0 && trayPopover && (!(tray.keepInTray() && tray.running()) || allowWindowClose)) app.quit()
  })
})
