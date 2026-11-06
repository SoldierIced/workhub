import type { MessageKey } from '../../i18n/translate'
import { SETTINGS_SECTIONS, type SettingsNavGroup, type SettingsSectionId } from './sections'

/**
 * One searchable row of Settings: its label, hint and help (i18n keys, so the index works in the
 * active language) and the subgroup heading it sits under. Sections that are not on screen are not
 * rendered, so the index is this static table instead of being collected from the mounted rows.
 */
export interface SettingsIndexEntry {
  section: SettingsSectionId
  label: MessageKey
  hint?: MessageKey
  help?: MessageKey
  subgroup?: MessageKey
}

type Row = readonly [label: MessageKey, hint?: MessageKey, help?: MessageKey]

const rows = (section: SettingsSectionId, subgroup: MessageKey | undefined, list: readonly Row[]): SettingsIndexEntry[] =>
  list.map(([label, hint, help]) => ({ section, label, ...(hint ? { hint } : {}), ...(help ? { help } : {}), ...(subgroup ? { subgroup } : {}) }))

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  ...rows('general', 'settings.interface', [['settings.language', 'settings.languageHint', 'help.general.interface']]),
  ...rows('general', 'settings.sessionsGroup', [['settings.reopenSessions', 'settings.reopenSessionsHint', 'help.general.sessions']]),
  ...rows('general', 'updates.group', [['updates.check', 'updates.checkHint', 'help.general.updates']]),
  ...rows('general', 'setup.entry.legend', [['setup.entry.check', 'setup.entry.checkHint'], ['setup.entry.welcome', 'setup.entry.welcomeHint'], ['setup.entry.help', 'setup.entry.helpHint']]),
  ...rows('general', 'voice.group', [
    ['voice.voice', undefined, 'voice.help'],
    ['voice.rate', 'voice.wpm'],
    ['voice.default', 'voice.defaultHint'],
    ['voice.listenModel', 'voice.listenModelHint']
  ]),

  ...rows('appearance', 'appearance.themeGroup', [['settings.theme', undefined, 'help.appearance.theme'], ['appearance.themeApp']]),
  ...rows('appearance', 'appearance.base', [['appearance.base', undefined, 'help.appearance.base']]),
  ...rows('appearance', 'appearance.terminalFont', [['appearance.fontFamily', undefined, 'help.appearance.terminalFont'], ['appearance.fontSize']]),
  ...rows('appearance', 'appearance.textGroup', [['appearance.textSize', 'appearance.textSizeHint', 'help.appearance.text'], ['appearance.chatSize', 'appearance.chatSizeHint']]),

  ...rows('notifications', 'settings.notifications', [
    ['notify.master', 'notify.masterHint', 'help.general.notifications'],
    ['notify.testTitle', 'notify.testHint'],
    ['settings.notifyReplied', 'settings.notifyRepliedHint'],
    ['settings.notifyNeedsAnswer', 'settings.notifyNeedsAnswerHint'],
    ['settings.notifyError', 'settings.notifyErrorHint']
  ]),
  ...rows('notifications', 'settings.otherNotifications', [
    ['settings.notifySlack', 'settings.notifySlackHint', 'help.general.otherNotifications'],
    ['settings.notifyAutomations', 'settings.notifyAutomationsHint'],
    ['settings.notifyTickets', 'settings.notifyTicketsHint'],
    ['settings.notifyHealth', 'settings.notifyHealthHint'],
    ['settings.notifyFlowMaps', 'settings.notifyFlowMapsHint'],
    ['settings.notifyMeetings', 'settings.notifyMeetingsHint'],
    ['settings.notifyMetricAlerts', 'settings.notifyMetricAlertsHint'],
    ['settings.pause', 'settings.pauseHint']
  ]),
  ...rows('notifications', 'prevent.settings.title', [
    ['prevent.kind.reviewRequested', 'prevent.hint.reviewRequested', 'help.general.prEvents'],
    ['prevent.kind.approved', 'prevent.hint.approved'],
    ['prevent.kind.changesRequested', 'prevent.hint.changesRequested'],
    ['prevent.kind.newComments', 'prevent.hint.newComments'],
    ['prevent.kind.ciFailed', 'prevent.hint.ciFailed'],
    ['prevent.kind.ciPassed', 'prevent.hint.ciPassed'],
    ['prevent.kind.conflicts', 'prevent.hint.conflicts'],
    ['prevent.kind.newCommits', 'prevent.hint.newCommits']
  ]),
  ...rows('notifications', 'settings.pullRequests', [['settings.protectedBranches', 'settings.protectedBranchesHint']]),
  ...rows('notifications', 'settings.menuBar', [
    ['settings.keepInTray', 'settings.keepInTrayHint', 'help.general.menuBar'],
    ['settings.appBadge', 'settings.appBadgeMac', 'help.general.appBadge']
  ]),
  ...rows('notifications', 'settings.trayPopover', [
    ['settings.trayPopover', 'settings.trayPopoverNote'],
    ['settings.trayPopover.meetings', 'settings.trayPopover.meetingsHint'],
    ['settings.trayPopover.meetingCount'],
    ['settings.trayPopover.plan', 'settings.trayPopover.planHint'],
    ['settings.trayPopover.pullRequests', 'settings.trayPopover.pullRequestsHint'],
    ['settings.trayPopover.health', 'settings.trayPopover.healthHint'],
    ['settings.trayPopover.usage', 'settings.trayPopover.usageHint'],
    ['settings.trayPopover.recent', 'settings.trayPopover.recentHint']
  ]),

  ...rows('alerts', undefined, [['settings.nav.alerts', 'settings.intro.alerts']]),

  ...rows('agents', 'agents.installedTitle', [['agents.installedTitle', 'agents.installedNote', 'agents.installedHelp']]),
  ...rows('agents', 'settings.agentOrder', [['settings.agentOrder', 'settings.agentOrderHint', 'agents.orderHelp'], ['continuity.settings.mode', 'continuity.settings.hint', 'help.profile.accountFailover']]),
  ...rows('agents', 'settings.accountsList', [
    ['settings.accountsList', 'settings.accountsHint', 'help.accounts.list'],
    ['accounts.add', 'accounts.intro'],
    ['accounts.makeDefault', 'accounts.defaultHelp'],
    ['settings.configDir', undefined, 'help.account.configDir'],
    ['settings.envLines', 'settings.envStoredNote', 'help.account.env'],
    ['settings.accountCommand', undefined, 'help.account.command'],
    ['settings.defaultModel', 'settings.defaultModelHint', 'help.account.defaultModel'],
    ['settings.defaultMode', 'settings.defaultModeHint', 'help.account.defaultMode']
  ]),

  ...rows('usage', 'agentUsage.settings.reading', [
    ['agentUsage.settings.claude', 'settings.planUsageHint', 'help.usage.reading'],
    ['agentUsage.settings.codex', 'agentUsage.settings.codexHint'],
    ['agentUsage.settings.kiro', 'agentUsage.settings.kiroHint', 'agentUsage.settings.kiroNote']
  ]),
  ...rows('usage', 'agentUsage.settings.budgets', [['agentUsage.settings.budgets', 'agentUsage.settings.budgetsNote', 'help.usage.budgets'], ['agentUsage.settings.margin', 'agentUsage.settings.marginHint']]),
  ...rows('usage', 'agentUsage.settings.alerts', [['agentUsage.settings.alertsOn', 'agentUsage.settings.alertsHint', 'help.usage.alerts'], ['agentUsage.settings.thresholds', 'agentUsage.settings.thresholdsHint']]),

  ...rows('connections', undefined, [
    ['settings.kind', undefined, 'help.connection.kind'],
    ['settings.provider', undefined, 'help.connection.provider'],
    ['settings.endpoint', undefined, 'help.connection.endpoint'],
    ['settings.secret', 'settings.secretHint', 'help.connection.secret'],
    ['settings.settingsLines', undefined, 'help.connection.settings']
  ]),

  ...rows('profile', undefined, [
    ['settings.name'],
    ['settings.folders', 'settings.foldersHint', 'help.profile.folders'],
    ['settings.defaultFolder', 'settings.defaultFolderHint']
  ]),
  ...rows('profile', 'profileExtra.symbol', [['profileExtra.symbol', undefined, 'profileExtra.symbolHelp']]),
  ...rows('profile', 'profileExtra.folderFlags', [['profileExtra.onlyGitRepos', undefined, 'profileExtra.folderFlagsHelp'], ['profileExtra.subfolders', 'profileExtra.subfoldersHint'], ['profileExtra.folderWorktrees', 'profileExtra.folderWorktreesHint']]),
  ...rows('profile', 'profileExtra.worktrees', [
    ['profileExtra.worktreesEnabled', 'profileExtra.worktreesEnabledHint', 'profileExtra.worktreesHelp'],
    ['profileExtra.worktreesLocation', 'profileExtra.worktreesLocationHint'],
    ['profileExtra.worktreesPrefix', 'profileExtra.worktreesPrefixHint'],
    ['profileExtra.worktreesBase', 'profileExtra.worktreesBaseHint'],
    ['profileExtra.worktreesOnClose']
  ]),
  ...rows('profile', 'profileExtra.links', [['profileExtra.linkBrowser', 'profileExtra.linkBrowserHint'], ['profileExtra.ownsOutside', 'profileExtra.ownsOutsideHint']]),
  ...rows('profile', 'profileExtra.env', [['profileExtra.env', undefined, 'profileExtra.envHelp']]),
  ...rows('profile', 'nav.slack', [['slack.archiveAfter', 'slack.archiveAfterHint', 'help.profile.slack']]),

  ...rows('modules', 'settings.modules.screens', [
    ['module.health', 'health.settings.moduleHint', 'help.profile.modules'],
    ['module.flowMaps', 'flowMaps.settings.moduleHint'],
    ['module.planner', 'plan.settings.moduleHint'],
    ['module.chatWatcher', 'settings.modules.chatWatcherHint'],
    ['module.automations', 'settings.modules.automationsHint'],
    ['nav.tickets', 'settings.modules.ticketsHint'],
    ['nav.pullRequests', 'settings.modules.pullRequestsHint']
  ]),
  ...rows('modules', 'settings.connections', [['settings.connections', undefined, 'help.profile.connections']]),
  ...rows('modules', 'settings.accountsList', [['settings.accountsList', 'settings.accountsOwnSignIn', 'help.profile.accounts']]),
  ...rows('modules', 'settings.agentsOffered', [['settings.allAgents', undefined, 'help.profile.agentsOffered']]),

  ...rows('tickets', 'trackers.list', [
    ['trackers.provider', undefined, 'help.trackers.list'],
    ['trackers.site', 'trackers.siteHint'],
    ['trackers.email'],
    ['trackers.projectKeys', 'trackers.projectKeysHint'],
    ['trackers.ignoredStatuses', 'trackers.ignoredStatusesHint'],
    ['trackers.useInProfile']
  ]),

  ...rows('health', 'health.settings.connection', [
    ['health.settings.url', 'health.settings.urlHint', 'help.health.connection'],
    ['health.settings.auth'],
    ['health.settings.tls', undefined, 'help.health.tls'],
    ['health.settings.fingerprint', 'health.settings.fingerprintHint']
  ]),
  ...rows('health', 'health.settings.environments', [
    ['health.settings.refresh', undefined, 'help.health.environments'],
    ['health.settings.floor', 'health.settings.floorHint'],
    ['health.settings.envName'],
    ['health.settings.indexErrors'],
    ['health.settings.indexTraces'],
    ['health.settings.indexMetrics'],
    ['health.settings.kibana', 'health.settings.kibanaHint'],
    ['health.settings.kubeState', 'health.settings.kubeStateHint']
  ]),

  ...rows('flowMaps', 'flowMaps.settings.folder', [['flowMaps.settings.folder', 'flowMaps.settings.folderHint'], ['flowMaps.settings.import', 'flowMaps.settings.format']]),
  ...rows('flowMaps', 'flowMaps.settings.list', [['flowMaps.settings.list']]),

  ...rows('plan', 'plan.settings.calendars', [['plan.settings.calendars', undefined, 'plan.settings.calendarsHelp'], ['plan.settings.refresh', 'plan.settings.refreshHint'], ['plan.settings.address', 'plan.settings.addressHint']]),
  ...rows('plan', 'plan.settings.reminders', [['plan.settings.defaultLead', 'plan.settings.defaultLeadHint', 'plan.settings.remindersHelp'], ['plan.settings.ruleName'], ['plan.settings.ruleMessage', 'plan.settings.ruleMessageHint']]),
  ...rows('plan', 'plan.settings.template', [['plan.settings.template', undefined, 'plan.settings.templateHelp']]),
  ...rows('plan', 'plan.settings.people', [['plan.settings.people', undefined, 'plan.settings.peopleHelp']]),
  ...rows('plan', 'planner.settings.inbox', [['planner.settings.tracker', 'planner.settings.trackerHint', 'planner.settings.inboxHelp'], ['planner.settings.project', 'planner.settings.projectHint'], ['planner.settings.agentMilestones', 'planner.settings.agentMilestonesHint']]),

  ...rows('slack', 'slack.settings.watcher', [
    ['slack.settings.enabled', 'slack.settings.explain', 'help.slack.watcher'],
    ['slack.settings.account', undefined, 'help.slack.account'],
    ['slack.settings.model', undefined, 'help.slack.model'],
    ['slack.settings.interval', 'slack.settings.intervalHint'],
    ['slack.settings.usage', 'slack.settings.usageHint'],
    ['slack.settings.hours', undefined, 'help.slack.hours'],
    ['slack.settings.channels']
  ]),
  ...rows('slack', 'slack.hook.title', [['slack.hook.title', undefined, 'help.slack.hook']]),

  ...rows('aiReview', undefined, [
    ['aiReview.settings.enabled', 'aiReview.settings.hint', 'help.profile.aiReview'],
    ['aiReview.settings.auto'],
    ['aiReview.settings.reviewer', undefined, 'help.aiReview.reviewer'],
    ['aiReview.settings.reviewerModel', 'aiReview.settings.reviewerModelHint'],
    ['aiReview.settings.reviewerEffort', 'aiReview.settings.reviewerEffortHint'],
    ['aiReview.settings.reviewerSession', 'aiReview.settings.reviewerSessionHint'],
    ['aiReview.settings.maxRounds', undefined, 'help.aiReview.maxRounds'],
    ['aiReview.settings.idleSeconds', undefined, 'help.aiReview.idleSeconds'],
    ['aiReview.settings.baseBranch', 'aiReview.settings.baseBranchHint'],
    ['aiReview.settings.checklist', 'aiReview.settings.checklistHint'],
    ['aiReview.settings.language'],
    ['aiReview.settings.briefPrompt']
  ]),

  ...rows('storage', 'settings.storage', [['settings.dataDir', 'settings.intro.storage', 'help.general.storage']]),
  ...rows('import', undefined, [['import.migrate', 'import.migrateHint', 'help.general.import']])
]

