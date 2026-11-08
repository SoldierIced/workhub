// The renderer's `hub` (window.hub) built over any transport: Electron IPC in the preload, a
// WebSocket to the desktop in the web client. Keeps the channel names in one place, so a method
// added here reaches both.
import type { AgentEvent, HistoryMessage, SessionCeilings, LocalReviewDelivery } from '@workhub/core'
import type { AccountUsage, UsageAlert, HubApi, Platform, SessionView } from './api'
import type { UpdateStatus } from './updates-api'
import type { PrEventBatch } from './pr-events-api'
import type { SessionIntent } from './links-api'
import type { AiReviewNotice, AiReviewSnapshot, ReviewLoopView } from './ai-review-api'
import type { AutomationsSnapshot, ChatNoticeEvent, SlackSnapshot } from './chat-api'
import type { ContinuityMoved, ContinuityOffer } from './continuity-api'
import type { TrayPopoverView, TrayRoute } from './tray-api'
import type { PullRequestWindowTab } from './codehost-api'
import type { MenuCommand } from './windows-api'

/** What carries `hub` calls to the main process: request/response, one-way, and main's events. */
export interface HubTransport {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  /** Subscribes to an event the main process sends; returns the unsubscribe. */
  subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void
}

export function buildHub(transport: HubTransport, platform: Platform): HubApi {
  const { invoke, send, subscribe } = transport
  return {
      platform,
    setTheme: (theme, chrome) => send('hub:setTheme', theme, chrome),
    getDefaultCwd: () => invoke('hub:defaultCwd'),
    pickFolder: () => invoke('hub:pickFolder'),
    profileFolders: (profileId) => invoke('hub:profileFolders', profileId),
    openExternal: (url, profileId) => send('hub:openExternal', url, profileId ?? null),
    chromeProfiles: (app) => invoke('links:chromeProfiles', app),
    config: {
      get: () => invoke('config:get'),
      saveConnection: (c, s) => invoke('config:saveConnection', c, s),
      deleteConnection: (id) => invoke('config:deleteConnection', id),
      saveAccount: (a) => invoke('config:saveAccount', a),
      deleteAccount: (id) => invoke('config:deleteAccount', id),
      saveProfile: (p) => invoke('config:saveProfile', p),
      deleteProfile: (id) => invoke('config:deleteProfile', id),
      setActiveProfile: (id) => invoke('config:setActiveProfile', id),
      saveOptions: (o) => invoke('config:saveOptions', o),
      saveSessionGroups: (g) => invoke('config:saveSessionGroups', g),
      effectiveAgents: (profileId) => invoke('config:effectiveAgents', profileId),
      previewWorkhub1Import: () => invoke('config:previewWorkhub1Import'),
      applyWorkhub1Import: () => invoke('config:applyWorkhub1Import'),
      importWorkhub1Secrets: () => invoke('config:importWorkhub1Secrets'),
      onChanged: (cb) => subscribe<[]>('config:changed', cb)
    },
    tickets: {
      status: (profileId) => invoke('tickets:status', profileId),
      list: (profileId) => invoke('tickets:list', profileId),
      get: (profileId, key) => invoke('tickets:get', profileId, key),
      transitions: (profileId, key) => invoke('tickets:transitions', profileId, key),
      transition: (profileId, key, id) => invoke('tickets:transition', profileId, key, id),
      comment: (profileId, key, text) => invoke('tickets:comment', profileId, key, text),
      assignToMe: (profileId, key) => invoke('tickets:assignToMe', profileId, key),
      test: (connection, secret) => invoke('tickets:test', connection, secret),
      openWindow: (profileId, key) => invoke('tickets:openWindow', profileId, key),
      openExternal: (url) => invoke('tickets:openExternal', url),
      openSession: (id) => send('tickets:openSession', id),
      onChanged: (cb) => subscribe<[]>('tickets:changed', cb),
      onOpenSession: (cb) => subscribe<[string]>('tickets:openSession', cb)
    },
    sessions: {
      list: () => invoke('sessions:list'),
      ready: () => send('sessions:ready'),
      start: (input) => invoke('sessions:start', input),
      reopen: (identity, input) => invoke('sessions:reopen', identity, input),
      prompt: (id, text, images, token) => invoke('sessions:prompt', id, text, images, token),
      withdrawPrompt: (id, token) => invoke('sessions:withdrawPrompt', id, token),
      onPromptStarted: (cb) => subscribe<[string, number]>('sessions:promptStarted', cb),
      onPromptSettled: (cb) => subscribe<[string, number]>('sessions:promptSettled', cb),
      setMode: (id, mode, options) => invoke('sessions:setMode', id, mode, options),
      close: (id) => invoke('sessions:close', id),
      closeRemovingWorktree: (id, force) => invoke('sessions:closeRemovingWorktree', id, force),
      setModel: (id, model) => invoke('sessions:setModel', id, model),
      setAgentMode: (id, modeId) => invoke('sessions:setAgentMode', id, modeId),
      mcp: (id, action, server) => send('sessions:mcp', id, action, server),
      subagent: (id, subagentId) => invoke('sessions:subagent', id, subagentId),
      revealFile: (id, path) => invoke('sessions:revealFile', id, path),
      localChanges: (id) => invoke('sessions:localChanges', id),
      rename: (id, name) => invoke('sessions:rename', id, name),
      cancel: (id) => invoke('sessions:cancel', id),
      stop: (id) => invoke('sessions:stop', id),
      respondPermission: (id, requestId, optionId, answers) => send('sessions:permission', id, requestId, optionId, answers),
      write: (id, data) => send('sessions:write', id, data),
      resize: (id, cols, rows) => send('sessions:resize', id, cols, rows),
      onEvent: (cb) => subscribe<[AgentEvent]>('session:event', cb),
      onChanged: (cb) => subscribe<[SessionView]>('session:changed', cb),
      onRemoved: (cb) => subscribe<[string]>('session:removed', cb),
      onReplay: (cb) => subscribe<[string, HistoryMessage[]]>('session:replay', cb)
    },
    history: {
      list: () => invoke('history:list'),
      find: (keys) => invoke('history:find', keys),
      revealFolder: (path) => invoke('history:revealFolder', path)
    },
    agents: {
      availability: () => invoke('agents:availability'),
      options: (agentKey, refresh) => invoke('agents:options', agentKey, refresh)
    },
    usage: {
      get: (refresh) => invoke('usage:get', refresh),
      refreshNow: () => invoke('usage:refreshNow'),
      kiroSpend: () => invoke('usage:kiroSpend'),
      apiSpend: () => invoke('usage:apiSpend'),
      folderSpend: (profileId) => invoke('usage:folderSpend', profileId),
      onFolderSpendChanged: (cb) => subscribe<[]>('usage:folderSpendChanged', cb),
      onChanged: (cb) => subscribe<[AccountUsage[]]>('usage:changed', cb),
      onAlerts: (cb) => subscribe<[UsageAlert[]]>('usage:alerts', cb),
      notify: (n) => send('usage:notify', n),
      ready: () => send('usage:ready'),
      onOpen: (cb) => subscribe<[]>('usage:open', cb),
      sessionBudgets: () => invoke('usage:sessionBudgets'),
      setSessionBudget: (identity, ceilings) => invoke('usage:setSessionBudget', identity, ceilings),
      onSessionBudgetsChanged: (cb) => subscribe<[Record<string, SessionCeilings>]>('usage:sessionBudgetsChanged', cb)
    },
    notifications: {
      show: (n) => send('notifications:show', n),
      onOpen: (cb) => subscribe<[string]>('notifications:open', cb)
    },
    updates: {
      status: () => invoke('updates:status'),
      check: () => invoke('updates:check'),
      install: () => invoke('updates:install'),
      restart: () => invoke('updates:restart'),
      onChanged: (cb) => subscribe<[UpdateStatus]>('updates:changed', cb),
      skip: (version) => invoke('updates:skip', version),
      onPrompt: (cb) => subscribe<[UpdateStatus]>('updates:prompt', cb)
    },
    codeHost: {
      lists: (profileId, force) => invoke('codeHost:lists', profileId, force),
      view: (profileId, url) => invoke('codeHost:view', profileId, url),
      pullRequest: (profileId, url) => invoke('codeHost:pullRequest', profileId, url),
      review: (profileId, url, action, body) => invoke('codeHost:review', profileId, url, action, body),
      comment: (profileId, url, body) => invoke('codeHost:comment', profileId, url, body),
      reply: (profileId, url, threadId, body) => invoke('codeHost:reply', profileId, url, threadId, body),
      close: (profileId, url, comment, deleteBranch) => invoke('codeHost:close', profileId, url, comment, deleteBranch),
      openWindow: (profileId, url, tab) => invoke('codeHost:openWindow', profileId, url, tab),
      showInWorkhub: (profileId, url) => invoke('codeHost:showInWorkhub', profileId, url),
      onFocus: (cb) => subscribe<[string, string | null]>('codeHost:focus', cb),
      openExternal: (profileId, url) => invoke('codeHost:openExternal', profileId, url),
      onShowTab: (cb) => subscribe<[PullRequestWindowTab]>('codeHost:showTab', cb)
    },
    links: {
      request: (intent) => send('links:request', intent),
      checkouts: (profileId) => invoke('links:checkouts', profileId),
      onIntent: (cb) => subscribe<[SessionIntent]>('links:intent', cb)
    },
    health: {
      get: (profileId, force) => invoke('health:get', profileId, force),
      details: (profileId, environmentId, request, force) => invoke('health:details', profileId, environmentId, request, force),
      flowMaps: (profileId) => invoke('health:flowMaps', profileId),
      flowMapStates: (profileId, environmentId) => invoke('health:flowMapStates', profileId, environmentId),
      flowMap: (profileId, environmentId, mapId, hours, force, storedOnly) => invoke('health:flowMap', profileId, environmentId, mapId, hours, force, storedOnly),
      flowTraces: (profileId, environmentId, mapId, hours, sort) => invoke('health:flowTraces', profileId, environmentId, mapId, hours, sort),
      flowTrace: (profileId, environmentId, mapId, traceId) => invoke('health:flowTrace', profileId, environmentId, mapId, traceId),
      flowTraceLogs: (profileId, environmentId, mapId, traceId) => invoke('health:flowTraceLogs', profileId, environmentId, mapId, traceId),
      test: (connection, secret, indexToProbe) => invoke('health:test', connection, secret, indexToProbe)
    },
    flowMaps: {
      folder: () => invoke('flowMaps:folder'),
      reveal: () => send('flowMaps:reveal'),
      importFiles: () => invoke('flowMaps:import'),
      remove: (id) => invoke('flowMaps:remove', id),
      get: (mapId) => invoke('flowMaps:get', mapId),
      setAlerts: (profileId, mapId, alerts) => invoke('flowMaps:setAlerts', profileId, mapId, alerts),
      openWindow: (profileId, environmentId, mapId) => send('flowMaps:openWindow', profileId, environmentId, mapId),
      copyImage: (dataUrl) => invoke('flowMaps:copyImage', dataUrl),
      ask: (draft, folder) => send('flowMaps:ask', draft, folder),
      onAsk: (cb) => subscribe<[string, string | undefined]>('flowMaps:askInMain', cb)
    },
    plan: {
      get: (profileId, force) => invoke('plan:get', profileId, force),
      test: (connection, secret) => invoke('plan:test', connection, secret),
      brief: (profileId, eventId) => invoke('plan:brief', profileId, eventId),
      oneOnOne: (profileId, personId) => invoke('plan:oneOnOne', profileId, personId),
      onChanged: (cb) => subscribe<[string]>('plan:changed', cb),
      onFocus: (cb) => subscribe<[]>('plan:focus', cb)
    },
    planner: {
      get: (profileId) => invoke('planner:get', profileId),
      saveMilestone: (profileId, milestone) => invoke('planner:saveMilestone', profileId, milestone),
      deleteMilestone: (profileId, id) => invoke('planner:deleteMilestone', profileId, id),
      resolveProposal: (profileId, id, accept) => invoke('planner:resolveProposal', profileId, id, accept),
      refreshMilestones: (profileId) => invoke('planner:refreshMilestones', profileId),
      lookupTicket: (profileId, key, connectionId) => invoke('planner:lookupTicket', profileId, key, connectionId),
      linkTicket: (profileId, id, ticket) => invoke('planner:linkTicket', profileId, id, ticket),
      addItem: (profileId, proposal, force) => invoke('planner:addItem', profileId, proposal, force),
      editItem: (profileId, id, edit) => invoke('planner:editItem', profileId, id, edit),
      act: (profileId, id, action) => invoke('planner:act', profileId, id, action),
      fromAlert: (profileId, alertKey) => invoke('planner:fromAlert', profileId, alertKey),
      bulkEdit: (profileId, ids, patch) => invoke('planner:bulkEdit', profileId, ids, patch),
      openWindow: (target) => send('planner:openWindow', target),
      onEditRequest: (cb) => subscribe<[]>('planner:edit', cb),
      onChanged: (cb) => subscribe<[string]>('planner:changed', cb)
    },
    listen: {
      summarize: (requestId, sessionId, text) => invoke('listen:summarize', requestId, sessionId, text),
      cancel: (requestId) => send('listen:cancel', requestId)
    },
    metricAlerts: {
      list: (profileId) => invoke('metricAlerts:list', profileId),
      setStatus: (profileId, key, action) => invoke('metricAlerts:setStatus', profileId, key, action),
      refresh: (profileId) => invoke('metricAlerts:refresh', profileId),
      onChanged: (cb) => subscribe<[string]>('metricAlerts:changed', cb),
      onOpen: (cb) => subscribe<[string]>('metricAlerts:open', cb)
    },
    prEvents: {
      ready: () => send('prEvents:ready'),
      onEvents: (cb) => subscribe<[PrEventBatch]>('prEvents:events', cb),
      notify: (n) => send('prEvents:notify', n),
      demoAdvance: () => invoke('prEvents:demoAdvance')
    },
    slack: {
      get: () => invoke('slack:get'),
      saveSettings: (s) => invoke('slack:saveSettings', s),
      runNow: () => invoke('slack:runNow'),
      track: (input) => invoke('slack:track', input),
      trackMessage: (channelId, ts) => invoke('slack:trackMessage', channelId, ts),
      setClosed: (id, closed) => invoke('slack:setClosed', id, closed),
      setWake: (id, wake) => invoke('slack:setWake', id, wake),
      remove: (id) => invoke('slack:remove', id),
      sendToSession: (id) => invoke('slack:sendToSession', id),
      markViewed: (ids) => invoke('slack:markViewed', ids),
      setHook: (accountId, install) => invoke('slack:setHook', accountId, install),
      demo: (input) => invoke('slack:demo', input),
      openOwner: (id) => invoke('slack:openOwner', id),
      onChanged: (cb) => subscribe<[SlackSnapshot]>('slack:changed', cb),
      onNotice: (cb) => subscribe<[ChatNoticeEvent]>('slack:notice', cb)
    },
    automations: {
      get: () => invoke('automations:get'),
      save: (a) => invoke('automations:save', a),
      remove: (id) => invoke('automations:remove', id),
      setEnabled: (id, enabled) => invoke('automations:setEnabled', id, enabled),
      runNow: (id) => invoke('automations:runNow', id),
      stop: (id) => invoke('automations:stop', id),
      openSession: (id) => invoke('automations:openSession', id),
      setViewing: (id) => send('automations:setViewing', id),
      onChanged: (cb) => subscribe<[AutomationsSnapshot]>('automations:changed', cb),
      onPrompted: (cb) => subscribe<[string, string]>('automations:prompted', cb),
      onTurnEnded: (cb) => subscribe<[string, string]>('automations:turnEnded', cb),
      onConfigChanged: (cb) => subscribe<[]>('config:changed', cb)
    },
    aiReview: {
      get: () => invoke('aiReview:get'),
      start: (sessionId, override) => invoke('aiReview:start', sessionId, override),
      continue: (reviewId) => invoke('aiReview:continue', reviewId),
      setFindingStatus: (reviewId, ids, status) => invoke('aiReview:setFindingStatus', reviewId, ids, status),
      opinion: (reviewId, text) => invoke('aiReview:opinion', reviewId, text),
      stop: (reviewId) => invoke('aiReview:stop', reviewId),
      dismissHold: (devIdentity) => invoke('aiReview:dismissHold', devIdentity),
      setSessionAuto: (sessionId, on) => invoke('aiReview:setSessionAuto', sessionId, on),
      loopOptions: (sessionId) => invoke('agentReview:options', sessionId),
      startLoop: (sessionId, request) => invoke('agentReview:start', sessionId, request),
      loops: () => invoke('agentReview:loops'),
      stopLoop: (loopId) => invoke('agentReview:stop', loopId),
      dismissLoop: (loopId) => invoke('agentReview:dismiss', loopId),
      approveFindings: (loopId, keep, note) => invoke('agentReview:approve', loopId, keep, note),
      openLoopWindow: (loopId) => invoke('agentReview:openWindow', loopId),
      onLoopsChanged: (cb) => subscribe<[ReviewLoopView[]]>('agentReview:changed', cb),
      onChanged: (cb) => subscribe<[AiReviewSnapshot]>('aiReview:changed', cb),
      onNotice: (cb) => subscribe<[AiReviewNotice]>('aiReview:notice', cb)
    },
    continuity: {
      options: (sessionId) => invoke('continuity:options', sessionId),
      failover: (sessionId, request) => invoke('continuity:failover', sessionId, request),
      handoff: (sessionId, request) => invoke('continuity:handoff', sessionId, request),
      onOffer: (cb) => subscribe<[ContinuityOffer]>('continuity:offer', cb),
      onMoved: (cb) => subscribe<[ContinuityMoved]>('continuity:moved', cb)
    },
    setup: {
      run: () => invoke('setup:run'),
      openWindow: (page) => send('setup:openWindow', page),
      openSettings: (tab) => send('setup:openSettings', tab),
      completeWelcome: () => invoke('setup:completeWelcome')
    },
    profileEnv: {
      stored: (profileId) => invoke('profileEnv:stored', profileId),
      save: (profileId, values, removed) => invoke('profileEnv:save', profileId, values, removed)
    },
    accountEnv: {
      stored: (accountId) => invoke('accountEnv:stored', accountId),
      save: (accountId, values, removed) => invoke('accountEnv:save', accountId, values, removed)
    },
    systemNotifications: {
      status: () => invoke('systemNotifications:status'),
      openSystemSettings: () => send('systemNotifications:openSettings'),
      test: (body) => invoke('systemNotifications:test', body)
    },
    localReview: {
      load: (sessionId, scope) => invoke('localReview:load', sessionId, scope),
      comments: (sessionId) => invoke('localReview:comments', sessionId),
      setComments: (sessionId, comments) => invoke('localReview:setComments', sessionId, comments),
      send: (sessionId, text) => invoke('localReview:send', sessionId, text),
      delivery: (sessionId) => invoke('localReview:delivery', sessionId),
      onDelivery: (cb) => subscribe<[string, LocalReviewDelivery]>('localReview:delivery', cb),
      openWindow: (sessionId) => invoke('localReview:openWindow', sessionId),
      openFile: (sessionId, repoRoot, path) => invoke('localReview:openFile', sessionId, repoRoot, path),
      filePath: (sessionId, repoRoot, path) => invoke('localReview:filePath', sessionId, repoRoot, path)
    },
    files: {
      openWindow: (path, cwd) => invoke('files:openWindow', path, cwd),
      cacheImages: (dataUrls) => invoke('files:cacheImages', dataUrls),
      read: (path, known, forceText) => invoke('files:read', path, known ?? null, forceText === true),
      copyPath: (path) => send('files:copyPath', path),
      reveal: (path) => invoke('files:reveal', path),
      openDefault: (path) => invoke('files:openDefault', path)
    },
    settings: {
      open: (section) => send('settings:open', section),
      setDirty: (dirty) => send('settings:setDirty', dirty),
      close: () => send('settings:close'),
      onNavigate: (cb) => subscribe<[string]>('settings:navigate', cb),
      onCloseRequest: (cb) => subscribe<[]>('settings:closeRequest', cb)
    },
    tray: {
      setState: (state) => send('tray:state', state),
      onNavigate: (cb) => subscribe<[TrayRoute, string | undefined]>('tray:navigate', cb),
      onNewSession: (cb) => subscribe<[]>('tray:newSession', cb),
      popover: {
        get: () => invoke('trayPopover:get'),
        onView: (cb) => subscribe<[TrayPopoverView]>('trayPopover:view', cb),
        onShown: (cb) => subscribe<[]>('trayPopover:shown', cb),
        perform: (action) => send('trayPopover:perform', action),
        hide: () => send('trayPopover:hide')
      }
    },
    windows: {
      openSession: (id) => send('windows:openSession', id),
      openSubagent: (sessionId, subagentId) => send('windows:openSubagent', sessionId, subagentId),
      dock: (id) => send('windows:dock', id),
      detached: () => invoke('windows:detached'),
      onDetached: (cb) => subscribe<[string[]]>('windows:detached', cb),
      onShowSession: (cb) => subscribe<[string]>('windows:showSession', cb),
      onFocusedSession: (cb) => subscribe<[string | null]>('windows:focusedSession', cb),
      snapshot: (id) => invoke('windows:snapshot', id),
      onSnapshotRequest: (cb) => subscribe<[string, string]>('windows:snapshotRequest', cb),
      replySnapshot: (requestId, snapshot) => send('windows:snapshotReply', requestId, snapshot)
    },
    menu: {
      onCommand: (cb) => subscribe<[MenuCommand]>('menu:command', cb)
    },
    diagnostics: {
      report: (report) => send('diag:report', report),
      revealLogs: () => send('diag:revealLogs')
    }
  }
}
