import { shell, type BrowserWindow } from 'electron'
import type { Connection, SecretChange } from '@workhub/core'
import type { TicketsResult } from '../shared/tickets-api'
import type { IpcRegistrar } from './ipc-guard'
import type { TicketService } from './tickets-service'

export interface TicketIpcDeps {
  ipcMain: IpcRegistrar
  service: TicketService
  /** Creates a secondary window on the renderer with this hash. */
  createWindow: (hash: string, title: string) => BrowserWindow
  mainWindow: () => BrowserWindow | null
  broadcast: (channel: string, ...args: unknown[]) => void
}

/** Registers the ticket handlers; returns the ticket window opener (ticket notifications use it). */
export function registerTicketIpc({ ipcMain, service, createWindow, mainWindow, broadcast }: TicketIpcDeps): { openWindow: (profileId: string, key: string) => void } {
  const windows = new Map<string, BrowserWindow>()
  const changed = <T>(r: TicketsResult<T>): TicketsResult<T> => {
    if (r.ok) broadcast('tickets:changed')
    return r
  }

  ipcMain.handle('tickets:status', (_e, profileId: string | null) => service.status(profileId))
  ipcMain.handle('tickets:list', (_e, profileId: string) => service.call(profileId, (t, ignored) => t.listAssigned({ ignoredStatuses: ignored })))
  ipcMain.handle('tickets:get', (_e, profileId: string, key: string) => service.call(profileId, (t) => t.getTicket(key)))
  ipcMain.handle('tickets:transitions', (_e, profileId: string, key: string) => service.call(profileId, (t) => t.transitions(key)))
  ipcMain.handle('tickets:transition', async (_e, profileId: string, key: string, id: string) =>
    changed(await service.call(profileId, async (t) => (await t.transition(key, id), null)))
  )
  ipcMain.handle('tickets:comment', async (_e, profileId: string, key: string, text: string) =>
    changed(await service.call(profileId, async (t) => (await t.addComment(key, text), null)))
  )
  ipcMain.handle('tickets:assignToMe', async (_e, profileId: string, key: string) =>
    changed(await service.call(profileId, async (t) => (await t.assignToMe(key), null)))
  )
  ipcMain.handle('tickets:test', (_e, connection: Connection, change: SecretChange) => service.test(connection, change))

  const openWindow = (profileId: string, key: string): void => {
    const id = `${profileId}:${key}`
    const existing = windows.get(id)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return
    }
    const win = createWindow(`#/ticket?profile=${encodeURIComponent(profileId)}&key=${encodeURIComponent(key)}`, key)
    windows.set(id, win)
    win.on('closed', () => windows.delete(id))
  }
  ipcMain.handle('tickets:openWindow', (_e, profileId: string, key: string) => openWindow(profileId, key))

  ipcMain.handle('tickets:openExternal', async (_e, url: string) => {
    // Only web links: the renderer shows text from trackers, which must never reach other schemes.
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  ipcMain.on('tickets:openSession', (_e, sessionId: string) => {
    const win = mainWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('tickets:openSession', sessionId)
  })
  return { openWindow }
}
