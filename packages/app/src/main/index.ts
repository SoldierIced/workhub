import { app, autoUpdater as nativeUpdater, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, session, shell, type BrowserWindowConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AcpRuntime, agentAvailability, discoverKiroOptions } from '@workhub/adapters/agent-acp'
import { ClaudeNativeRuntime, ClaudePlanUsageReader, ClaudeSessionHistory } from '@workhub/adapters/agent-claude-native'
import { DemoChatSource, SlackAgentChatSource, SlackTrackingHook } from '@workhub/adapters/chat-slack'
import { JsonConfigStore } from '@workhub/adapters/config-json'
import { SafeStorageSecretStore } from '@workhub/adapters/secrets-electron'
import { TerminalRuntime } from '@workhub/adapters/agent-terminal'
import { createCliRunner } from '@workhub/adapters/cli'
import { augmentedPath, readLoginShellPath } from '@workhub/adapters/login-path'
import { ClaudeTranscriptReader, copyClaudeSession, readClaudeHandoffFacts } from '@workhub/adapters/transcript-claude'
import { CodexPlanUsageReader, CodexSessionHistory, CodexTranscriptReader } from '@workhub/adapters/transcript-codex'
import { KiroSessionHistory, KiroTranscriptReader, readKiroCreditEntries } from '@workhub/adapters/transcript-kiro'
import { GitReview } from '@workhub/adapters/git-review'
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
  isNotificationKind,
  importWorkhub1Secrets,
  pendingWorkhub1Secrets,
  pauseUntil,
  planWorkhub1Import,
  TRAY_ROUTES,
  resolveEffectiveAgents,
  startOfLocalDay,
  usageAccountKey,
  validateConfig,
  type HealthAlert,
  type CreditSpend,
  type Result,
  type Workhub1SecretResult,
  type TicketChange,
  type TrayAction,
  type TrayPrEvent,
  type TrayRoute,
  type TraySession,
  type TrayState,
  type WorkhubConfig
} from '@workhub/core'
import type { AccountUsage, ConfigSnapshot, SessionMode, SessionNotification, ThemePreference, UsageAlert } from '../shared/api'
import type { PrNotification } from '../shared/pr-events-api'
import type { SlackSnapshot } from '../shared/chat-api'
import type { TrayRendererState } from '../shared/tray-api'
import { Notifier } from './notifier'
import { TrayService } from './tray'
import { isLocale, trayText } from './tray-text'
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
import { resolveChoice, SessionManager, ticketPrefixes } from './session-manager'
import { registerLinksIpc } from './links'
import { SlackWatcherService } from './slack-watcher'
import { StateFile } from './state-file'
import { registerTicketIpc } from './tickets'
import { TicketService } from './tickets-service'
import { UpdateService } from './updates'

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
const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Menu bar / notification area icon (tray.ts) and what it shows that main does not keep elsewhere.
let trayService: TrayService | null = null
let trayLocale: Locale = 'en'
/** The sessions with their unseen flags, as the renderer last reported them. */
let rendererSessions: TraySession[] | null = null
let lastSlack: SlackSnapshot | null = null
const recentPrEvents: TrayPrEvent[] = []
/** Options read synchronously (closing the window); refreshed on every options save and tray refresh. */
let keepInTray = true
const scheduleTray = () => trayService?.schedule()

