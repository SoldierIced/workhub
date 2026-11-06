import { aiReviewSettings, resolveEffectiveAgents, type ConnectionKind, type OfferedModule, type Profile, type WorkhubConfig } from '@workhub/core'
import type { MessageKey, Params } from '../../i18n/translate'
import { PROFILE_SCREEN_LABEL, type ProfileScreen } from './sections'

/** One row of the Screens tab: the screen, the switch of its module, the connection it reads and (opened) its settings. */
export interface ScreenRow {
  key: ProfileScreen
  label: MessageKey
  hint: MessageKey
  module?: OfferedModule
  /** The connection kind picked on the row. */
  kind?: ConnectionKind
  /** The row has settings to open. */
  settings?: boolean
}

export const SCREEN_ROWS: readonly ScreenRow[] = [
  { key: 'pullRequests', label: PROFILE_SCREEN_LABEL.pullRequests, hint: 'settings.modules.pullRequestsHint', kind: 'codeHost' },
  { key: 'tickets', label: PROFILE_SCREEN_LABEL.tickets, hint: 'settings.modules.ticketsHint', kind: 'tracker', settings: true },
  { key: 'slack', label: PROFILE_SCREEN_LABEL.slack, hint: 'settings.modules.chatWatcherHint', module: 'chatWatcher', kind: 'chat', settings: true },
  { key: 'automations', label: PROFILE_SCREEN_LABEL.automations, hint: 'settings.modules.automationsHint', module: 'automations' },
  { key: 'health', label: PROFILE_SCREEN_LABEL.health, hint: 'health.settings.moduleHint', module: 'health', kind: 'health', settings: true },
  { key: 'flowMaps', label: PROFILE_SCREEN_LABEL.flowMaps, hint: 'flowMaps.settings.moduleHint', module: 'flowMaps', settings: true },
  { key: 'plan', label: PROFILE_SCREEN_LABEL.plan, hint: 'plan.settings.moduleHint', module: 'planner', settings: true },
  { key: 'aiReview', label: PROFILE_SCREEN_LABEL.aiReview, hint: 'aiReview.settings.hint', settings: true }
]

/** A profile in one line: how many folders, the screens it shows and the agents it offers. */
export function profileSummary(config: WorkhubConfig, profile: Profile, t: (key: MessageKey, params?: Params) => string): string {
  const folders = profile.folders?.filter((f) => f.trim()).length ?? 0
  const screens = SCREEN_ROWS.filter((row) => {
    if (row.key === 'aiReview') return aiReviewSettings(profile).enabled
    if (row.module) return profile.modules[row.module]
    return row.kind ? Boolean(profile.connections[row.kind]) : false
  }).map((row) => t(row.label))
  const agents = resolveEffectiveAgents(config, profile.id).map((a) => a.label)
  return [
    t(folders === 1 ? 'settingsV2.profiles.folders.one' : 'settingsV2.profiles.folders.other', { count: folders }),
    screens.length ? screens.join(', ') : t('settingsV2.profiles.noScreens'),
    agents.length ? agents.join(', ') : t('settingsV2.profiles.noAgents')
  ].join(' · ')
}

