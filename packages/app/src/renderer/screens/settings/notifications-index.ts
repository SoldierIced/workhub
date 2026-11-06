import { PR_EVENT_KINDS } from '@workhub/core'
import type { MessageKey } from '../../i18n/translate'
import { PR_KIND_HINT, PR_KIND_LABEL } from '../../lib/prEvents'

/** `data-setting-id` of every row of this section; the search index names the same rows. */
export const NOTIFICATION_ROW_IDS = {
  master: 'notifications.master',
  sessionsReplied: 'notifications.sessions.replied',
  sessionsNeedsAnswer: 'notifications.sessions.needsAnswer',
  sessionsError: 'notifications.sessions.error',
  pullRequests: 'notifications.pullRequests',
  usage: 'notifications.usage',
  healthEnvironments: 'notifications.health.environments',
  healthServices: 'notifications.health.services',
  metrics: 'notifications.metrics',
  flowMaps: 'notifications.flowMaps',
  tickets: 'notifications.tickets',
  meetings: 'notifications.meetings',
  slack: 'notifications.slack',
  automations: 'notifications.automations',
  quiet: 'notifications.quiet',
  badge: 'notifications.badge',
  panel: 'notifications.panel'
} as const
export const prRowId = (kind: string) => `${NOTIFICATION_ROW_IDS.pullRequests}.${kind}`
const ID = NOTIFICATION_ROW_IDS

/**
 * One searchable row of Settings → Notifications and alerts: the shape of `SettingsIndexEntry`
 * without its section, plus `id`, the row's `data-setting-id` (the section's `initialId`).
 */
export interface NotificationsIndexEntry {
  id: string
  label: MessageKey
  hint?: MessageKey
  help?: MessageKey
  subgroup?: MessageKey
}

type Row = readonly [id: string, label: MessageKey, hint?: MessageKey, help?: MessageKey]

const rows = (subgroup: MessageKey | undefined, list: readonly Row[]): NotificationsIndexEntry[] =>
  list.map(([id, label, hint, help]) => ({ id, label, ...(hint ? { hint } : {}), ...(help ? { help } : {}), ...(subgroup ? { subgroup } : {}) }))

/** Every row of the section, labels being the text the rows show. */
export const NOTIFICATIONS_INDEX: readonly NotificationsIndexEntry[] = [
  ...rows(undefined, [
    [ID.master, 'notifAlerts.master', 'notifAlerts.masterHint', 'help.general.notifications'],
    [ID.master, 'notify.test', 'notify.testHint'],
    [ID.master, 'notifAlerts.pauseLabel', 'settings.pauseHint']
  ]),
  ...rows('notifAlerts.group.sessions', [
    [ID.sessionsReplied, 'notifAlerts.row.replied', 'notifAlerts.row.repliedHint', 'notifAlerts.what.help'],
    [ID.sessionsNeedsAnswer, 'notifAlerts.row.needsAnswer'],
    [ID.sessionsError, 'notifAlerts.row.error']
  ]),
  ...rows('notifAlerts.group.pullRequests', [
    [ID.pullRequests, 'notifAlerts.row.pullRequests', undefined, 'help.general.prEvents'],
    ...PR_EVENT_KINDS.map((k): Row => [prRowId(k), PR_KIND_LABEL[k], PR_KIND_HINT[k]])
  ]),
  ...rows('notifAlerts.group.agents', [[ID.usage, 'notifAlerts.row.usage', 'notifAlerts.row.usageHint', 'help.usage.alerts']]),
  ...rows('notifAlerts.group.health', [
    [ID.healthEnvironments, 'notifAlerts.row.healthEnvironments', 'notifAlerts.row.healthEnvironmentsHint'],
    [ID.healthServices, 'notifAlerts.row.healthServices', 'notifAlerts.row.healthServicesHint'],
    [ID.metrics, 'notifAlerts.row.metrics', 'notifAlerts.row.metricsHint'],
    [ID.flowMaps, 'notifAlerts.row.flowMaps', 'notifAlerts.row.flowMapsHint']
  ]),
  ...rows('notifAlerts.group.work', [
    [ID.tickets, 'notifAlerts.row.tickets'],
    [ID.meetings, 'notifAlerts.row.meetings', 'notifAlerts.row.meetingsHint'],
    [ID.slack, 'notifAlerts.row.slack'],
    [ID.automations, 'notifAlerts.row.automations']
  ]),
  ...rows('notifAlerts.quiet.title', [[ID.quiet, 'alertsSettings.quiet.on', undefined, 'notifAlerts.quiet.help']]),
  ...rows('notifAlerts.icon.title', [
    [ID.badge, 'settings.appBadge', 'settings.appBadgeMac', 'help.general.appBadge'],
    [ID.panel, 'notifAlerts.panel.label', 'settings.trayPopoverNote'],
    [ID.panel, 'settings.trayPopover.meetings', 'settings.trayPopover.meetingsHint'],
    [ID.panel, 'settings.trayPopover.meetingCount'],
    [ID.panel, 'settings.trayPopover.plan', 'settings.trayPopover.planHint'],
    [ID.panel, 'settings.trayPopover.pullRequests', 'settings.trayPopover.pullRequestsHint'],
    [ID.panel, 'settings.trayPopover.health', 'settings.trayPopover.healthHint'],
    [ID.panel, 'settings.trayPopover.usage', 'settings.trayPopover.usageHint'],
    [ID.panel, 'settings.trayPopover.recent', 'settings.trayPopover.recentHint']
  ])
]
