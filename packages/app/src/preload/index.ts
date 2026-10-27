import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent, HistoryMessage } from '@workhub/core'
import { toPlatform, type AccountUsage, type HubApi, type SessionView } from '../shared/api'

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: HubApi = {
  platform: toPlatform(process.platform),
  setTheme: (theme) => ipcRenderer.send('hub:setTheme', theme),
  getDefaultCwd: () => ipcRenderer.invoke('hub:defaultCwd'),
  pickFolder: () => ipcRenderer.invoke('hub:pickFolder'),
  openExternal: (url) => ipcRenderer.send('hub:openExternal', url),
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    saveConnection: (c, s) => ipcRenderer.invoke('config:saveConnection', c, s),
    deleteConnection: (id) => ipcRenderer.invoke('config:deleteConnection', id),
    saveAccount: (a) => ipcRenderer.invoke('config:saveAccount', a),
    deleteAccount: (id) => ipcRenderer.invoke('config:deleteAccount', id),
    saveProfile: (p) => ipcRenderer.invoke('config:saveProfile', p),
    deleteProfile: (id) => ipcRenderer.invoke('config:deleteProfile', id),
    setActiveProfile: (id) => ipcRenderer.invoke('config:setActiveProfile', id),
    saveOptions: (o) => ipcRenderer.invoke('config:saveOptions', o),
    effectiveAgents: (profileId) => ipcRenderer.invoke('config:effectiveAgents', profileId),
    previewWorkhub1Import: () => ipcRenderer.invoke('config:previewWorkhub1Import'),
    applyWorkhub1Import: () => ipcRenderer.invoke('config:applyWorkhub1Import')
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    start: (input) => ipcRenderer.invoke('sessions:start', input),
    prompt: (id, text, images) => ipcRenderer.invoke('sessions:prompt', id, text, images),
    setMode: (id, mode) => ipcRenderer.invoke('sessions:setMode', id, mode),
    setModel: (id, model) => ipcRenderer.invoke('sessions:setModel', id, model),
    mcp: (id, action, server) => ipcRenderer.send('sessions:mcp', id, action, server),
    cancel: (id) => ipcRenderer.invoke('sessions:cancel', id),
    stop: (id) => ipcRenderer.invoke('sessions:stop', id),
    respondPermission: (id, requestId, optionId) => ipcRenderer.send('sessions:permission', id, requestId, optionId),
    write: (id, data) => ipcRenderer.send('sessions:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('sessions:resize', id, cols, rows),
    onEvent: (cb) => subscribe<[AgentEvent]>('session:event', cb),
    onChanged: (cb) => subscribe<[SessionView]>('session:changed', cb),
    onReplay: (cb) => subscribe<[string, HistoryMessage[]]>('session:replay', cb)
  },
  history: {
    list: () => ipcRenderer.invoke('history:list')
  },
  usage: {
    get: (refresh) => ipcRenderer.invoke('usage:get', refresh),
    onChanged: (cb) => subscribe<[AccountUsage[]]>('usage:changed', cb)
  }
}

contextBridge.exposeInMainWorld('hub', api)
