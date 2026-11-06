import type { SettingsIndexRow } from './agents-index'

/** `data-setting-id` of the rows of Settings → Connections; the search index names the same rows. */
export const CONNECTIONS_ROW_IDS = {
  code: 'connections.code',
  protectedBranches: 'connections.protectedBranches',
  tickets: 'connections.tickets',
  calendars: 'connections.calendars',
  slack: 'connections.slack',
  health: 'connections.health',
  healthFloor: 'connections.healthFloor'
} as const

/** The rows of Settings → Connections for the settings search. */
export const CONNECTIONS_INDEX: readonly SettingsIndexRow[] = [
  { id: CONNECTIONS_ROW_IDS.code, label: 'settingsConnections.group.code', hint: 'settingsConnections.add.github', help: 'settingsConnections.group.codeHelp' },
  { id: CONNECTIONS_ROW_IDS.protectedBranches, label: 'settings.protectedBranches', hint: 'settings.protectedBranchesHint', subgroup: 'settingsConnections.group.code' },
  { id: CONNECTIONS_ROW_IDS.tickets, label: 'settingsConnections.group.tickets', hint: 'settingsConnections.add.jira', help: 'settingsConnections.group.ticketsHelp' },
  { id: CONNECTIONS_ROW_IDS.calendars, label: 'settingsConnections.group.calendars', hint: 'settingsConnections.add.calendar', help: 'settingsConnections.group.calendarsHelp' },
  { id: CONNECTIONS_ROW_IDS.slack, label: 'settingsConnections.watchSlack', help: 'settingsConnections.group.slackHelp', subgroup: 'settingsConnections.group.slack' },
  { id: CONNECTIONS_ROW_IDS.health, label: 'settingsConnections.group.health', help: 'settingsConnections.group.healthHelp' },
  { id: CONNECTIONS_ROW_IDS.healthFloor, label: 'settingsConnections.healthFloor', hint: 'health.settings.floorHint', subgroup: 'settingsConnections.group.health' }
]
