import { Folder, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Profile } from '@workhub/core'
import type { SessionView } from '@shared/api'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { folderName, type UsageGroup } from '../../lib/home'
import type { NavItem, Route } from '../../lib/nav'
import { usePlatform } from '../../lib/platform'
import { ROUTE_ICON, ROUTE_LABEL } from '../../lib/routes'
import { IconButton } from '../atoms/IconButton'
import { Kbd } from '../atoms/Kbd'
import { STATE_TONE, StateDot } from '../atoms/StateDot'
import { ProfileSwitcher } from './ProfileSwitcher'
import { UsageCard } from './UsageCard'

export interface SidebarProps {
  route: Route
  navItems: NavItem[]
  sessionsItem: NavItem
  onNavigate: (route: Route) => void
  profiles: Profile[]
  activeProfileId: string | null
  onSelectProfile: (id: string) => void
  onManageProfiles: () => void
  sessions: SessionView[]
  selectedSessionId: string | null
  onSelectSession: (id: string) => void
  folders: string[]
  onNewSessionIn: (folder: string | null) => void
  usage: UsageGroup[]
}

function SectionTitle({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-2.5 pt-3">
      <h2 className="text-xs font-semibold tracking-wide text-subtle uppercase">{children}</h2>
      {action}
    </div>
  )
}

function NavButton({ item, active, onNavigate, badge }: { item: NavItem; active: boolean; onNavigate: (r: Route) => void; badge?: ReactNode }) {
  const { t } = useI18n()
  const Icon = ROUTE_ICON[item.route]
  return (
    <button
      type="button"
      onClick={() => onNavigate(item.route)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-base transition-colors duration-150',
        active ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:bg-surface-hover hover:text-text'
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-subtle group-hover:text-muted')} aria-hidden />
      <span className="flex-1 truncate">{t(ROUTE_LABEL[item.route])}</span>
      {badge}
      <Kbd shortcut={item.shortcut} className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  )
}

/** Workhub 1's sidebar: profile switcher, navigation, sessions and folders, usage at the bottom. */
export function Sidebar(props: SidebarProps) {
  const { t } = useI18n()
  const platform = usePlatform()
  const running = props.sessions.filter((s) => s.state === 'starting' || s.state === 'busy' || s.state === 'ready').length
  return (
    <aside aria-label={t('sidebar.label')} className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      {/* macOS draws its traffic lights here (hiddenInset); the strip drags the window. */}
      <div className={cn('drag-region shrink-0', platform === 'mac' ? 'h-11' : 'h-3')} />
      <div className="shrink-0 px-3">
        <ProfileSwitcher profiles={props.profiles} activeId={props.activeProfileId} onSelect={props.onSelectProfile} onManage={props.onManageProfiles} />
      </div>
      <nav aria-label={t('sidebar.navigation')} className="mt-3 flex shrink-0 flex-col gap-0.5 px-3">
        {props.navItems.map((item) => (
          <NavButton key={item.route} item={item} active={props.route === item.route} onNavigate={props.onNavigate} />
        ))}
      </nav>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="mx-2.5 my-2 h-px bg-border" aria-hidden />
        <NavButton
          item={props.sessionsItem}
          active={props.route === 'sessions' && !props.selectedSessionId}
          onNavigate={props.onNavigate}
          badge={running > 0 ? <span className="rounded-full bg-surface-hover px-1.5 text-xs tabular-nums text-muted">{running}</span> : undefined}
        />
        <ul className="mt-0.5 flex flex-col gap-0.5" aria-label={t('sidebar.sessionList')}>
          {props.sessions.map((s) => {
            const selected = props.route === 'sessions' && props.selectedSessionId === s.id
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => props.onSelectSession(s.id)}
                  aria-current={selected ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md py-1.5 pr-2 pl-3.5 text-left transition-colors duration-150',
                    selected ? 'bg-accent-soft text-text' : 'text-muted hover:bg-surface-hover hover:text-text'
                  )}
                >
                  <StateDot tone={STATE_TONE[s.state]} pulse={s.state === 'busy' || s.state === 'starting'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base">{s.agentName}</span>
                    <span className="block truncate text-xs text-subtle">
                      {folderName(s.cwd)} · {s.accountName ? `${s.accountName} · ` : ''}
                      {t(`state.${s.state}`)}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <SectionTitle
          action={<IconButton size="sm" className="size-6" label={t('toolbar.newSession')} icon={<Plus className="size-3.5" />} onClick={() => props.onNewSessionIn(null)} />}
        >
          {t('sidebar.folders')}
        </SectionTitle>
        {props.folders.length === 0 ? (
          <p className="px-2.5 py-1 text-xs text-subtle">{t('sidebar.foldersEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {props.folders.map((f) => (
              <li key={f}>
                <button
                  type="button"
                  title={f}
                  onClick={() => props.onNewSessionIn(f)}
                  aria-label={t('sidebar.newSessionIn', { folder: folderName(f) })}
                  className="flex h-7 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-base text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text"
                >
                  <Folder className="size-3.5 shrink-0 text-subtle" aria-hidden />
                  <span className="truncate">{folderName(f)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="shrink-0 px-3 pb-3">
        <UsageCard groups={props.usage} running={running} />
      </div>
    </aside>
  )
}
