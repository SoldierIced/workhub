import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent, HistoryMessage } from '@workhub/core'
import { toPlatform, type AccountUsage, type HubApi, type SessionView } from '../shared/api'
import type { UpdateStatus } from '../shared/updates-api'
import type { PrEventBatch } from '../shared/pr-events-api'

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
    saveSessionGroups: (g) => ipcRenderer.invoke('config:saveSessionGroups', g),
    effectiveAgents: (profileId) => ipcRenderer.invoke('config:effectiveAgents', profileId),
    previewWorkhub1Import: () => ipcRenderer.invoke('config:previewWorkhub1Import'),
    applyWorkhub1Import: () => ipcRenderer.invoke('config:applyWorkhub1Import'),
    onChanged: (cb) => subscribe<[]>('config:changed', cb)
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
  agents: {
    availability: () => ipcRenderer.invoke('agents:availability')
  },
  usage: {
    get: (refresh) => ipcRenderer.invoke('usage:get', refresh),
    onChanged: (cb) => subscribe<[AccountUsage[]]>('usage:changed', cb)
  },
  notifications: {
    show: (n) => ipcRenderer.send('notifications:show', n),
    onOpen: (cb) => subscribe<[string]>('notifications:open', cb)
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onChanged: (cb) => subscribe<[UpdateStatus]>('updates:changed', cb)
  },
  codeHost: {
    lists: (profileId, force) => ipcRenderer.invoke('codeHost:lists', profileId, force),
    view: (profileId, url) => ipcRenderer.invoke('codeHost:view', profileId, url),
    review: (profileId, url, action, body) => ipcRenderer.invoke('codeHost:review', profileId, url, action, body),
    comment: (profileId, url, body) => ipcRenderer.invoke('codeHost:comment', profileId, url, body),
    reply: (profileId, url, threadId, body) => ipcRenderer.invoke('codeHost:reply', profileId, url, threadId, body),
    openWindow: (profileId, url) => ipcRenderer.invoke('codeHost:openWindow', profileId, url),
    openExternal: (profileId, url) => ipcRenderer.invoke('codeHost:openExternal', profileId, url)
  },
  health: {
    get: (profileId, force) => ipcRenderer.invoke('health:get', profileId, force),
    test: (connection, secret, indexToProbe) => ipcRenderer.invoke('health:test', connection, secret, indexToProbe)
  },
  prEvents: {
    ready: () => ipcRenderer.send('prEvents:ready'),
    onEvents: (cb) => subscribe<[PrEventBatch]>('prEvents:events', cb),
    notify: (n) => ipcRenderer.send('prEvents:notify', n),
    demoAdvance: () => ipcRenderer.invoke('prEvents:demoAdvance')
  }
}

contextBridge.exposeInMainWorld('hub', api)
