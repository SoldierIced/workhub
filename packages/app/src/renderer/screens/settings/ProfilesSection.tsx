import { ChevronRight, Copy, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { profileColor, type Profile, type WorkhubConfig } from '@workhub/core'
import { Badge, Button, IconButton } from '../../components/atoms'
import { Card } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { profileSymbol } from '../../lib/profileSymbols'
import { ProfileAgentsTab } from './ProfileAgentsTab'
import { ProfileScreensTab } from './ProfileScreensTab'
import { profileSummary } from './profileSummary'
import { ProfileEditor } from './ProfileSections'
import { PROFILE_TABS, type ProfileScreen, type ProfileTab } from './sections'
import type { SectionProps } from './shared'

/** The profile Settings has open: `id` null is a new one (a copy of `copyOf` when set). */
export interface OpenProfile {
  id: string | null
  tab: ProfileTab
  copyOf?: string
}

export interface ProfilesSectionProps extends SectionProps {
  /** The open profile; null shows the list. */
  open: OpenProfile | null
  /** Opens a profile (or a new one), or goes back to the list; the caller asks about unsaved drafts first, unless `direct` (just saved or deleted). */
  onOpen: (next: OpenProfile | null, direct?: boolean) => void
  /** Another tab of the open profile: the tabs keep their drafts, so nothing is asked. */
  onTab: (tab: ProfileTab) => void
  /** A screen of the Screens tab to open and point at. */
  openScreen?: { key: ProfileScreen; at: number } | null
  focusHealthSecret?: boolean
  trackerId?: string
}

/** The profile's colour with its symbol (or its first letter). */
function ProfileMark({ config, profile }: { config: WorkhubConfig; profile: Profile }) {
  const Icon = profileSymbol(profile.symbol)
  const color = profileColor(config.profiles, profile.id)
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white" style={{ background: color ?? 'var(--wh-accent)' }} aria-hidden>
      {Icon ? <Icon className="size-4" /> : (profile.name || profile.id).slice(0, 1).toUpperCase()}
    </span>
  )
}

/**
 * Settings → Profiles: the list of profiles (open one, add one, duplicate one) or, with one open,
 * that profile with its four tabs. Every write of an open profile goes to that profile, never to
 * the active one.
 */
export function ProfilesSection(props: ProfilesSectionProps) {
  if (!props.open) return <ProfileList {...props} />
  return <ProfileDetail key={props.open.id ?? `new:${props.open.copyOf ?? ''}`} {...props} open={props.open} />
}

function ProfileList({ snap, onOpen }: ProfilesSectionProps) {
  const { t } = useI18n()
  const editable = !snap.loadError
  return (
    <div className="flex flex-col gap-3" data-testid="profiles-list">
      {snap.config.profiles.length === 0 && <p className="px-1 text-sm text-subtle">{t('settingsV2.profiles.empty')}</p>}
      {snap.config.profiles.map((p) => (
        <Card key={p.id} className="flex items-center gap-3 px-4 py-3" data-settings-row data-testid="profiles-row" data-profile={p.id}>
          <ProfileMark config={snap.config} profile={p} />
          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-base font-medium text-text">
              {p.name || p.id}
              {p.id === snap.config.activeProfileId && <Badge tone="accent">{t('settings.active')}</Badge>}
            </span>
            <p className="truncate text-xs text-subtle">{profileSummary(snap.config, p, t)}</p>
          </div>
          <IconButton
            size="sm"
            label={t('settingsV2.profiles.duplicateNamed', { name: p.name || p.id })}
            icon={<Copy className="size-3.5" aria-hidden />}
            disabled={!editable}
            onClick={() => onOpen({ id: null, tab: 'folders', copyOf: p.id })}
          />
          <Button size="sm" onClick={() => onOpen({ id: p.id, tab: 'folders' })} data-testid="profiles-open">
            {t('settingsV2.profiles.open')}
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
        </Card>
      ))}
      <div className="flex flex-wrap items-center gap-3 px-1">
        <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} disabled={!editable} onClick={() => onOpen({ id: null, tab: 'folders' })} data-testid="profiles-new">
          {t('settingsV2.profiles.new')}
        </Button>
        {snap.config.profiles.length > 0 && <span className="text-xs text-subtle">{t('settingsV2.profiles.duplicateHint')}</span>}
      </div>
    </div>
  )
}

function ProfileDetail({ snap, run, open, onOpen, onTab, openScreen, focusHealthSecret, trackerId }: ProfilesSectionProps & { open: OpenProfile }) {
  const { t } = useI18n()
  const profileId = open.id
  // Screens and Agents hold forms of their own: kept mounted once seen, so a tab change keeps their drafts.
  const [seen, setSeen] = useState<ReadonlySet<ProfileTab>>(() => new Set([open.tab]))
  useEffect(() => setSeen((s) => (s.has(open.tab) ? s : new Set([...s, open.tab]))), [open.tab])
  const tabBar = (
    <div role="tablist" aria-label={t('settingsV2.profiles.tabsLabel')} className="flex gap-1 border-b border-border" data-testid="profile-tabs">
      {PROFILE_TABS.map((tab) => {
        const current = tab.id === open.tab
        // A new profile has only its own form until it is saved.
        const disabled = profileId === null && (tab.id === 'screens' || tab.id === 'agents')
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={current}
            disabled={disabled}
            onClick={() => onTab(tab.id)}
            data-testid={`profile-tab-${tab.id}-button`}
            className={cn(
              'relative h-9 border-b-2 px-3 text-base transition-colors disabled:opacity-50',
              current ? 'border-accent font-medium text-text' : 'border-transparent text-muted hover:text-text'
            )}
          >
            {t(tab.label)}
          </button>
        )
      })}
    </div>
  )
  return (
    <ProfileEditor
      snap={snap}
      run={run}
      profileId={profileId}
      copyOf={open.copyOf ?? null}
      tab={open.tab}
      tabBar={tabBar}
      onCreated={(id) => onOpen({ id, tab: open.tab }, true)}
      onDeleted={() => onOpen(null, true)}
    >
      {profileId && seen.has('screens') && (
        <div hidden={open.tab !== 'screens'} data-testid="profile-tab-screens">
          <ProfileScreensTab snap={snap} run={run} profileId={profileId} openScreen={openScreen} focusHealthSecret={focusHealthSecret} trackerId={trackerId} />
        </div>
      )}
      {profileId && seen.has('agents') && (
        <div hidden={open.tab !== 'agents'} data-testid="profile-tab-agents">
          <ProfileAgentsTab snap={snap} run={run} profileId={profileId} />
        </div>
      )}
    </ProfileEditor>
  )
}
