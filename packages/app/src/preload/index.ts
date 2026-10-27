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
  },
  codeHost: {
    lists: (profileId, force) => ipcRenderer.invoke('codeHost:lists', profileId, force),
    view: (profileId, url) => ipcRenderer.invoke('codeHost:view', profileId, url),
    review: (profileId, url, action, body) => ipcRenderer.invoke('codeHost:review', profileId, url, action, body),
    comment: (profileId, url, body) => ipcRenderer.invoke('codeHost:comment', profileId, url, body),
    reply: (profileId, url, threadId, body) => ipcRenderer.invoke('codeHost:reply', profileId, url, threadId, body),
    openWindow: (profileId, url) => ipcRenderer.invoke('codeHost:openWindow', profileId, url),
    openExternal: (profileId, url) => ipcRenderer.invoke('codeHost:openExternal', profileId, url)
  }
}

contextBridge.exposeInMainWorld('hub', api)
