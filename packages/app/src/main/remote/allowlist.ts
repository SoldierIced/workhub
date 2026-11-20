import type { RemoteCapability } from '../../shared/remote-api'

/**
 * What a paired device may call, by capability. Everything not listed is refused: window and
 * tray plumbing, folder pickers, anything that opens something on the desktop, settings and
 * secrets, connection tests (they carry credentials), and every `hub` call that names a local path
 * the device chose. A channel is listed only while the phone's web client calls it
 * (test/remote-allowlist.test.ts checks that), so a stolen device identity reaches no more than the
 * app itself offers: a write the phone has no button for (a review, a comment, closing a pull
 * request) stays closed. A new session's folder must be one the profile lists, and its mode never one
 * that skips permissions (see dispatcher.ts). `remote:file` reads inside the session's folder, and
 * outside it only images the session's own agent read or wrote (see files.ts).
 */
export const REMOTE_INVOKES: Readonly<Record<string, RemoteCapability | 'any'>> = {
  'config:get': 'any',
  'config:effectiveAgents': 'any',
  'hub:profileFolders': 'sessions',
  'sessions:list': 'sessions',
  'sessions:start': 'sessions',
  'sessions:reopen': 'sessions',
  'sessions:prompt': 'sessions',
  'sessions:close': 'sessions',
  'sessions:subagent': 'sessions',
  'sessions:cancel': 'sessions',
  'remote:file': 'sessions',
  'remote:history': 'sessions',
  // Paged reads of the lists below (dispatcher.ts, PAGED_SOURCES) and a session's sub-agents and
  // background tasks for a device that connected after they started (activity.ts).
  'remote:sessions': 'sessions',
  'remote:activity': 'sessions',
  'history:search': 'sessions',
  // What a session changed, read only, a page at a time (changes.ts: only files its review lists),
  // and the decisions its review loop offers while it waits for the person (review.ts).
  'remote:changes': 'sessions',
  'remote:diff': 'sessions',
  'remote:review': 'sessions',
  'remote:reviewDecide': 'sessions',
  'codeHost:lists': 'pullRequests',
  'remote:pullRequests': 'pullRequests',
  'metricAlerts:list': 'health',
  // Plan: the agenda, the inbox and the milestones. A brief starts a session on the desktop, as
  // sessions:start does.
  'plan:get': 'plan',
  'plan:brief': 'plan',
  'planner:get': 'plan',
  'planner:act': 'plan',
  'planner:addItem': 'plan',
  'planner:editItem': 'plan',
  'planner:saveMilestone': 'plan',
  'planner:deleteMilestone': 'plan',
  'planner:resolveProposal': 'plan',
  'planner:refreshMilestones': 'plan',
  'planner:openTickets': 'plan',
  // Automations: a paged list, run now, stop a run and turn one off (dispatcher.ts refuses turning one on).
  'remote:automations': 'automations',
  'automations:runNow': 'automations',
  'automations:stop': 'automations',
  'automations:setEnabled': 'automations'
}

/** One-way messages a device may send. `sessions:ready` is not one: it reopens the last quit's sessions. */
export const REMOTE_MESSAGES: Readonly<Record<string, RemoteCapability | 'any'>> = {
  'sessions:permission': 'sessions'
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
  'metricAlerts:changed': 'health',
  'plan:changed': 'plan',
  'planner:changed': 'plan'
}

export function remoteAllows(table: Readonly<Record<string, RemoteCapability | 'any'>>, channel: string, granted: ReadonlySet<RemoteCapability>): boolean {
  const needed = table[channel]
  if (needed === undefined) return false
  return needed === 'any' || granted.has(needed)
}
