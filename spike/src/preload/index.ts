import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AcpEvent, HubApi } from '../shared/api'

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: HubApi = {
  getDefaultCwd: () => ipcRenderer.invoke('hub:defaultCwd'),
  pickFolder: () => ipcRenderer.invoke('hub:pickFolder'),
  pty: {
    start: (cwd, cols, rows) => ipcRenderer.invoke('pty:start', cwd, cols, rows),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (cb) => subscribe<[number, string]>('pty:data', cb),
    onExit: (cb) => subscribe<[number, number]>('pty:exit', cb)
  },
  acp: {
    start: (agent, cwd) => ipcRenderer.invoke('acp:start', agent, cwd),
    prompt: (text) => ipcRenderer.invoke('acp:prompt', text),
    cancel: () => ipcRenderer.invoke('acp:cancel'),
    stop: () => ipcRenderer.invoke('acp:stop'),
    respondPermission: (requestId, optionId) => ipcRenderer.send('acp:permission', requestId, optionId),
    onEvent: (cb) => subscribe<[AcpEvent]>('acp:event', cb)
  }
}

contextBridge.exposeInMainWorld('hub', api)
