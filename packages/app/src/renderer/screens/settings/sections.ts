import type { MessageKey } from '../../i18n/translate'
import type { IssueTarget } from '../../lib/configIssues'
import { parseSettingsTarget } from '../../lib/settingsTarget'

/** The three groups of the Settings navigation. */
export type SettingsNavGroup = 'workhub' | 'profile' | 'advanced'

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'alerts'
  | 'agents'
  | 'usage'
  | 'connections'
  | 'profile'
  | 'modules'
  | 'tickets'
  | 'health'
  | 'flowMaps'
  | 'plan'
  | 'slack'
  | 'aiReview'
  | 'storage'
  | 'import'

export interface SettingsSectionMeta {
  id: SettingsSectionId
  group: SettingsNavGroup
  label: MessageKey
}

/** Every section in navigation order. Sections of the `profile` group edit the profile picked in the group heading. */
export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: 'general', group: 'workhub', label: 'settings.nav.general' },
  { id: 'appearance', group: 'workhub', label: 'settings.nav.appearance' },
  { id: 'notifications', group: 'workhub', label: 'settings.nav.notifications' },
  { id: 'alerts', group: 'workhub', label: 'settings.nav.alerts' },
  { id: 'agents', group: 'workhub', label: 'settings.nav.agents' },
  { id: 'usage', group: 'workhub', label: 'settings.nav.usage' },
  { id: 'connections', group: 'workhub', label: 'settings.nav.connections' },
  { id: 'profile', group: 'profile', label: 'settings.nav.profile' },
  { id: 'modules', group: 'profile', label: 'settings.nav.modules' },
  { id: 'tickets', group: 'profile', label: 'settings.nav.tickets' },
  { id: 'health', group: 'profile', label: 'settings.nav.health' },
  { id: 'flowMaps', group: 'profile', label: 'settings.nav.flowMaps' },
  { id: 'plan', group: 'profile', label: 'settings.nav.plan' },
  { id: 'slack', group: 'profile', label: 'settings.nav.slack' },
  { id: 'aiReview', group: 'profile', label: 'settings.nav.aiReview' },
  { id: 'storage', group: 'advanced', label: 'settings.nav.storage' },
  { id: 'import', group: 'advanced', label: 'settings.nav.import' }
]

export const SETTINGS_GROUPS: readonly SettingsNavGroup[] = ['workhub', 'profile', 'advanced']

export const sectionMeta = (id: SettingsSectionId): SettingsSectionMeta => SETTINGS_SECTIONS.find((s) => s.id === id)!

/**
 * The tab ids callers used before Settings had sections (`openSettings('trackers')`, setup fixes,
 * the menu bar icon), each mapped to the section that now holds what that tab held.
 */
export const LEGACY_TABS: Readonly<Record<string, SettingsSectionId>> = {
  general: 'general',
  appearance: 'appearance',
  profiles: 'profile',
  accounts: 'agents',
  agents: 'agents',
  connections: 'connections',
  trackers: 'tickets',
  health: 'health',
  flowMaps: 'flowMaps',
  plan: 'plan',
  slack: 'slack',
  usage: 'usage'
}

const SECTION_IDS: ReadonlySet<string> = new Set(SETTINGS_SECTIONS.map((s) => s.id))

/** The section a tab id (old or new) opens; anything unknown opens General. */
export function settingsSection(tab: string | undefined | null): SettingsSectionId {
  if (!tab) return 'general'
  if (Object.hasOwn(LEGACY_TABS, tab)) return LEGACY_TABS[tab]!
  return SECTION_IDS.has(tab) ? (tab as SettingsSectionId) : 'general'
}

/**
 * A target as callers name it: a section (or old tab) id, optionally with `#anchor` for one of its
 * groups (`general#updates`: General, pointing at the Updates group).
 */
export function settingsTarget(target: string | undefined | null): { section: SettingsSectionId; group?: string } {
  const { tab, group } = parseSettingsTarget(target ?? undefined)
  return { section: settingsSection(tab), ...(group ? { group } : {}) }
}

/** The section a "Fix" button of a stored-config problem opens. */
export function issueSection(target: IssueTarget): SettingsSectionId {
  return settingsSection(target.tab)
}
