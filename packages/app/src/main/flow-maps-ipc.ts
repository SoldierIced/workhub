/**
 * The Flow maps bridge: the files of the data folder (import, delete, reveal), the map window and
 * what only the main process can do for it (the clipboard, forwarding "Ask Claude" to the main window).
 */
import { mkdirSync } from 'node:fs'
import type { BrowserWindow } from 'electron'
import type { FlowMapImportResult } from '../shared/flow-maps-api'
import { deleteFlowMap, importFlowMapFiles } from './flow-maps'
import type { IpcRegistrar } from './ipc-guard'

export interface FlowMapsIpcDeps {
  dir: string
  /** Asks for JSON files; empty when cancelled. */
  pickFiles(): Promise<string[]>
  showItemInFolder(path: string): void
  createWindow(hash: string, title: string): BrowserWindow
  mainWindow(): BrowserWindow | null
  /** Puts a PNG data URL on the clipboard; false when it is not an image. */
  writeImage(dataUrl: string): Promise<boolean>
}

/** The hash a map window is opened with; `parseFlowMapHash` in the renderer reads it back. */
export function flowMapWindowHash(profileId: string | null, environmentId: string, mapId: string): string {
  const q = new URLSearchParams({ profile: profileId ?? '', env: environmentId, id: mapId })
  return `#flow-map?${q.toString()}`
}

export function registerFlowMapsIpc(ipc: IpcRegistrar, deps: FlowMapsIpcDeps): void {
  const windows = new Map<string, BrowserWindow>()
  const ensureDir = () => {
    mkdirSync(deps.dir, { recursive: true })
    return deps.dir
  }
  ipc.handle('flowMaps:folder', () => ensureDir())
  ipc.on('flowMaps:reveal', () => deps.showItemInFolder(ensureDir()))
  ipc.handle('flowMaps:import', async (): Promise<FlowMapImportResult[]> => importFlowMapFiles(ensureDir(), await deps.pickFiles()))
  ipc.handle('flowMaps:remove', (_e, id: unknown) => (typeof id === 'string' ? deleteFlowMap(deps.dir, id) : false))
  ipc.handle('flowMaps:copyImage', (_e, dataUrl: unknown) => (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,') && dataUrl.length < 50_000_000 ? deps.writeImage(dataUrl) : false))
  ipc.on('flowMaps:openWindow', (_e, profileId: unknown, environmentId: unknown, mapId: unknown) => {
    if (typeof environmentId !== 'string' || typeof mapId !== 'string') return
    const profile = typeof profileId === 'string' ? profileId : null
    const key = `${profile ?? ''}|${environmentId}|${mapId}`
    const open = windows.get(key)
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore()
      open.focus()
      return
    }
    const w = deps.createWindow(flowMapWindowHash(profile, environmentId, mapId), 'Flow map')
    windows.set(key, w)
    w.on('closed', () => windows.delete(key))
  })
  ipc.on('flowMaps:ask', (_e, draft: unknown, folder: unknown) => {
    if (typeof draft !== 'string' || !draft.trim()) return
    const main = deps.mainWindow()
    if (!main || main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.focus()
    main.webContents.send('flowMaps:askInMain', draft, typeof folder === 'string' && folder ? folder : undefined)
  })
}
