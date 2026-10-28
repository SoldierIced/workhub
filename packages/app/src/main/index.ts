import { execFile } from 'node:child_process'
import { app, autoUpdater as nativeUpdater, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, session, shell, type BrowserWindowConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AcpRuntime, agentAvailability, discoverKiroOptions } from '@workhub/adapters/agent-acp'
import { CLAUDE_PERMISSION_MODES, ClaudeNativeRuntime, ClaudePlanUsageReader, ClaudeSessionHistory } from '@workhub/adapters/agent-claude-native'
import { DemoChatSource, SlackAgentChatSource, SlackTrackingHook } from '@workhub/adapters/chat-slack'
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
import { JsonPrEventStore } from '@workhub/adapters/pr-events-json'
import { OpenCodeSessionHistory, OpenCodeTranscriptReader } from '@workhub/adapters/transcript-opencode'
import { readKeychainItem, readWorkhub1Settings } from '@workhub/adapters/workhub1-import'
import {
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
  type Workhub1Settings,
  TRAY_ROUTES,
  resolveEffectiveAgents,
  startOfLocalDay,
  usageAccountKey,
  validateConfig,
  type HealthAlert,
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
import { healthAlertWords, isLocale, trayText } from './tray-text'
import { AppBadge, attentionBadgeCount } from './app-badge'
import { profileWorkspaces } from './workspaces'
import { NotificationPermissionCheck } from './notification-permission'
import { HealthWatcher, TicketWatcher } from './watchers'
import type { Locale } from '../renderer/i18n/translate'
import { AutomationService } from './automations'
import { registerChatIpc } from './chat-ipc'
import { AgentOptionsService, runsKiroCli } from './agent-options'
import { agentKeyBudget, AgentUsageService, DemoUsageProvider, usageAccounts } from './agent-usage'
import { AiReviewService, registerAiReviewIpc, reviewBudgetGate } from './ai-review'
import { claudeConfigDirOf } from './claude-accounts'
import { CodeHostService, registerCodeHostIpc } from './codehost'
import { ContinuityService } from './continuity'
import { HealthService } from './health-service'
import { guardIpc, isTrustedRendererUrl } from './ipc-guard'
import { permissionAllowed } from './permissions'
import { listAllHistory } from './history'
import { PrEventService, registerPrEventsIpc } from './pr-events-service'
import { SessionDriver } from './session-driver'
import { OwnerStarts } from './owner-starts'
import { resolveChoice, SessionManager, ticketPrefixes } from './session-manager'
import { registerLinksIpc } from './links'
import { LocalReviewService, registerLocalReviewIpc } from './local-review'
import { registerFileViewerIpc } from './file-viewer'
import { SlackWatcherService } from './slack-watcher'
import { StateFile } from './state-file'
import { registerTicketIpc } from './tickets'
import { TicketService } from './tickets-service'
import { spendSources, TokenSpendService } from './token-spend'
import { ApiSpendService, CostLedger, spendAgentId, type CostLedgerState } from './api-spend'
import { UpdateService } from './updates'
import { buildAppMenuTemplate } from './app-menu'
import { SessionNames } from './session-names'
import { OpenSessions, type SavedOpenSessions } from './open-sessions'
import { boundsOnScreen, SessionWindows, type SavedSessionWindows, type WindowBounds } from './session-windows'
import type { MenuCommand, SessionSnapshot } from '../shared/windows-api'
import { linkCommand } from './link-opener'
import { profileSessionEnv, saveProfileEnv, storedProfileEnvNames } from './profile-env'
import { SetupService } from './setup-service'
import type { SetupPage } from '../shared/setup-api'

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

const configStore = new JsonConfigStore(join(dataDir, 'config.json'))
const secrets = new SafeStorageSecretStore(join(dataDir, 'secrets.json'), safeStorage)
const configuration = new ConfigurationService(configStore, secrets)
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
const health = new HealthService({ configuration, secrets, demo: process.env['WORKHUB_DEMO_HEALTH'] === '1' })
// WORKHUB_DEMO_TICKETS=1 serves synthetic tickets, so the UI can be shown without credentials.
const ticketService = new TicketService(configuration, secrets, process.env['WORKHUB_DEMO_TICKETS'] === '1')

let win: BrowserWindow | null = null
/** What session and sub-agent windows follow too: the sessions' live state and what their screens show. */
const SHARED_CHANNELS = new Set(['session:event', 'session:changed', 'session:removed', 'session:replay', 'automations:prompted', 'automations:turnEnded', 'aiReview:changed', 'usage:changed'])
const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  if (SHARED_CHANNELS.has(channel)) sessionWindows.broadcastShared(channel, args)
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

// Menu bar / notification area icon (tray.ts) and what it shows that main does not keep elsewhere.
let trayService: TrayService | null = null
/** The window a click on the icon opens (macOS, Windows); Linux keeps the native menu. */
let trayPopover: TrayPopover | null = null
/** Since when each session shows its state (the popover's times). */
let sessionSince = new Map<string, SinceEntry>()
let trayLocale: Locale = 'en'
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
  onShown: scheduleTray
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
// Models and modes each agent offers before a session starts (Kiro: its listing commands; others: their last session).
const agentOptions = new AgentOptionsService({
  discover: (agent) => (runsKiroCli(agent) ? discoverKiroOptions(createCliRunner(cliPath.split(delimiter)), agent.command) : null),
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
  emit: () => send('usage:folderSpendChanged')
})
// Spend of agents billed by API key, per agent and day (Home's usage and token spend cards).
const apiSpend = new ApiSpendService({ config: () => configuration.current(), home: homedir(), costs: (include) => tokenSpend.costs(include), ledger: costLedger })
// The names the user gave sessions, by identity (Rename…).
const sessionNames = new SessionNames(new StateFile(join(dataDir, 'session-names.json'), 300))
const sessions = new SessionManager({
  config: configuration,
  names: sessionNames,
  profileEnv: async (profileId, cwd) => {
    const config = await configuration.current()
    return profileSessionEnv(config.profiles.find((p) => p.id === profileId), cwd, secrets, homedir())
  },
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
  emitConfigChanged: () => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('config:changed'))
})
// The sessions open at the last quit, reopened once the main window listens (Settings → General).
const openSessions = new OpenSessions({
  store: new StateFile<SavedOpenSessions>(join(dataDir, 'open-sessions.json'), 500),
  list: () => sessions.list(),
  engineOf: (id) => sessions.engineOf(id),
  start: (input) => sessions.start(input, { restored: true }),
  setMode: (id, mode) => sessions.setMode(id, mode),
  folderExists: (path) => stat(path).then((s) => s.isDirectory(), () => false),
  enabled: async () => appOptions(await configuration.current()).reopenSessions,
  groups: async () => (await configuration.current()).sessionGroups,
  log: (message, err) => console.error(message, err)
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

const updates = new UpdateService((s) => send('updates:changed', s))

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
  emit: (sessionId, delivery) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('localReview:delivery', sessionId, delivery))
})

