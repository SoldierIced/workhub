import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, session, shell, type BrowserWindowConstructorOptions } from 'electron'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AcpRuntime, agentAvailability } from '@workhub/adapters/agent-acp'
import { ClaudeNativeRuntime, ClaudePlanUsageReader, ClaudeSessionHistory } from '@workhub/adapters/agent-claude-native'
import { JsonConfigStore } from '@workhub/adapters/config-json'
import { SafeStorageSecretStore } from '@workhub/adapters/secrets-electron'
import { TerminalRuntime } from '@workhub/adapters/agent-terminal'
import { ClaudeTranscriptReader } from '@workhub/adapters/transcript-claude'
import { CodexSessionHistory, CodexTranscriptReader } from '@workhub/adapters/transcript-codex'
import { KiroSessionHistory, KiroTranscriptReader } from '@workhub/adapters/transcript-kiro'
import { JsonPrEventStore } from '@workhub/adapters/pr-events-json'
import { OpenCodeSessionHistory, OpenCodeTranscriptReader } from '@workhub/adapters/transcript-opencode'
import { readWorkhub1Settings } from '@workhub/adapters/workhub1-import'
import {
  appOptions,
  CONNECTION_PROVIDERS,
  ConfigurationService,
  knownAgents,
  planWorkhub1Import,
  resolveEffectiveAgents,
  validateConfig,
  type Result,
  type WorkhubConfig
} from '@workhub/core'
import type { AccountUsage, ConfigSnapshot, SessionMode, SessionNotification, ThemePreference } from '../shared/api'
import type { PrNotification } from '../shared/pr-events-api'
import { claudeAccounts, UsageService } from './claude-accounts'
import { CodeHostService, registerCodeHostIpc } from './codehost'
import { HealthService } from './health-service'
import { guardIpc, isTrustedRendererUrl } from './ipc-guard'
import { permissionAllowed } from './permissions'
import { listAllHistory } from './history'
import { PrEventService, registerPrEventsIpc } from './pr-events-service'
import { SessionManager } from './session-manager'
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

// Workhub 1's Agent SDK bridge, run with Electron's own Node. Packaged: staged into the resources
// folder with its node_modules (scripts/stage-bridge.mjs); dev: straight from the adapters source.
const bridgeDir = app.isPackaged ? join(process.resourcesPath, 'bridge') : join(repoRoot, 'packages', 'adapters', 'src', 'agent-claude-native', 'bridge')
const terminal = new TerminalRuntime()
// Agent adapters installed with the app (claude-agent-acp) are found through PATH.
const extraPath = app.isPackaged
  ? [join(bridgeDir, 'node_modules', '.bin')]
  : [join(repoRoot, 'node_modules', '.bin'), join(appRoot, 'node_modules', '.bin')]
const runtimes = {
  native: new ClaudeNativeRuntime({ bridgeDir }),
  acp: new AcpRuntime({
    clientName: 'workhub',
    clientVersion: app.getVersion(),
    extraPath
  }),
  terminal
}
const claudeHistory = new ClaudeSessionHistory({ bridgeDir })
// Past sessions per agent id; the readers behind them are kiro, opencode and codex (PLAN D9).
const historySources = { claude: claudeHistory, kiro: new KiroSessionHistory(), opencode: new OpenCodeSessionHistory(), codex: new CodexSessionHistory() }
const sessions = new SessionManager({
  config: configuration,
  runtimes,
  terminal,
  transcripts: [new ClaudeTranscriptReader(), new KiroTranscriptReader(), new OpenCodeTranscriptReader(), new CodexTranscriptReader()],
  history: historySources,
  emitEvent: (e) => send('session:event', e),
  emitChanged: (s) => send('session:changed', s),
  emitReplay: (id, messages) => send('session:replay', id, messages)
})
const usage = new UsageService(
  new ClaudePlanUsageReader({ userAgent: `workhub/${app.getVersion()}` }),
  async () => {
    const config = await configuration.current()
    return { enabled: appOptions(config).claudePlanUsage, accounts: claudeAccounts(config, homedir()) }
  },
  (u: AccountUsage[]) => send('usage:changed', u)
)

