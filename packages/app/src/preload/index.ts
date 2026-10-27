import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent } from '@workhub/core'
import { toPlatform, type HubApi, type SessionView } from '../shared/api'

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
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    saveConnection: (c, s) => ipcRenderer.invoke('config:saveConnection', c, s),
    deleteConnection: (id) => ipcRenderer.invoke('config:deleteConnection', id),
    saveAccount: (a) => ipcRenderer.invoke('config:saveAccount', a),
    deleteAccount: (id) => ipcRenderer.invoke('config:deleteAccount', id),
    saveProfile: (p) => ipcRenderer.invoke('config:saveProfile', p),
    deleteProfile: (id) => ipcRenderer.invoke('config:deleteProfile', id),
    setActiveProfile: (id) => ipcRenderer.invoke('config:setActiveProfile', id),
    effectiveAgents: (profileId) => ipcRenderer.invoke('config:effectiveAgents', profileId)
  },
  tickets: {
    status: (profileId) => ipcRenderer.invoke('tickets:status', profileId),
    list: (profileId) => ipcRenderer.invoke('tickets:list', profileId),
    get: (profileId, key) => ipcRenderer.invoke('tickets:get', profileId, key),
    transitions: (profileId, key) => ipcRenderer.invoke('tickets:transitions', profileId, key),
    transition: (profileId, key, id) => ipcRenderer.invoke('tickets:transition', profileId, key, id),
    comment: (profileId, key, text) => ipcRenderer.invoke('tickets:comment', profileId, key, text),
    assignToMe: (profileId, key) => ipcRenderer.invoke('tickets:assignToMe', profileId, key),
    test: (connection, secret) => ipcRenderer.invoke('tickets:test', connection, secret),
    openWindow: (profileId, key) => ipcRenderer.invoke('tickets:openWindow', profileId, key),
    openExternal: (url) => ipcRenderer.invoke('tickets:openExternal', url),
    openSession: (id) => ipcRenderer.send('tickets:openSession', id),
    onChanged: (cb) => subscribe<[]>('tickets:changed', cb),
    onOpenSession: (cb) => subscribe<[string]>('tickets:openSession', cb)
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    start: (input) => ipcRenderer.invoke('sessions:start', input),
    prompt: (id, text) => ipcRenderer.invoke('sessions:prompt', id, text),
    cancel: (id) => ipcRenderer.invoke('sessions:cancel', id),
    stop: (id) => ipcRenderer.invoke('sessions:stop', id),
    respondPermission: (id, requestId, optionId) => ipcRenderer.send('sessions:permission', id, requestId, optionId),
    write: (id, data) => ipcRenderer.send('sessions:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('sessions:resize', id, cols, rows),
    onEvent: (cb) => subscribe<[AgentEvent]>('session:event', cb),
    onChanged: (cb) => subscribe<[SessionView]>('session:changed', cb)
  }
}

contextBridge.exposeInMainWorld('hub', api)
