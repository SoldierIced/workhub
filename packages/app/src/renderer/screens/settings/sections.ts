import type { MessageKey } from '../../i18n/translate'
import type { IssueTarget } from '../../lib/configIssues'
import { parseSettingsTarget } from '../../lib/settingsTarget'

/** The three groups of the Settings navigation: what holds for the whole app, what each profile has, and the rest. */
export type SettingsNavGroup = 'app' | 'profile' | 'advanced'

export type SettingsSectionId = 'general' | 'notifications' | 'agents' | 'connections' | 'profiles' | 'advanced'

export interface SettingsSectionMeta {
  id: SettingsSectionId
  group: SettingsNavGroup
  label: MessageKey
}

/** Every section in navigation order. Only Profiles edits a profile: the one opened from its list. */
export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: 'general', group: 'app', label: 'settings.nav.general' },
  { id: 'notifications', group: 'app', label: 'settingsV2.nav.notifications' },
  { id: 'agents', group: 'app', label: 'settingsV2.nav.agents' },
  { id: 'connections', group: 'app', label: 'settings.nav.connections' },
  { id: 'profiles', group: 'profile', label: 'settingsV2.nav.profiles' },
  { id: 'advanced', group: 'advanced', label: 'settingsV2.nav.advanced' }
]

export const SETTINGS_GROUPS: readonly SettingsNavGroup[] = ['app', 'profile', 'advanced']

export const sectionMeta = (id: SettingsSectionId): SettingsSectionMeta => SETTINGS_SECTIONS.find((s) => s.id === id)!

/** The tabs of an open profile. */
export type ProfileTab = 'folders' | 'screens' | 'agents' | 'sessions'

export const PROFILE_TABS: readonly { id: ProfileTab; label: MessageKey }[] = [
  { id: 'folders', label: 'settingsV2.tab.folders' },
  { id: 'screens', label: 'settingsV2.tab.screens' },
  { id: 'agents', label: 'settingsV2.tab.agents' },
  { id: 'sessions', label: 'settingsV2.tab.sessions' }
]

export const isProfileTab = (tab: string | undefined): tab is ProfileTab => PROFILE_TABS.some((x) => x.id === tab)

/** The rows of a profile's Screens tab, by the key their row (and a `#anchor` pointing at it) uses. */
export const PROFILE_SCREENS = ['pullRequests', 'tickets', 'slack', 'automations', 'health', 'flowMaps', 'plan', 'aiReview'] as const
export type ProfileScreen = (typeof PROFILE_SCREENS)[number]

/** The title of each screen's row (and of its place in a search result). */
export const PROFILE_SCREEN_LABEL: Readonly<Record<ProfileScreen, MessageKey>> = {
  pullRequests: 'nav.pullRequests',
  tickets: 'nav.tickets',
  slack: 'module.chatWatcher',
  automations: 'module.automations',
  health: 'module.health',
  flowMaps: 'module.flowMaps',
  plan: 'module.planner',
  aiReview: 'settingsV2.screens.aiReview'
}

export const isProfileScreen = (key: string | undefined): key is ProfileScreen => (PROFILE_SCREENS as readonly string[]).includes(key ?? '')

/**
 * Where Settings opens: a section and, inside Profiles, a profile (`id` absent: the active one) and
 * one of its tabs; `group` points at one group (in the Screens tab, one screen's row, opened).
 */
export interface SettingsTarget {
  section: SettingsSectionId
  group?: string
  profile?: { id?: string; tab: ProfileTab }
}

/**
 * The tab ids callers used before Settings v2 (`openSettings('trackers')`, setup fixes, the menu
 * bar icon, every old section id), each mapped to the place that now holds what it held. Old
 * per-profile sections open the active profile on the tab (and screen) that holds them.
 */
