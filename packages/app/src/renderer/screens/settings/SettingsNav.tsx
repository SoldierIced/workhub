import { Activity, Bell, CalendarDays, Database, Download, Gauge, Languages, LayoutGrid, MessageSquare, Palette, Plug, Route as RouteIcon, Search, Siren, Sparkles, Ticket, UserCog, Users } from 'lucide-react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import type { Profile } from '@workhub/core'
import { Select } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsNavGroup, type SettingsSectionId } from './sections'

const ICON: Record<SettingsSectionId, ReactNode> = {
  general: <Languages className="size-4" aria-hidden />,
  appearance: <Palette className="size-4" aria-hidden />,
  notifications: <Bell className="size-4" aria-hidden />,
  alerts: <Siren className="size-4" aria-hidden />,
  agents: <UserCog className="size-4" aria-hidden />,
  usage: <Gauge className="size-4" aria-hidden />,
  connections: <Plug className="size-4" aria-hidden />,
  profile: <Users className="size-4" aria-hidden />,
  modules: <LayoutGrid className="size-4" aria-hidden />,
  tickets: <Ticket className="size-4" aria-hidden />,
  health: <Activity className="size-4" aria-hidden />,
  flowMaps: <RouteIcon className="size-4" aria-hidden />,
  plan: <CalendarDays className="size-4" aria-hidden />,
  slack: <MessageSquare className="size-4" aria-hidden />,
  aiReview: <Sparkles className="size-4" aria-hidden />,
  storage: <Database className="size-4" aria-hidden />,
  import: <Download className="size-4" aria-hidden />
}

/** The value of the profile picker that starts a new profile. */
export const NEW_PROFILE = '__new__'

export interface SettingsNavProps {
  section: SettingsSectionId
  onSection: (section: SettingsSectionId) => void
  visible: (section: SettingsSectionId) => boolean
  /** Sections with a stored-config problem: they get a red dot. */
  withIssues: ReadonlySet<SettingsSectionId>
  profiles: readonly Profile[]
  activeProfileId: string | null
  /** The profile the profile group edits; null while a new one is being created. */
  profileId: string | null
  onProfile: (id: string | null) => void
  query: string
  onQuery: (query: string) => void
  onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void
  searchRef: RefObject<HTMLInputElement | null>
  groupLabel: (group: SettingsNavGroup) => string
}

/** Settings' left column, 232 px: the search box, then the sections by group, the profile group led by its profile picker. */
export function SettingsNav(props: SettingsNavProps) {
  const { t } = useI18n()
  const profileOptions = [
    ...props.profiles.map((p) => ({ value: p.id, label: p.id === props.activeProfileId ? t('settings.profileActive', { name: p.name || p.id }) : p.name || p.id })),
    { value: NEW_PROFILE, label: t('settings.profileNew') }
  ]
  return (
    <nav aria-label={t('settings.navLabel')} className="flex w-[232px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface px-3 py-4" data-testid="settings-nav">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
        <input
          ref={props.searchRef}
          type="search"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={props.onSearchKey}
          placeholder={t('settings.search.placeholder')}
          aria-label={t('settings.search.placeholder')}
          spellCheck={false}
          data-testid="settings-search"
          className="h-8 w-full rounded-md border border-border bg-bg pr-2 pl-8 text-sm text-text placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        />
      </div>
      {SETTINGS_GROUPS.map((group) => {
        const items = SETTINGS_SECTIONS.filter((s) => s.group === group && props.visible(s.id))
        if (!items.length) return null
        return (
          <div key={group} className="flex flex-col gap-0.5">
            {group === 'profile' ? (
              <div className="flex flex-col gap-1 px-2 pb-1">
                <span className="text-xs font-semibold tracking-wide text-subtle uppercase">{t('settings.profilePicker')}</span>
                <Select aria-label={t('settings.profilePicker')} value={props.profileId ?? NEW_PROFILE} onChange={(v) => props.onProfile(v === NEW_PROFILE ? null : v)} options={profileOptions} />
              </div>
            ) : (
              <span className="px-2 pb-1 text-xs font-semibold tracking-wide text-subtle uppercase">{props.groupLabel(group)}</span>
            )}
            {items.map((s) => {
              const current = s.id === props.section && !props.query
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-current={current ? 'page' : undefined}
                  data-testid={`settings-nav-${s.id}`}
                  onClick={() => props.onSection(s.id)}
                  className={cn(
                    'flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
                    current ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:bg-surface-hover hover:text-text'
                  )}
                >
                  <span className={current ? 'text-accent' : 'text-subtle'}>{ICON[s.id]}</span>
                  <span className="min-w-0 flex-1 truncate">{t(s.label)}</span>
                  {props.withIssues.has(s.id) && <span className="size-2 shrink-0 rounded-full bg-danger" role="img" aria-label={t('settings.nav.hasIssues')} title={t('settings.nav.hasIssues')} data-testid={`settings-nav-issue-${s.id}`} />}
                </button>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