// Continuity across accounts and agents: Claude account failover and hand-off to another agent.
const transcriptReaderFor = (id: string | undefined) =>
  id === 'kiro' ? new KiroTranscriptReader() : id === 'opencode' ? new OpenCodeTranscriptReader() : id === 'codex' ? new CodexTranscriptReader() : id === 'claude' ? new ClaudeTranscriptReader() : null
const continuity = new ContinuityService({
  config: () => configuration.current(),
  sessions,
  budgetOf,
  claudeConfigDir: (account, config) => claudeConfigDirOf(config, account, homedir()),
  copySession: (input) => copyClaudeSession(input),
  facts: async (view, agent, account, config) => {
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
  },
  git: async (cwd) => {
    const probe = await new GitReview().probe(cwd, 'main')
    return probe ? { branch: probe.branch, dirtyFiles: probe.dirtyFiles } : null
  },
  placeBeside: async (member, anchorKey) => {
    const config = await configuration.current()
    const groups = config.sessionGroups
    if (!groups) return
    const next = placeBeside(groups, member, anchorKey)
    if (next === groups) return
    const r = await configuration.saveSessionGroups(next)
    if (r.ok) BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('config:changed'))
  },
  emitOffer: (offer) => send('continuity:offer', offer),
  emitMoved: (moved) => send('continuity:moved', moved),
  showPrompt: (id, text) => send('automations:prompted', id, text),
  showTurnEnd: (id, stopReason) => send('automations:turnEnded', id, stopReason)
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

function chromeColors() {
  return nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light
}

/**
 * Window chrome per platform: macOS keeps its traffic lights inset into the sidebar; Windows and
 * Linux draw their window controls as an overlay on the right of the toolbar.
 */
function windowChrome(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
  return { titleBarStyle: 'hidden', titleBarOverlay: { ...chromeColors(), height: TITLE_BAR_HEIGHT } }
}

/** The overlay controls (Windows, Linux) follow the theme; nativeTheme fires `updated` on every change. */
function syncTitleBarOverlay(): void {
  if (process.platform !== 'darwin' && win && !win.isDestroyed()) win.setTitleBarOverlay({ ...chromeColors(), height: TITLE_BAR_HEIGHT })
}

/**
 * Opens a web link in the browser the profile chose (Settings → Profiles → "Open links with"),
 * else in the default browser. A browser that cannot be started falls back to the default one.
 */
async function openLink(profileId: string | null, url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  const config = await configuration.current()
  const profile = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId))
  const command = linkCommand(process.platform, profile?.linkBrowser, url)
  if (!command) return void (await shell.openExternal(url))
  await new Promise<void>((done) =>
    execFile(command.command, command.args, { windowsHide: true }, (err) => {
      if (err) void shell.openExternal(url)
      done()
    })
  )
}