/** Every OS notification goes through here: per-kind switches and "Pause notifications". */
const notifier = new Notifier({
  options: async () => appOptions(await configuration.current()),
  supported: () => Notification.isSupported(),
  create: (content) => new Notification(content),
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
const sessions = new SessionManager({
  config: configuration,
  runtimes,
  terminal,
  transcripts: [new ClaudeTranscriptReader(), new KiroTranscriptReader({ kiroDir }), new OpenCodeTranscriptReader(), new CodexTranscriptReader()],
  history: historySources,
  onAgentOptions: (agentId, accountId, options) => agentOptions.record(agentId, accountId, options),
  emitEvent: (e) => {
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
  },
  emitRemoved: (id) => send('session:removed', id),
  emitReplay: (id, messages) => send('session:replay', id, messages),
  emitConfigChanged: () => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('config:changed'))
})
// Alerts found before the renderer listens (the first read runs at start-up) wait for it.
let usageAlertsReady = false
const pendingUsageAlerts: UsageAlert[] = []
// Plan usage per Claude and Codex account (Settings → Usage, opt-in per agent). WORKHUB_DEMO_USAGE=1
// serves synthetic windows instead, so the cards, budgets and gate can be shown without accounts.
const demoUsage = process.env['WORKHUB_DEMO_USAGE'] === '1'
const usage = new AgentUsageService({
  providers: demoUsage
    ? [new DemoUsageProvider('claude'), new DemoUsageProvider('codex')]
    : [new ClaudePlanUsageReader({ userAgent: `workhub/${app.getVersion()}` }), new CodexPlanUsageReader()],
  load: async () => {
    const config = await configuration.current()
    const options = appOptions(config)
    const claude = usageAccounts(config, 'claude', homedir())
    const codex = usageAccounts(config, 'codex', homedir())
    return {
      accounts: [...(options.claudePlanUsage ? claude : []), ...(options.codexUsage ? codex : [])],
      budget: options.usageBudget,
      knownKeys: [...claude, ...codex].map((a) => usageAccountKey(a.agentId, a.accountId))
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
const demoSlack = process.env['WORKHUB_DEMO_SLACK'] === '1' ? new DemoChatSource() : null
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
    send('slack:changed', snap)
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
  emit: (snap) => send('automations:changed', snap),
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
  ticketPrefixes,
  ticketTitle: async (profileId, key) => {
    if (!profileId) return undefined
    const r = await ticketService.call(profileId, (t) => t.getTicket(key))
    return r.ok ? r.value?.title : undefined
  },
  canStartReview: reviewBudgetGate((config, agentKey) => agentKeyBudget(config, agentKey, budgetOf))
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
  showPrompt: (id, text) => send('automations:prompted', id, text)
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
      return await fn(...args)
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

  ipc.handle('config:get', () => snapshot())
  ipc.handle('config:saveConnection', guarded((c, s) => configuration.saveConnection(c, s)))
  ipc.handle('config:deleteConnection', guarded((id: string) => configuration.deleteConnection(id)))
  ipc.handle('config:saveAccount', guarded((a) => configuration.saveAccount(a)))
  ipc.handle('config:deleteAccount', guarded((id: string) => configuration.deleteAccount(id)))
  ipc.handle('config:saveProfile', guarded((p) => configuration.saveProfile(p)))
  ipc.handle('config:deleteProfile', guarded((id: string) => configuration.deleteProfile(id)))
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
      return configuration.applyImport(planWorkhub1Import(v1, await configuration.current(), homedir()))
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
  ipc.handle('history:list', async () => listAllHistory(await configuration.current(), homedir(), historySources))
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
  ipc.handle('usage:kiroSpend', () => kiroSpend())
  ipc.on('usage:notify', (_e, n: { title: string; body: string }) => showUsageNotification(n))
  ipc.on('usage:ready', () => {
    usageAlertsReady = true
    if (pendingUsageAlerts.length) send('usage:alerts', pendingUsageAlerts.splice(0))
  })

  openTicketWindow = registerTicketIpc({
    ipcMain: ipc,
    service: ticketService,
    createWindow: createAuxWindow,
    mainWindow: () => win,
    broadcast: (channel, ...args) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args))
  }).openWindow

  ipc.handle('sessions:list', () => sessions.list())
  ipc.handle('sessions:start', (_e, input) => sessions.start(input))
  ipc.handle('sessions:prompt', (_e, id: string, text: string, images) => sessions.prompt(id, text, images))
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
  ipc.handle('sessions:cancel', (_e, id: string) => sessions.cancel(id))
  ipc.handle('sessions:stop', (_e, id: string) => sessions.stop(id))
  ipc.on('sessions:permission', (_e, id: string, requestId: string, optionId: string | null) =>
    sessions.respondPermission(id, requestId, optionId)
  )
  ipc.on('sessions:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipc.on('sessions:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))

  registerCodeHostIpc(ipc, { service: codeHost, openWindow: openPullRequestWindow, openExternal: (url) => shell.openExternal(url) })
  registerLinksIpc({ ipcMain: ipc, loadConfig: () => configuration.current(), mainWindow: () => win })
  registerPrEventsIpc(ipc, { service: prEvents, notify: showPullRequestNotification })
  ipc.handle('health:get', (_e, profileId: string | null, force?: boolean) => health.get(profileId, force === true))
  registerChatIpc(ipc, { slack, automations, configuration, guarded })
  registerAiReviewIpc(ipc, aiReview)
  ipc.handle('continuity:options', (_e, id: string) => continuity.options(id))
  ipc.handle('continuity:failover', (_e, id: string, request) => continuity.failover(id, request))
  ipc.handle('continuity:handoff', (_e, id: string, request) => continuity.handoff(id, request))
  ipc.handle('health:test', (_e, connection, secret, indexToProbe?: string) => health.test(connection, secret, indexToProbe))
  ipc.on('tray:state', (_e, state: TrayRendererState) => {
    if (isLocale(state?.locale)) trayLocale = state.locale
    if (Array.isArray(state?.sessions)) rendererSessions = state.sessions.slice(0, 500).filter(validTraySession)
    scheduleTray()
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
    (s.awaitingAnswer === undefined || typeof s.awaitingAnswer === 'boolean')
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
  const { t } = trayText(trayLocale)
  const words = { title: t(`notify.health.${alert.kind}`, { environment: alert.environmentName }), body: t(`notify.health.${alert.kind}Body`) }
  void notifier.show('health', words, () => navigate('health'), { environmentId: alert.environmentId })
}

const healthWatcher = new HealthWatcher({
  activeProfileId: async () => (await configuration.current()).activeProfileId ?? null,
  read: (profileId) => health.get(profileId),
  alert: healthNotification,
  changed: scheduleTray
})

const ticketWatcher = new TicketWatcher({
  activeProfileId: async () => (await configuration.current()).activeProfileId ?? null,
  enabled: async () => appOptions(await configuration.current()).notifyTickets,
  list: (profileId) => ticketService.call(profileId, (t, ignored) => t.listAssigned({ ignoredStatuses: ignored })),
  store: new StateFile(join(dataDir, 'ticket-watch.json'), 500),
  announce: ticketNotification
})

async function refreshOptionsCache(): Promise<void> {
  keepInTray = appOptions(await configuration.current()).keepInTray
  scheduleTray()
}

/** Everything the menu bar icon shows, read fresh. */
async function trayState(): Promise<TrayState> {
  const config = await configuration.current()
  const options = appOptions(config)
  keepInTray = options.keepInTray
  const profileId = config.activeProfileId ?? null
  const sessionsNow = rendererSessions ?? sessions.list().filter((v) => !v.readOnly).map((v) => ({ id: v.id, title: v.label, state: v.state }))
  const lists = await codeHost.lists(profileId).catch(() => null)
  const agentNames = new Map(knownAgents(config).map((a) => [a.id, a.name]))
  const slackOn = lastSlack && lastSlack.health !== 'off'
  const me = lastSlack?.me ?? ''
  const openThreads = lastSlack?.threads.filter((th) => !th.closed) ?? []
  return {
    appName: app.getName(),
    sessions: sessionsNow,
    usage: usage.current().map((a) => ({ name: a.name || agentNames.get(a.agentId) || a.agentId, windows: a.windows, error: Boolean(a.error) })),
    pullRequests: lists && lists.state !== 'notConnected' ? { toReview: lists.toReview.length, mine: lists.mine.length } : null,
    prEvents: recentPrEvents,
    health: healthWatcher.summary(),
    slack: slackOn && lastSlack ? { health: lastSlack.health, open: openThreads.length, unread: openThreads.filter((th) => hasUnread(th, me)).length, error: lastSlack.lastError } : null,
    notifications: notifier.recent().map((n) => ({ id: n.id, title: n.title })),
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

function openPullRequestWindow(profileId: string | null, url: string): void {
  const open = prWindows.get(url)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    open.focus()
    return
  }
  const hash = `#pr?profile=${encodeURIComponent(profileId ?? '')}&url=${encodeURIComponent(url)}`
  const prWin = createAuxWindow(hash, 'Workhub 2', { width: 1100, height: 780, minWidth: 720, minHeight: 480 })
  prWindows.set(url, prWin)
  prWin.on('closed', () => prWindows.delete(url))
}

interface AuxWindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

const TICKET_WINDOW_SIZE: AuxWindowSize = { width: 820, height: 760, minWidth: 560, minHeight: 420 }

/** A secondary window (a pull request, a ticket) on the same renderer, routed by its hash. */
function createAuxWindow(hash: string, title: string, size: AuxWindowSize = TICKET_WINDOW_SIZE): BrowserWindow {
  const aux = new BrowserWindow({
    ...size,
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
  // "Keep running in the menu bar": closing hides the window; sessions, watchers and notifications go on.
  win.on('close', (event) => {
    if (allowWindowClose || !keepInTray || !trayService) return
    event.preventDefault()
    win?.hide()
  })
}

/** The menu bar / notification area icon; a dev run is named "Workhub 2 Dev" there too. */
function startTray(): void {
  trayService = new TrayService({
    appName: app.getName(),
    platform: process.platform,
    iconDir: app.isPackaged ? join(process.resourcesPath, 'tray') : join(appRoot, 'build', 'tray'),
    state: trayState,
    text: () => trayText(trayLocale),
    perform: (action) => void performTrayAction(action),
    activate: showMain,
    logPath: process.env['WORKHUB_TRAY_LOG']
  })
  trayService.start()
  // Usage, pull request lists and Health change on their own; the menu catches up once a minute.
  setInterval(scheduleTray, 60_000).unref?.()
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
  createWindow()
  await refreshOptionsCache()
  try {
    startTray()
  } catch {
    // No status area (some Linux desktops): closing the window then quits, as without the option.
    trayService = null
  }
  usage.start()
  // Opt-in: nothing contacts GitHub unless the user turned this on (or presses "Check now").
  if (app.isPackaged && appOptions(await configuration.current()).checkForUpdates) setTimeout(() => void updates.check(), 10_000)
  prEvents.start()
  slack.start()
  void automations.start()
  aiReview.start()
  healthWatcher.start()
  ticketWatcher.start()
})

// macOS: clicking the Dock icon brings the hidden window back.
app.on('activate', () => showMain())

let quitting = false
/** Set once the app is quitting (or installing an update): closing the window then really closes it. */
let allowWindowClose = false
// macOS installs an update by closing every window before 'before-quit'.
nativeUpdater.on('before-quit-for-update', () => {
  allowWindowClose = true
})
app.on('before-quit', (event) => {
  allowWindowClose = true
  if (quitting) return
  // Give agent processes a chance to exit before the app does.
  event.preventDefault()
  quitting = true
  usage.stop()
  prEvents.stop()
  slack.stop()
  automations.stop()
  aiReview.stop()
  healthWatcher.stop()
  ticketWatcher.stop()
  void sessions.stopAll().finally(() => app.quit())
})
// Kept in the menu bar, the app outlives its windows (a window closed some other way than its
// close button is opened again from the icon); otherwise closing the last window quits.
app.on('window-all-closed', () => {
  if (!(keepInTray && trayService) || allowWindowClose) app.quit()
})
