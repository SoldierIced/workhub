import { Bell, Bot, Languages, Plug, Search, SlidersHorizontal, Smartphone, Users } from 'lucide-react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import { profileColor, type Profile } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsNavGroup, type SettingsSectionId } from './sections'

const ICON: Record<SettingsSectionId, ReactNode> = {
  general: <Languages className="size-4" aria-hidden />,
  notifications: <Bell className="size-4" aria-hidden />,
  agents: <Bot className="size-4" aria-hidden />,
  connections: <Plug className="size-4" aria-hidden />,
  remote: <Smartphone className="size-4" aria-hidden />,
  profiles: <Users className="size-4" aria-hidden />,
  advanced: <SlidersHorizontal className="size-4" aria-hidden />
}

export interface SettingsNavProps {
  section: SettingsSectionId
  onSection: (section: SettingsSectionId) => void
  /** Sections with a stored-config problem: they get a red dot. */
  withIssues: ReadonlySet<SettingsSectionId>
  profiles: readonly Profile[]
  activeProfileId: string | null
  /** The profile open in Profiles: its id, null for a new one, undefined when the list shows. */
  openProfileId: string | null | undefined
  /** Opens one profile (a sub-item of Profiles). */
  onProfile: (id: string) => void
  query: string
  onQuery: (query: string) => void
  onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void
  searchRef: RefObject<HTMLInputElement | null>
  groupLabel: (group: SettingsNavGroup) => string
}

const itemClass = (current: boolean) =>
  cn('flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors', current ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:bg-surface-hover hover:text-text')

/**
 * Settings' left column, 232 px: the search box, then the sections by group. While a profile is
 * open, Profiles lists every profile under it, the open one marked.
 */
export function SettingsNav(props: SettingsNavProps) {
  const { t } = useI18n()
  const profileOpen = props.section === 'profiles' && props.openProfileId !== undefined && !props.query
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
        const items = SETTINGS_SECTIONS.filter((s) => s.group === group)
        return (
          <div key={group} className="flex flex-col gap-0.5">
            <span className="px-2 pb-1 text-xs font-semibold tracking-wide text-subtle uppercase">{props.groupLabel(group)}</span>
            {items.map((s) => {
              // With a profile open, the profile is the current page, not the list.
              const current = s.id === props.section && !props.query && !(s.id === 'profiles' && profileOpen)
              return (
                <div key={s.id} className="flex flex-col gap-0.5">
                  <button type="button" aria-current={current ? 'page' : undefined} data-testid={`settings-nav-${s.id}`} onClick={() => props.onSection(s.id)} className={itemClass(current)}>
                    <span className={current ? 'text-accent' : 'text-subtle'}>{ICON[s.id]}</span>
                    <span className="min-w-0 flex-1 truncate">{t(s.label)}</span>
                    {props.withIssues.has(s.id) && <span className="size-2 shrink-0 rounded-full bg-danger" role="img" aria-label={t('settings.nav.hasIssues')} title={t('settings.nav.hasIssues')} data-testid={`settings-nav-issue-${s.id}`} />}
                  </button>
                  {s.id === 'profiles' && profileOpen && (
                    <ul className="flex flex-col gap-0.5 pl-6" data-testid="settings-nav-profiles">
                      {props.profiles.map((p) => {
                        const open = p.id === props.openProfileId
                        return (
                          <li key={p.id}>
                            <button type="button" aria-current={open ? 'page' : undefined} onClick={() => props.onProfile(p.id)} data-testid={`settings-nav-profile-${p.id}`} className={cn(itemClass(open), 'w-full')}>
                              <span className="size-2 shrink-0 rounded-full" style={{ background: profileColor(props.profiles, p.id) ?? 'var(--wh-accent)' }} aria-hidden />
                              <span className="min-w-0 flex-1 truncate">{p.name || p.id}</span>
                              {p.id === props.activeProfileId && <span className="text-xs text-subtle">{t('settingsV2.nav.activeMark')}</span>}
                            </button>
                          </li>
                        )
                      })}
                      {props.openProfileId === null && (
                        <li>
                          <span aria-current="page" className={cn(itemClass(true), 'w-full')}>
                            <span className="min-w-0 flex-1 truncate">{t('settings.newProfile')}</span>
                          </span>
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