const setup = new SetupService({
  config: () => configuration.current(),
  hasSecret: (ref) => secrets.has(ref),
  path: () => [sessionPath() ?? process.env['PATH'] ?? '', ...fallbackPath].filter(Boolean).join(delimiter),
  home: homedir(),
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

function registerIpc(): void {
  // Every handler answers only the app's own renderer (see ipc-guard.ts).
  const ipc = guardIpc(ipcMain, (url) => isTrustedRendererUrl(url, rendererOrigin))
  ipc.on('hub:setTheme', (_e, theme: ThemePreference) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme
  })
  nativeTheme.on('updated', syncTitleBarOverlay)
  ipc.handle('hub:defaultCwd', () => homedir())
  ipc.handle('hub:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], defaultPath: homedir() })
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
      if (r.ok) BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('config:changed'))
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
  ipc.on('hub:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  ipc.handle('updates:status', () => updates.status())
  ipc.handle('updates:check', () => updates.check())
  ipc.handle('updates:install', () => updates.install())
  const namedHistory = async () => {
    const result = await listAllHistory(await configuration.current(), homedir(), historySources)
    // A session the user named shows that name in the history too.
    return { ...result, entries: result.entries.map((e) => ({ ...e, title: sessionNames.get(e.agentSessionId) ?? e.title })) }
  }
  ipc.handle('history:list', namedHistory)
  ipc.handle('history:find', async (_e, keys: unknown) => {
    if (!Array.isArray(keys)) return []
    const wanted = new Set(keys.filter((k): k is string => typeof k === 'string'))
    if (!wanted.size) return []
    return historyOfSessions((await namedHistory()).entries, wanted)
  })
  ipc.handle('history:revealFolder', async (_e, path: string) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return false
    const isFolder = await stat(path).then((s) => s.isDirectory(), () => false)
    if (!isFolder) return false
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
  ipc.on('setup:openWindow', (_e, page: SetupPage) => {
    if (page === 'welcome' || page === 'check' || page === 'help') openSetupWindow(page)
  })
  ipc.on('setup:openSettings', (_e, tab: string) => {
    if (typeof tab !== 'string') return
    showMain()
    win?.webContents.send('setup:openSettings', tab)
  })
  ipc.handle('setup:completeWelcome', async () => {
    if (!loadError) await configuration.saveOptions({ welcomeDone: true })
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('config:changed'))
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
  ipc.handle('systemNotifications:status', async () => ({ supported: await notificationPermission.allowed() }))
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
  ipc.handle('sessions:start', (_e, input) => sessions.start(input))
  ipc.handle('sessions:reopen', (_e, identity: string, input: StartSessionInput) => {
    if (typeof identity !== 'string' || !identity) throw new Error('an identity is required')
    return ownerStarts.start(identity, input)
  })
  // A renderer's prompt carries a token: main says when it actually goes out (it may wait behind
  // a review or a Slack wake) and the renderer can take it back until then.
  ipc.handle('sessions:prompt', (e, id: string, text: string, images, token?: unknown) => {
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
    return cwd ? localGit.localChanges(cwd) : null
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
  ipc.on('sessions:permission', (_e, id: string, requestId: string, optionId: string | null) =>
    sessions.respondPermission(id, requestId, optionId)
  )
  ipc.on('sessions:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipc.on('sessions:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))

  registerCodeHostIpc(ipc, { service: codeHost, openWindow: openPullRequestWindow, showInWorkhub: showPullRequestInMain, openExternal: (url, profileId) => openLink(profileId, url) })
  registerLinksIpc({ ipcMain: ipc, loadConfig: () => configuration.current(), mainWindow: () => win })
  registerPrEventsIpc(ipc, { service: prEvents, notify: showPullRequestNotification })
  ipc.handle('health:get', (_e, profileId: string | null, force?: boolean) => health.get(profileId, force === true))
  ipc.handle('health:details', (_e, profileId: string | null, environmentId: string, request: HealthDetailRequest, force?: boolean) => health.details(profileId, environmentId, request, force === true))
  registerChatIpc(ipc, { slack, automations, configuration, guarded })
  registerAiReviewIpc(ipc, aiReview)
  registerLocalReviewIpc(ipc, localReview, { openWindow: openLocalReviewWindow, openPath: (path) => shell.openPath(path) })
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
  ipc.on('tray:state', (_e, state: TrayRendererState) => {
    if (isLocale(state?.locale) && state.locale !== trayLocale) {
      trayLocale = state.locale
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
  ipc.on('trayPopover:resize', (e, height: unknown) => {
    if (typeof height === 'number' && trayPopover?.owns(e.sender)) trayPopover.resize(height)
  })
  ipc.on('trayPopover:hide', (e) => {
    if (trayPopover?.owns(e.sender)) trayPopover.hide()
  })
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

function navigate(route: TrayRoute): void {
  showMain()
  send('tray:navigate', route)
}

/** A notification worded by the renderer; a click opens its session, or its screen. */
function showSessionNotification(n: SessionNotification): void {
  if (!n || typeof n.title !== 'string' || typeof n.sessionId !== 'string') return
  const kind = isNotificationKind(n.kind) ? n.kind : 'replied'
  const route = n.route && TRAY_ROUTES.includes(n.route) ? n.route : undefined
  void notifier.show(kind, n, () => {
    if (route) return navigate(route)
    showMain()
    send('notifications:open', n.sessionId)
  }, { sessionId: n.sessionId })
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

function healthNotification(alert: HealthAlert): void {
  void notifier.show('health', healthAlertWords(alert, trayText(trayLocale).t), () => navigate('health'), { environmentId: alert.environmentId })
}

const healthWatcher = new HealthWatcher({
  activeProfileId: async () => (await configuration.current()).activeProfileId ?? null,
  read: (profileId) => health.get(profileId),
  alert: healthNotification,
  changed: scheduleTray,
  cooldowns: (() => {
    const file = new StateFile<{ firedAt: Record<string, number> }>(join(dataDir, 'health-alerts.json'), 500)
    return { load: () => file.load({ firedAt: {} }).firedAt ?? {}, save: (firedAt) => file.save({ firedAt }) }
  })()
})

const ticketWatcher = new TicketWatcher({
  activeProfileId: async () => (await configuration.current()).activeProfileId ?? null,
  enabled: async () => appOptions(await configuration.current()).notifyTickets,
  list: (profileId) => ticketService.call(profileId, (t, ignored) => t.listAssigned({ ignoredStatuses: ignored })),
  store: new StateFile(join(dataDir, 'ticket-watch.json'), 500),
  announce: ticketNotification
})

async function refreshOptionsCache(): Promise<void> {
  const options = appOptions(await configuration.current())
  keepInTray = options.keepInTray
  appBadge.setEnabled(options.showAppBadge)
  scheduleTray()
}

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
  const lists = await codeHost.lists(profileId).catch(() => null)
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
    notifications: notifier.recent().map((n) => ({ id: n.id, title: n.title, at: n.at })),
    pausedUntil: options.notificationsPausedUntil,
    canCheckForUpdates: app.isPackaged
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
      if (r.ok) BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('config:changed'))
      return scheduleTray()
    }
    case 'checkForUpdates':
      navigate('settings')
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

function openLocalReviewWindow(sessionId: string): void {
  const open = reviewWindows.get(sessionId)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
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

const isWebUrl = (url: string) => /^https?:\/\//i.test(url)

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
    if (isWebUrl(url)) void shell.openExternal(url)
  })
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererOrigin)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  // Links in agent replies open in the default browser, never inside the app.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
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
        openHelp: () => void shell.openExternal(HELP_URL),
        openSetup: openSetupWindow,
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
          pinned: process.env['WORKHUB_TRAY_POPOVER_PIN'] === '1'
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

void app.whenReady().then(async () => {
  if (!firstInstance) return
  try {
    await configuration.load()
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
  }
  denyWebPermissions()
  registerIpc()
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
  if (app.isPackaged && appOptions(await configuration.current()).checkForUpdates) setTimeout(() => void updates.check(), 10_000)
  prEvents.start()
  slack.start()
  void automations.start()
  aiReview.start()
  healthWatcher.start()
  ticketWatcher.start()
  // First run: no profile yet and the welcome was not finished.
  const first = await configuration.current()
  if (!loadError && first.profiles.length === 0 && !appOptions(first).welcomeDone) openSetupWindow('welcome')
})

// macOS: clicking the Dock icon brings the hidden window back.
app.on('activate', () => showMain())

let quitting = false
/** Set once the app is quitting (or installing an update): closing the window then really closes it. */
let allowWindowClose = false
// macOS installs an update by closing every window before 'before-quit'.
nativeUpdater.on('before-quit-for-update', () => {
  allowWindowClose = true
  sessionWindows.suspend()
  openSessions.freeze()
})
app.on('before-quit', (event) => {
  allowWindowClose = true
  // Session windows closing from here on stay remembered: the next launch reopens them.
  sessionWindows.suspend()
  openSessions.freeze()
  if (quitting) return
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
  healthWatcher.stop()
  ticketWatcher.stop()
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