export const LEGACY_TABS: Readonly<Record<string, SettingsTarget>> = {
  appearance: { section: 'general', group: 'appearance' },
  alerts: { section: 'notifications' },
  accounts: { section: 'agents' },
  usage: { section: 'agents' },
  trackers: { section: 'connections', group: 'tickets' },
  profile: { section: 'profiles', profile: { tab: 'folders' } },
  modules: { section: 'profiles', profile: { tab: 'screens' } },
  tickets: { section: 'profiles', profile: { tab: 'screens' }, group: 'tickets' },
  health: { section: 'profiles', profile: { tab: 'screens' }, group: 'health' },
  flowMaps: { section: 'profiles', profile: { tab: 'screens' }, group: 'flowMaps' },
  plan: { section: 'profiles', profile: { tab: 'screens' }, group: 'plan' },
  slack: { section: 'profiles', profile: { tab: 'screens' }, group: 'slack' },
  aiReview: { section: 'profiles', profile: { tab: 'screens' }, group: 'aiReview' },
  storage: { section: 'advanced', group: 'data' },
  import: { section: 'advanced', group: 'data' }
}

const SECTION_IDS: ReadonlySet<string> = new Set(SETTINGS_SECTIONS.map((s) => s.id))

/** The place a tab id (old or new) opens; anything unknown opens General. */
function tabTarget(tab: string | undefined | null): SettingsTarget {
  if (!tab) return { section: 'general' }
  if (Object.hasOwn(LEGACY_TABS, tab)) {
    const legacy = LEGACY_TABS[tab]!
    return { ...legacy, ...(legacy.profile ? { profile: { ...legacy.profile } } : {}) }
  }
  return SECTION_IDS.has(tab) ? { section: tab as SettingsSectionId } : { section: 'general' }
}

/** The section a tab id (old or new) opens; anything unknown opens General. */
export function settingsSection(tab: string | undefined | null): SettingsSectionId {
  return tabTarget(tab).section
}

/**
 * A target as callers name it: a section (or old tab) id, optionally with `#anchor` for one of its
 * groups (`general#updates`), or `profiles/<profileId>[/<tab>][#<anchor>]` for one profile
 * (`profiles/acme/screens#health`; `profiles/acme#agents` also opens a tab).
 */
export function settingsTarget(target: string | undefined | null): SettingsTarget {
  const { tab, group, path } = parseSettingsTarget(target ?? undefined)
  const base = tabTarget(tab)
  if (base.section === 'profiles' && !base.profile && path?.[0]) {
    const [id, maybeTab] = path
    if (isProfileTab(maybeTab)) return { section: 'profiles', profile: { id, tab: maybeTab }, ...(group ? { group } : {}) }
    // `profiles/acme#agents`: an anchor that names a tab opens that tab.
    if (isProfileTab(group)) return { section: 'profiles', profile: { id, tab: group } }
    return { section: 'profiles', profile: { id, tab: isProfileScreen(group) ? 'screens' : 'folders' }, ...(group ? { group } : {}) }
  }
  return group ? { ...base, group } : base
}

/** The place a "Fix" button of a stored-config problem opens: a profile's problem opens that profile. */
export function issueTarget(target: IssueTarget): SettingsTarget {
  const id = target.id ? { id: target.id } : {}
  switch (target.tab) {
    case 'profiles':
      return { section: 'profiles', profile: { ...id, tab: target.profileTab ?? 'folders' } }
    case 'modules':
      return { section: 'profiles', profile: { ...id, tab: target.profileTab ?? 'screens' } }
    case 'health':
      return { section: 'profiles', profile: { tab: 'screens' }, group: 'health' }
    case 'plan':
      return { section: 'profiles', profile: { tab: 'screens' }, group: 'plan' }
    case 'trackers':
    case 'connections':
      return { section: 'connections' }
    case 'accounts':
      return { section: 'agents' }
  }
}

/** The section a "Fix" button of a stored-config problem opens. */
export function issueSection(target: IssueTarget): SettingsSectionId {
  return issueTarget(target).section
}