const updates = new UpdateService((s) => send('updates:changed', s))

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
      return { ok: false, issues: [{ path: 'config', message: err instanceof Error ? err.message : String(err) }] }
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
      if (r.ok) void usage.refresh()
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
      return { available: true, plan: planWorkhub1Import(v1, await configuration.current(), homedir()) }
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipc.handle(
    'config:applyWorkhub1Import',
    guarded(async () => {
      const v1 = await readWorkhub1Settings()
      if (!v1) return { ok: false, issues: [{ path: 'import', message: 'Workhub 1 settings not found' }] }
      return configuration.addImported(planWorkhub1Import(v1, await configuration.current(), homedir()))
    })
  )
  ipc.on('hub:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  ipc.handle('updates:status', () => updates.status())
  ipc.handle('updates:check', () => updates.check())
  ipc.handle('updates:install', () => updates.install())
  ipc.handle('history:list', async () => listAllHistory(await configuration.current(), homedir(), historySources))
  ipc.handle('agents:availability', async () => agentAvailability(knownAgents(await configuration.current()), { extraPath }))
  ipc.handle('usage:get', (_e, refresh?: boolean) => (refresh ? usage.refresh() : usage.current()))

  registerTicketIpc({
    ipcMain: ipc,
    service: ticketService,
    createWindow: createAuxWindow,
    mainWindow: () => win,
    broadcast: (channel, ...args) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args))
  })

  ipc.handle('sessions:list', () => sessions.list())
  ipc.handle('sessions:start', (_e, input) => sessions.start(input))
  ipc.handle('sessions:prompt', (_e, id: string, text: string, images) => sessions.prompt(id, text, images))
  ipc.handle('sessions:setMode', (_e, id: string, mode: SessionMode) => sessions.setMode(id, mode))
  ipc.handle('sessions:setModel', (_e, id: string, model: string | null) => sessions.setModel(id, model))
  ipc.on('sessions:mcp', (_e, id: string, action: 'refresh' | 'reconnect' | 'enable' | 'disable', server?: string) => sessions.mcp(id, action, server))
  ipc.handle('sessions:cancel', (_e, id: string) => sessions.cancel(id))
  ipc.handle('sessions:stop', (_e, id: string) => sessions.stop(id))
  ipc.on('sessions:permission', (_e, id: string, requestId: string, optionId: string | null) =>
    sessions.respondPermission(id, requestId, optionId)
  )
  ipc.on('sessions:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipc.on('sessions:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))

  registerCodeHostIpc(ipc, { service: codeHost, openWindow: openPullRequestWindow, openExternal: (url) => shell.openExternal(url) })
  registerPrEventsIpc(ipc, { service: prEvents, notify: showPullRequestNotification })
  ipc.handle('health:get', (_e, profileId: string | null, force?: boolean) => health.get(profileId, force === true))
  ipc.handle('health:test', (_e, connection, secret, indexToProbe?: string) => health.test(connection, secret, indexToProbe))
}

/** Notifications stay referenced until they close, or the OS may drop their click handler. */
const liveNotifications = new Set<Notification>()

/** An OS notification (Electron's, on macOS, Windows and Linux); a click brings the window up and opens the session. */
function showSessionNotification(n: SessionNotification): void {
  if (!Notification.isSupported() || typeof n.title !== 'string' || typeof n.sessionId !== 'string') return
  // Test hook: a run can read back what was shown without reading the OS notification center.
  const log = process.env['WORKHUB_NOTIFICATION_LOG']
  if (log) appendFileSync(log, `${JSON.stringify({ title: n.title, body: n.body, sessionId: n.sessionId })}\n`)
  const notification = new Notification({ title: n.title.slice(0, 200), body: String(n.body ?? '').slice(0, 400) })
  liveNotifications.add(notification)
  notification.on('close', () => liveNotifications.delete(notification))
  notification.on('click', () => {
    liveNotifications.delete(notification)
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    send('notifications:open', n.sessionId)
  })
  notification.show()
}

/** An OS notification about a pull request event; a click brings the window up and opens that pull request. */
function showPullRequestNotification(n: PrNotification): void {
  if (!Notification.isSupported()) return
  const log = process.env['WORKHUB_NOTIFICATION_LOG']
  if (log) appendFileSync(log, `${JSON.stringify({ title: n.title, body: n.body, url: n.url, profileId: n.profileId })}\n`)
  const notification = new Notification({ title: n.title.slice(0, 200), body: String(n.body ?? '').slice(0, 400) })
  liveNotifications.add(notification)
  notification.on('close', () => liveNotifications.delete(notification))
  notification.on('click', () => {
    liveNotifications.delete(notification)
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    openPullRequestWindow(n.profileId || null, n.url)
  })
  notification.show()
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
}

void app.whenReady().then(async () => {
  try {
    await configuration.load()
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
  }
  denyWebPermissions()
  registerIpc()
  createWindow()
  usage.start()
  // Opt-in: nothing contacts GitHub unless the user turned this on (or presses "Check now").
  if (app.isPackaged && appOptions(await configuration.current()).checkForUpdates) setTimeout(() => void updates.check(), 10_000)
  prEvents.start()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  // Give agent processes a chance to exit before the app does.
  event.preventDefault()
  quitting = true
  usage.stop()
  prEvents.stop()
  void sessions.stopAll().finally(() => app.quit())
})
app.on('window-all-closed', () => app.quit())
