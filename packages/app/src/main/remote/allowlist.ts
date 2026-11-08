import type { RemoteCapability } from '../../shared/remote-api'

/**
 * What a paired device may call, by capability. Everything not listed is refused: window and
 * tray plumbing, folder pickers, anything that opens something on the desktop, settings and
 * secrets, connection tests (they carry credentials), and every `hub` call that names a local path
 * the device chose. A new session's folder must be one the profile lists (see dispatcher.ts).
 */
export const REMOTE_INVOKES: Readonly<Record<string, RemoteCapability | 'any'>> = {
  'config:get': 'any',
  'config:effectiveAgents': 'any',
  'hub:profileFolders': 'sessions',
  'agents:availability': 'sessions',
  'agents:options': 'sessions',
  'sessions:list': 'sessions',
  'sessions:start': 'sessions',
  'sessions:reopen': 'sessions',
  'sessions:prompt': 'sessions',
  'sessions:withdrawPrompt': 'sessions',
  'sessions:setMode': 'sessions',
  'sessions:close': 'sessions',
  'sessions:closeRemovingWorktree': 'sessions',
  'sessions:setModel': 'sessions',
  'sessions:setAgentMode': 'sessions',
  'sessions:subagent': 'sessions',
  'sessions:localChanges': 'sessions',
  'sessions:rename': 'sessions',
  'sessions:cancel': 'sessions',
  'sessions:stop': 'sessions',
  'history:list': 'sessions',
  'history:find': 'sessions',
  'codeHost:lists': 'pullRequests',
  'codeHost:view': 'pullRequests',
  'codeHost:pullRequest': 'pullRequests',
  'codeHost:review': 'pullRequests',
  'codeHost:comment': 'pullRequests',
  'codeHost:reply': 'pullRequests',
  'codeHost:close': 'pullRequests',
  'automations:get': 'automations',
  'automations:save': 'automations',
  'automations:remove': 'automations',
  'automations:setEnabled': 'automations',
  'automations:runNow': 'automations',
  'automations:stop': 'automations',
  'health:get': 'health',
  'health:details': 'health',
  'health:flowMaps': 'health',
  'health:flowMapStates': 'health',
  'health:flowMap': 'health',
  'health:flowTraces': 'health',
  'health:flowTrace': 'health',
  'health:flowTraceLogs': 'health',
  'flowMaps:get': 'health',
  'flowMaps:setAlerts': 'health',
  'metricAlerts:list': 'health',
  'metricAlerts:setStatus': 'health',
  'metricAlerts:refresh': 'health'
}

/** One-way messages a device may send. `sessions:ready` is not one: it reopens the last quit's sessions. */
export const REMOTE_MESSAGES: Readonly<Record<string, RemoteCapability | 'any'>> = {
  'sessions:permission': 'sessions',
  'sessions:mcp': 'sessions'
}

/** The events main sends that reach a device, by capability. */
export const REMOTE_EVENTS: Readonly<Record<string, RemoteCapability | 'any'>> = {
  'config:changed': 'any',
  'session:event': 'sessions',
  'session:changed': 'sessions',
  'session:removed': 'sessions',
  'session:replay': 'sessions',
  'prEvents:events': 'pullRequests',
  'automations:changed': 'automations',
  'automations:prompted': 'automations',
  'automations:turnEnded': 'automations',
  'metricAlerts:changed': 'health'
}

export function remoteAllows(table: Readonly<Record<string, RemoteCapability | 'any'>>, channel: string, granted: ReadonlySet<RemoteCapability>): boolean {
  const needed = table[channel]
  if (needed === undefined) return false
  return needed === 'any' || granted.has(needed)
}