/** Lower case without accents, so "notificacion" finds "Notificación". */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export interface SettingsHit {
  entry: SettingsIndexEntry
  /** Group › Section › Subgroup, translated. */
  breadcrumb: string[]
  label: string
  hint?: string
}

export interface SearchOptions {
  /** The translated label of a key. */
  t: (key: MessageKey) => string
  /** The translated heading of a navigation group (the profile group names the profile). */
  groupLabel: (group: SettingsNavGroup) => string
  /** Sections hidden on this computer (Import outside macOS) are left out. */
  visible?: (section: SettingsSectionId) => boolean
  limit?: number
}

/**
 * The rows whose label, hint, help or headings contain every word of the query, compared without
 * case or accents in the active language. Label matches come first, then the index order.
 */
export function searchSettings(index: readonly SettingsIndexEntry[], query: string, { t, groupLabel, visible, limit = 40 }: SearchOptions): SettingsHit[] {
  const words = foldText(query).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored: { hit: SettingsHit; score: number; order: number }[] = []
  index.forEach((entry, order) => {
    if (visible && !visible(entry.section)) return
    const meta = SETTINGS_SECTIONS.find((s) => s.id === entry.section)
    if (!meta) return
    const label = t(entry.label)
    const hint = entry.hint ? t(entry.hint) : undefined
    const breadcrumb = [groupLabel(meta.group), t(meta.label), ...(entry.subgroup && entry.subgroup !== entry.label ? [t(entry.subgroup)] : [])]
    const foldedLabel = foldText(label)
    const haystack = foldText([label, hint ?? '', entry.help ? t(entry.help) : '', ...breadcrumb].join(' \u0000 '))
    if (!words.every((w) => haystack.includes(w))) return
    const score = words.every((w) => foldedLabel.includes(w)) ? (foldedLabel.startsWith(words[0]!) ? 0 : 1) : 2
    scored.push({ hit: { entry, breadcrumb, label, ...(hint ? { hint } : {}) }, score, order })
  })
  scored.sort((a, b) => a.score - b.score || a.order - b.order)
  // One result per row: a label repeated in a section (two groups both named "Accounts") shows once.
  const seen = new Set<string>()
  const out: SettingsHit[] = []
  for (const { hit } of scored) {
    const key = `${hit.entry.section}\u0000${hit.entry.label}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
    if (out.length >= limit) break
  }
  return out
}
