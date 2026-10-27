import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, type BrowserWindowConstructorOptions } from 'electron'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AcpRuntime } from '@workhub/adapters/agent-acp'
import { JsonConfigStore } from '@workhub/adapters/config-json'
import { SafeStorageSecretStore } from '@workhub/adapters/secrets-electron'
import { TerminalRuntime } from '@workhub/adapters/agent-terminal'
import {
  CONNECTION_PROVIDERS,
  ConfigurationService,
  knownAgents,
  resolveEffectiveAgents,
  validateConfig,
  type Result,
  type WorkhubConfig
} from '@workhub/core'
import type { ConfigSnapshot, ThemePreference } from '../shared/api'
import { SessionManager } from './session-manager'
import { registerTicketIpc } from './tickets'
import { TicketService } from './tickets-service'

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
// WORKHUB_DEMO_TICKETS=1 serves synthetic tickets, so the UI can be shown without credentials.
const ticketService = new TicketService(configuration, secrets, process.env['WORKHUB_DEMO_TICKETS'] === '1')

let win: BrowserWindow | null = null
const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

const runtimes = {
  acp: new AcpRuntime({
    clientName: 'workhub',
    clientVersion: app.getVersion(),
    // Agent adapters installed with the app (claude-agent-acp) are found through PATH.
    extraPath: [join(repoRoot, 'node_modules', '.bin'), join(appRoot, 'node_modules', '.bin')]
  }),
  terminal: new TerminalRuntime()
}
const sessions = new SessionManager(
  configuration,
  runtimes,
  (e) => send('session:event', e),
  (s) => send('session:changed', s)
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

  registerTicketIpc({
    ipcMain,
    service: ticketService,
    createWindow: createAuxWindow,
    mainWindow: () => win,
    broadcast: (channel, ...args) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args))
  })

  ipcMain.handle('sessions:list', () => sessions.list())
  ipcMain.handle('sessions:start', (_e, input) => sessions.start(input))
  ipcMain.handle('sessions:prompt', (_e, id: string, text: string) => sessions.prompt(id, text))
  ipcMain.handle('sessions:cancel', (_e, id: string) => sessions.cancel(id))
  ipcMain.handle('sessions:stop', (_e, id: string) => sessions.stop(id))
  ipcMain.on('sessions:permission', (_e, id: string, requestId: string, optionId: string | null) =>
    sessions.respondPermission(id, requestId, optionId)
  )
  ipcMain.on('sessions:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on('sessions:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))
}

/** A secondary window (a ticket) on the same renderer, routed by its hash. */
function createAuxWindow(hash: string, title: string): BrowserWindow {
  const aux = new BrowserWindow({
    width: 820,
    height: 760,
    minWidth: 560,
    minHeight: 420,
    title,
    backgroundColor: chromeColors().color,
    ...windowChrome(),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  if (process.env['ELECTRON_RENDERER_URL']) void aux.loadURL(process.env['ELECTRON_RENDERER_URL'] + hash)
  else void aux.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.replace(/^#/, '') })
  return aux
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
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  // Give agent processes a chance to exit before the app does.
  event.preventDefault()
  quitting = true
  void sessions.stopAll().finally(() => app.quit())
})
app.on('window-all-closed', () => app.quit())
