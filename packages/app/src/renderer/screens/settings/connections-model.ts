import { CALENDAR_CONNECTION_SETTINGS, HEALTH_CONNECTION_SETTINGS, type Connection, type ConnectionKind, type WorkhubConfig } from '@workhub/core'
import type { MessageKey } from '../../i18n/translate'
import { looksLikeCalendarUrl } from '../../lib/plan'
import { uniqueConnectionId } from '../../lib/tickets'
import { TRACKER_SETTINGS, trackerSiteUrl } from '../../lib/trackerSettings'
import { connectionUsers } from './shared'

/** The groups of Settings → Connections, in order, each holding the connections of one kind. */
export const CONNECTION_GROUPS: readonly { id: 'code' | 'tickets' | 'calendars' | 'slack' | 'health'; kind: ConnectionKind }[] = [
  { id: 'code', kind: 'codeHost' },
  { id: 'tickets', kind: 'tracker' },
  { id: 'calendars', kind: 'calendar' },
  { id: 'slack', kind: 'chat' },
  { id: 'health', kind: 'health' }
]
export type ConnectionGroupId = (typeof CONNECTION_GROUPS)[number]['id']

/** The screen of a profile that reads a connection of each kind. */
export const SCREEN_OF_KIND: Record<ConnectionKind, MessageKey> = {
  codeHost: 'settingsConnections.screen.pullRequests',
  tracker: 'settingsConnections.screen.tickets',
  chat: 'settingsConnections.screen.slack',
  health: 'settingsConnections.screen.health',
  calendar: 'settingsConnections.screen.plan'
}

/** One profile using a connection, and the screen that reads it. */
export interface ConnectionUse {
  profileId: string
  profileName: string
  screen: MessageKey
}

/** Who uses a connection: every profile that picks it (`connectionUsers`), with the screen it is picked for. */
export function connectionUses(config: WorkhubConfig, connectionId: string): ConnectionUse[] {
  const out: ConnectionUse[] = []
  for (const p of connectionUsers(config, connectionId)) {
    const profileName = p.name || p.id
    for (const [kind, id] of Object.entries(p.connections) as [ConnectionKind, string][]) if (id === connectionId) out.push({ profileId: p.id, profileName, screen: SCREEN_OF_KIND[kind] })
    if ((p.planner?.calendarIds ?? []).includes(connectionId)) out.push({ profileId: p.id, profileName, screen: SCREEN_OF_KIND.calendar })
  }
  return out
}

/** The connections of each group, in the order of `CONNECTION_GROUPS`; a group may be empty. */
export function groupConnections(connections: readonly Connection[]): { id: ConnectionGroupId; kind: ConnectionKind; connections: Connection[] }[] {
  return CONNECTION_GROUPS.map((g) => ({ ...g, connections: connections.filter((c) => c.kind === g.kind) }))
}

/** A blank connection of a kind and provider (its id is made on save). */
export function newConnection(kind: ConnectionKind, provider: string): Connection {
  return { id: '', kind, provider, settings: {} }
}

/** What stops a connection from being saved or tested, as the named fields say it; null when nothing does. */
export function connectionProblem(c: Connection, typedSecret: string, storedSecret: boolean): MessageKey | null {
  const s = c.settings
  const secret = typedSecret.trim() !== '' || storedSecret
  switch (c.kind) {
    case 'tracker':
      if (c.provider === 'jira' && !c.endpoint?.trim()) return 'trackers.missing.site'
      if (c.provider === 'jira' && !s[TRACKER_SETTINGS.email]?.trim()) return 'trackers.missing.email'
      return secret ? null : 'trackers.missing.token'
    case 'health':
      if (!c.endpoint?.trim()) return 'health.settings.missing.url'
      if (s[HEALTH_CONNECTION_SETTINGS.auth] === 'basic' && (!s[HEALTH_CONNECTION_SETTINGS.username]?.trim() || s[HEALTH_CONNECTION_SETTINGS.username]!.includes(':'))) return 'health.settings.missing.user'
      if (!secret) return 'health.settings.missing.secret'
      if (s[HEALTH_CONNECTION_SETTINGS.tls] === 'pinned' && (s[HEALTH_CONNECTION_SETTINGS.fingerprint] ?? '').replace(/[^0-9a-fA-F]/g, '').length !== 64) return 'health.settings.missing.fingerprint'
      return null
    case 'calendar':
      if (typedSecret.trim() && !looksLikeCalendarUrl(typedSecret)) return 'plan.settings.badAddress'
      return secret ? null : 'plan.settings.missingAddress'
    default:
      return null
  }
}

/**
 * The connection as stored: an id for a new one (from its name or provider), values trimmed,
 * empty name and endpoint left out, a Jira site made a URL, a calendar owner in lower case.
 */
export function connectionToSave(c: Connection, takenIds: readonly string[]): Connection {
  const id = c.id.trim() || uniqueConnectionId(c.name?.trim() || c.provider, takenIds)
  const settings: Record<string, string> = {}
  for (const [k, v] of Object.entries(c.settings)) if (k.trim() && v.trim()) settings[k.trim()] = v.trim()
  const owner = settings[CALENDAR_CONNECTION_SETTINGS.ownerEmail]
  if (c.kind === 'calendar' && owner) settings[CALENDAR_CONNECTION_SETTINGS.ownerEmail] = owner.toLowerCase()
  if (c.kind === 'tracker' && c.provider !== 'jira') delete settings[TRACKER_SETTINGS.email]
  let endpoint = c.endpoint?.trim()
  if (endpoint && c.kind === 'tracker' && c.provider === 'jira') endpoint = trackerSiteUrl(endpoint)
  if (c.kind === 'tracker' && c.provider !== 'jira') endpoint = undefined
  const out: Connection = { id, kind: c.kind, provider: c.provider, settings }
  if (c.name?.trim()) out.name = c.name.trim()
  if (endpoint) out.endpoint = endpoint
  if (c.secretRef) out.secretRef = c.secretRef
  return out
}
