import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent, HistoryMessage } from '@workhub/core'
import { toPlatform, type AccountUsage, type UsageAlert, type HubApi, type SessionView } from '../shared/api'
import type { UpdateStatus } from '../shared/updates-api'
import type { PrEventBatch } from '../shared/pr-events-api'
import type { SessionIntent } from '../shared/links-api'
import type { AiReviewNotice, AiReviewSnapshot } from '../shared/ai-review-api'
import type { AutomationsSnapshot, ChatNoticeEvent, SlackSnapshot } from '../shared/chat-api'
import type { ContinuityMoved, ContinuityOffer } from '../shared/continuity-api'

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
    onRemoved: (cb) => subscribe<[string]>('session:removed', cb),
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
    onChanged: (cb) => subscribe<[AccountUsage[]]>('usage:changed', cb),
    onAlerts: (cb) => subscribe<[UsageAlert[]]>('usage:alerts', cb),
    notify: (n) => ipcRenderer.send('usage:notify', n),
    ready: () => ipcRenderer.send('usage:ready'),
    onOpen: (cb) => subscribe<[]>('usage:open', cb)
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
  links: {
    request: (intent) => ipcRenderer.send('links:request', intent),
    checkouts: (profileId) => ipcRenderer.invoke('links:checkouts', profileId),
    onIntent: (cb) => subscribe<[SessionIntent]>('links:intent', cb)
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
  },
  slack: {
    get: () => ipcRenderer.invoke('slack:get'),
    saveSettings: (s) => ipcRenderer.invoke('slack:saveSettings', s),
    runNow: () => ipcRenderer.invoke('slack:runNow'),
    track: (input) => ipcRenderer.invoke('slack:track', input),
    trackMessage: (channelId, ts) => ipcRenderer.invoke('slack:trackMessage', channelId, ts),
    setClosed: (id, closed) => ipcRenderer.invoke('slack:setClosed', id, closed),
    setWake: (id, wake) => ipcRenderer.invoke('slack:setWake', id, wake),
    remove: (id) => ipcRenderer.invoke('slack:remove', id),
    sendToSession: (id) => ipcRenderer.invoke('slack:sendToSession', id),
    markViewed: (ids) => ipcRenderer.invoke('slack:markViewed', ids),
    setHook: (accountId, install) => ipcRenderer.invoke('slack:setHook', accountId, install),
    demo: (input) => ipcRenderer.invoke('slack:demo', input),
    openOwner: (id) => ipcRenderer.invoke('slack:openOwner', id),
    onChanged: (cb) => subscribe<[SlackSnapshot]>('slack:changed', cb),
    onNotice: (cb) => subscribe<[ChatNoticeEvent]>('slack:notice', cb)
  },
  automations: {
    get: () => ipcRenderer.invoke('automations:get'),
    save: (a) => ipcRenderer.invoke('automations:save', a),
    remove: (id) => ipcRenderer.invoke('automations:remove', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('automations:setEnabled', id, enabled),
    runNow: (id) => ipcRenderer.invoke('automations:runNow', id),
    stop: (id) => ipcRenderer.invoke('automations:stop', id),
    openSession: (id) => ipcRenderer.invoke('automations:openSession', id),
    setViewing: (id) => ipcRenderer.send('automations:setViewing', id),
    onChanged: (cb) => subscribe<[AutomationsSnapshot]>('automations:changed', cb),
    onPrompted: (cb) => subscribe<[string, string]>('automations:prompted', cb),
    onConfigChanged: (cb) => subscribe<[]>('config:changed', cb)
  },
  aiReview: {
    get: () => ipcRenderer.invoke('aiReview:get'),
    start: (sessionId, override) => ipcRenderer.invoke('aiReview:start', sessionId, override),
    continue: (reviewId) => ipcRenderer.invoke('aiReview:continue', reviewId),
    setFindingStatus: (reviewId, ids, status) => ipcRenderer.invoke('aiReview:setFindingStatus', reviewId, ids, status),
    opinion: (reviewId, text) => ipcRenderer.invoke('aiReview:opinion', reviewId, text),
    stop: (reviewId) => ipcRenderer.invoke('aiReview:stop', reviewId),
    dismissHold: (devIdentity) => ipcRenderer.invoke('aiReview:dismissHold', devIdentity),
    onChanged: (cb) => subscribe<[AiReviewSnapshot]>('aiReview:changed', cb),
    onNotice: (cb) => subscribe<[AiReviewNotice]>('aiReview:notice', cb)
  },
  continuity: {
    options: (sessionId) => ipcRenderer.invoke('continuity:options', sessionId),
    failover: (sessionId, request) => ipcRenderer.invoke('continuity:failover', sessionId, request),
    handoff: (sessionId, request) => ipcRenderer.invoke('continuity:handoff', sessionId, request),
    onOffer: (cb) => subscribe<[ContinuityOffer]>('continuity:offer', cb),
    onMoved: (cb) => subscribe<[ContinuityMoved]>('continuity:moved', cb)
  }
}

contextBridge.exposeInMainWorld('hub', api)
