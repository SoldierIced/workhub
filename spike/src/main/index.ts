import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import { AcpManager } from './acp-manager'
import { PtyManager } from './pty-manager'

// Dev: out/main -> spike -> workhub2. Packaging is out of scope for the spike.
const spikeRoot = resolve(__dirname, '../..')
const defaultCwd = resolve(spikeRoot, '..')

let win: BrowserWindow | null = null
const send = (channel: string, ...args: unknown[]) => win?.webContents.send(channel, ...args)

const pty = new PtyManager((id, data) => send('pty:data', id, data), (id, code) => send('pty:exit', id, code))
const acp = new AcpManager(spikeRoot, (e) => send('acp:event', e))

function registerIpc(): void {
  ipcMain.handle('hub:defaultCwd', () => defaultCwd)
  ipcMain.handle('hub:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], defaultPath: defaultCwd })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('pty:start', (_e, cwd: string, cols: number, rows: number) => pty.start(cwd, cols, rows))
  ipcMain.on('pty:write', (_e, id: number, data: string) => pty.write(id, data))
  ipcMain.on('pty:resize', (_e, id: number, cols: number, rows: number) => pty.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: number) => pty.kill(id))
  ipcMain.handle('acp:start', (_e, agent, cwd: string) => acp.start(agent, cwd))
  ipcMain.handle('acp:prompt', (_e, text: string) => acp.prompt(text))
  ipcMain.handle('acp:cancel', () => acp.cancel())
  ipcMain.handle('acp:stop', () => acp.stop())
  ipcMain.on('acp:permission', (_e, requestId: string, optionId: string | null) =>
    acp.respondPermission(requestId, optionId)
  )
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
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

void app.whenReady().then(() => {
  registerIpc()
  createWindow()
})

app.on('before-quit', () => {
  pty.killAll()
  void acp.stop()
})
app.on('window-all-closed', () => app.quit())
