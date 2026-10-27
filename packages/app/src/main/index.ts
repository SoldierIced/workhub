import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell, type BrowserWindowConstructorOptions } from 'electron'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AcpRuntime, agentAvailability } from '@workhub/adapters/agent-acp'
import { ClaudeNativeRuntime, ClaudePlanUsageReader, ClaudeSessionHistory } from '@workhub/adapters/agent-claude-native'
import { JsonConfigStore } from '@workhub/adapters/config-json'
import { SafeStorageSecretStore } from '@workhub/adapters/secrets-electron'
import { TerminalRuntime } from '@workhub/adapters/agent-terminal'
import { ClaudeTranscriptReader } from '@workhub/adapters/transcript-claude'
import { CodexSessionHistory, CodexTranscriptReader } from '@workhub/adapters/transcript-codex'
import { KiroSessionHistory, KiroTranscriptReader } from '@workhub/adapters/transcript-kiro'
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
import type { AccountUsage, ConfigSnapshot, SessionMode, ThemePreference } from '../shared/api'
import { claudeAccounts, UsageService } from './claude-accounts'
import { listAllHistory } from './history'
import { SessionManager } from './session-manager'

// Dev layout: packages/app/out/main -> packages/app. Packaging is P8.
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

let win: BrowserWindow | null = null
const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Workhub 1's Agent SDK bridge, run with Electron's own Node (dev layout; packaging is P8).
const bridgeDir = join(repoRoot, 'packages', 'adapters', 'src', 'agent-claude-native', 'bridge')
const terminal = new TerminalRuntime()
// Agent adapters installed with the app (claude-agent-acp) are found through PATH.
const extraPath = [join(repoRoot, 'node_modules', '.bin'), join(appRoot, 'node_modules', '.bin')]
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
  ipcMain.on('hub:setTheme', (_e, theme: ThemePreference) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme
  })
  nativeTheme.on('updated', syncTitleBarOverlay)
  ipcMain.handle('hub:defaultCwd', () => homedir())
  ipcMain.handle('hub:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], defaultPath: homedir() })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle('config:get', () => snapshot())
  ipcMain.handle('config:saveConnection', guarded((c, s) => configuration.saveConnection(c, s)))
  ipcMain.handle('config:deleteConnection', guarded((id: string) => configuration.deleteConnection(id)))
  ipcMain.handle('config:saveAccount', guarded((a) => configuration.saveAccount(a)))
  ipcMain.handle('config:deleteAccount', guarded((id: string) => configuration.deleteAccount(id)))
  ipcMain.handle('config:saveProfile', guarded((p) => configuration.saveProfile(p)))
  ipcMain.handle('config:deleteProfile', guarded((id: string) => configuration.deleteProfile(id)))
  ipcMain.handle('config:setActiveProfile', guarded((id: string) => configuration.setActiveProfile(id)))
  ipcMain.handle('config:effectiveAgents', async (_e, profileId: string | null) =>
    resolveEffectiveAgents(await configuration.current(), profileId)
  )
  ipcMain.handle(
    'config:saveOptions',
    guarded(async (o) => {
      const r = await configuration.saveOptions(o)
      if (r.ok) void usage.refresh()
      return r
    })
  )
  // Workhub 1's settings are only ever read (`defaults export`); nothing is written back.
  ipcMain.handle('config:previewWorkhub1Import', async () => {
    try {
      const v1 = await readWorkhub1Settings()
      if (!v1) return { available: false }
      return { available: true, plan: planWorkhub1Import(v1, await configuration.current(), homedir()) }
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(
    'config:applyWorkhub1Import',
    guarded(async () => {
      const v1 = await readWorkhub1Settings()
      if (!v1) return { ok: false, issues: [{ path: 'import', message: 'Workhub 1 settings not found' }] }
      return configuration.addImported(planWorkhub1Import(v1, await configuration.current(), homedir()))
    })
  )
  ipcMain.on('hub:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  ipcMain.handle('history:list', async () => listAllHistory(await configuration.current(), homedir(), historySources))
  ipcMain.handle('agents:availability', async () => agentAvailability(knownAgents(await configuration.current()), { extraPath }))
  ipcMain.handle('usage:get', (_e, refresh?: boolean) => (refresh ? usage.refresh() : usage.current()))

  ipcMain.handle('sessions:list', () => sessions.list())
  ipcMain.handle('sessions:start', (_e, input) => sessions.start(input))
  ipcMain.handle('sessions:prompt', (_e, id: string, text: string, images) => sessions.prompt(id, text, images))
  ipcMain.handle('sessions:setMode', (_e, id: string, mode: SessionMode) => sessions.setMode(id, mode))
  ipcMain.handle('sessions:setModel', (_e, id: string, model: string | null) => sessions.setModel(id, model))
  ipcMain.on('sessions:mcp', (_e, id: string, action: 'refresh' | 'reconnect' | 'enable' | 'disable', server?: string) => sessions.mcp(id, action, server))
  ipcMain.handle('sessions:cancel', (_e, id: string) => sessions.cancel(id))
  ipcMain.handle('sessions:stop', (_e, id: string) => sessions.stop(id))
  ipcMain.on('sessions:permission', (_e, id: string, requestId: string, optionId: string | null) =>
    sessions.respondPermission(id, requestId, optionId)
  )
  ipcMain.on('sessions:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on('sessions:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))
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
  // Links in agent replies open in the default browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win?.webContents.getURL()) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

void app.whenReady().then(async () => {
  try {
    await configuration.load()
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
  }
  registerIpc()
  createWindow()
  usage.start()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  // Give agent processes a chance to exit before the app does.
  event.preventDefault()
  quitting = true
  usage.stop()
  void sessions.stopAll().finally(() => app.quit())
})
app.on('window-all-closed', () => app.quit())
