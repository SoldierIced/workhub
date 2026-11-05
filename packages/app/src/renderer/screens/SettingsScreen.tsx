import { TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { OfferedModule, ValidationIssue } from '@workhub/core'
import type { ConfigSnapshot, Platform } from '@shared/api'
import { Button } from '../components/atoms'
import { useToast } from '../components/molecules'
import { Workhub1SecretsImport } from '../components/organisms'
import { SaveBar, SAVE_SHORTCUT, StoreUnsavedPrompt, UnsavedChangesProvider } from '../components/organisms/UnsavedChanges'
import { refreshConfig } from '../configStore'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { cn } from '../lib/cn'
import { friendlyIssue, humanIssue, type IssueTarget } from '../lib/configIssues'
import { matchesShortcut } from '../lib/shortcuts'
import type { UnsavedChanges } from '../lib/unsavedChanges'
import { showWorkhub1Migration, showWorkhub1Tokens, useWorkhub1Preview } from '../lib/workhub1'
import { AiReviewSection } from './AiReviewSettings'
import { AlertsSettings } from './AlertsSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { FlowMapsSettings } from './FlowMapsSettings'
import { HealthSettings } from './HealthSettings'
import { PlanSettings } from './PlanSettings'
import { SetupEntryGroup } from './SetupEntryGroup'
import { SlackSettings } from './SlackSettings'
import { TrackerSettings } from './TrackerSettings'
import { UsageSettings } from './UsageSettings'
import { AccountsSection } from './settings/AccountsSection'
import { ConnectionsSection } from './settings/ConnectionsSection'
import { focusSettingRow } from './settings/focusRow'
import { ModulesSection, ProfileSection } from './settings/ProfileSections'
import type { Run } from './settings/run'
import { issueSection, sectionMeta, type SettingsNavGroup, type SettingsSectionId } from './settings/sections'
import { SETTINGS_INDEX, searchSettings, type SettingsHit } from './settings/settings-index'
import { SettingsNav } from './settings/SettingsNav'
import { Issues, ModuleOffNote, NoProfileYet } from './settings/shared'
import { GeneralSection, ImportSection, NotificationsSection, StorageSection } from './settings/WorkhubSections'

/** The one-line description under each section's title. */
const INTRO: Partial<Record<SettingsSectionId, MessageKey>> = {
  general: 'settings.intro.general',
  appearance: 'help.tab.appearance',
  notifications: 'settings.intro.notifications',
  alerts: 'settings.intro.alerts',
  agents: 'settings.intro.agents',
  usage: 'settings.intro.usage',
  connections: 'settings.intro.connections',
  profile: 'settings.intro.profile',
  modules: 'settings.intro.modules',
  tickets: 'settings.intro.tickets',
  slack: 'settings.slackAppWide',
  aiReview: 'settings.intro.aiReview',
  storage: 'settings.intro.storage',
  import: 'settings.intro.import'
}

/** Per-profile sections of a module: they say so when the module is off for the profile. */
const SECTION_MODULE: Partial<Record<SettingsSectionId, OfferedModule>> = { slack: 'chatWatcher' }

/** A row to bring into view once its section is on screen (a search result, a "Fix" button). */
interface PendingFocus {
  label: string
  nonce: number
}

export interface SettingsScreenProps {
  snap: ConfigSnapshot | null
  section: SettingsSectionId
  onSectionChange: (section: SettingsSectionId) => void
  /** Closes Settings (the header's close button, Esc); the caller asks `unsaved` first. */
  onClose: () => void
  /** The drafts of every form here; asked before the section changes or the window closes. */
  unsaved: UnsavedChanges
  /** Settings fills a window of its own on this platform: the header is its title bar (drag area, room for the window controls). */
  windowChrome?: Platform
}

/** Settings as a screen: a header with a close button, the grouped navigation with search on the left, the section on the right. */
export function SettingsScreen(props: SettingsScreenProps) {
  return (
    <UnsavedChangesProvider store={props.unsaved}>
      <SettingsBody {...props} />
    </UnsavedChangesProvider>
  )
}

function SettingsBody({ snap, section, onSectionChange, onClose, unsaved, windowChrome }: SettingsScreenProps) {
  const { t } = useI18n()
  const notify = useToast()
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  // The item a "fix" button asked to open; the section's form starts on it.
  const [focus, setFocus] = useState<IssueTarget | null>(null)
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null)
  const [query, setQuery] = useState('')
  const [activeHit, setActiveHit] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  // Workhub 1 on this Mac (read again after every config change): drives the migration UI's visibility.
  const workhub1 = useWorkhub1Preview(snap?.config)

  // The profile the profile group edits: the active one at first, any other one from the picker.
  const activeProfileId = snap?.config.activeProfileId ?? null
  const profiles = snap?.config.profiles ?? []
  const [profileId, setProfileId] = useState<string | null>(() => activeProfileId ?? profiles[0]?.id ?? null)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    // A deleted (or never set) profile falls back to the active one.
    if (!creating && !profiles.some((p) => p.id === profileId)) setProfileId(activeProfileId ?? profiles[0]?.id ?? null)
  }, [profiles, profileId, activeProfileId, creating])
  const editedProfile = profiles.find((p) => p.id === profileId)
  const editingId = creating ? null : (editedProfile?.id ?? null)

  const run: Run = async (op) => {
    const r = await op()
    if (!r.ok) {
      setIssues(r.issues)
      const first = r.issues[0]
      unsaved.reportProblem(first ? friendlyIssue(first, (k, p) => t(k, p)) : null)
      return false
    }
    setIssues([])
    unsaved.reportProblem(null)
    // A save from the save bar says "Saved" there; a switch that saves at once says it here.
    if (!unsaved.snapshot().saving) notify(t('settings.saved'))
    await refreshConfig()
    return true
  }

  const editable = snap ? !snap.loadError : false
  const importVisible = editable && showWorkhub1Migration(window.hub.platform, workhub1)
  const visible = (id: SettingsSectionId) => id !== 'import' || importVisible
  const groupLabel = (group: SettingsNavGroup) =>
    group === 'profile' ? t('settings.navGroup.profile', { name: editedProfile ? editedProfile.name || editedProfile.id : t('settings.newProfile') }) : t(group === 'workhub' ? 'settings.navGroup.workhub' : 'settings.navGroup.advanced')
  const hits = useMemo(() => searchSettings(SETTINGS_INDEX, query, { t, groupLabel, visible }), [query, t, editedProfile, importVisible]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setActiveHit(0), [query])

  // Sections with a stored-config problem get a dot in the navigation.
  const withIssues = useMemo(() => {
    const out = new Set<SettingsSectionId>()
    for (const i of snap?.issues ?? []) {
      const target = snap ? humanIssue(i, snap.config, snap.providers, (k) => t(k)).action?.target : undefined
      if (target) out.add(issueSection(target))
    }
    return out
  }, [snap, t])

  // Once the asked-for section is on screen, bring the row into view (sections that load their data render late).
  useEffect(() => {
    if (!pendingFocus) return
    let tries = 0
    let timer = 0
    const attempt = () => {
      if (focusSettingRow(content.current, pendingFocus.label) || ++tries > 10) return setPendingFocus(null)
      timer = window.setTimeout(attempt, 100)
    }
    timer = window.setTimeout(attempt, 50)
    return () => window.clearTimeout(timer)
  }, [pendingFocus, section])

  const go = (next: SettingsSectionId, opts: { focus?: IssueTarget | null; label?: string } = {}) =>
    unsaved.requestLeave(() => {
      setIssues([])
      setFocus(opts.focus ?? null)
      setQuery('')
      onSectionChange(next)
      if (opts.label) setPendingFocus({ label: opts.label, nonce: Date.now() })
      content.current?.scrollTo({ top: 0 })
    })
  const fix = (target: IssueTarget) => {
    // A profile's problem opens that profile in the profile group.
    if ((target.tab === 'profiles' || target.tab === 'modules') && target.id) {
      unsaved.requestLeave(() => {
        setCreating(false)
        setProfileId(target.id!)
        go(issueSection(target), { focus: target })
      })
      return
    }
    go(issueSection(target), { focus: target })
  }
  const openHit = (hit: SettingsHit) => go(hit.entry.section, { label: hit.label })
  const pickProfile = (id: string | null) =>
    unsaved.requestLeave(() => {
      setIssues([])
      if (id === null) {
        setCreating(true)
        onSectionChange('profile')
      } else {
        setCreating(false)
        setProfileId(id)
      }
    })

  // ⌘F searches, Esc clears the search and then closes Settings; ⌘S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, { key: 'f' }, window.hub.platform)) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (matchesShortcut(e, SAVE_SHORTCUT, window.hub.platform)) {
        e.preventDefault()
        if (unsaved.snapshot().dirty) void unsaved.saveAll()
        return
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // A menu, list or dialog open over Settings closes first.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]')) return
      e.preventDefault()
      if (query) setQuery('')
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query, onClose, unsaved])

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveHit((i) => (hits.length ? (i + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[activeHit]
      if (hit) openHit(hit)
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    }
  }

  if (!snap) return null
  const meta = sectionMeta(section)
  const inProfileGroup = meta.group === 'profile'
  const focusId = (...tabs: IssueTarget['tab'][]) => (focus && tabs.includes(focus.tab) ? focus.id : undefined)
  const openModules = () => go('modules')
  const sectionKey = `${section}:${inProfileGroup ? (editingId ?? 'new') : ''}:${focus?.id ?? ''}`
  const moduleOff = SECTION_MODULE[section]

  const body = (): ReactNode => {
    if (inProfileGroup && section !== 'profile' && !editedProfile) return <NoProfileYet />
    switch (section) {
      case 'general':
        return (
          <div className="flex flex-col gap-6">
            <GeneralSection snap={snap} run={run} />
            <SetupEntryGroup />
          </div>
        )
      case 'appearance':
        return <AppearanceSettings />
      case 'notifications':
        return <NotificationsSection snap={snap} run={run} />
      case 'alerts':
        return <AlertsSettings snap={snap} run={run} />
      case 'agents':
        return <AccountsSection snap={snap} run={run} initialId={focusId('accounts')} profileId={editingId} />
      case 'usage':
        return <UsageSettings snap={snap} run={run} />
      case 'connections':
        return <ConnectionsSection snap={snap} run={run} initialId={focusId('connections')} />
      case 'profile':
        return (
          <ProfileSection
            snap={snap}
            run={run}
            profileId={editingId}
            onCreated={(id) => {
              setCreating(false)
              setProfileId(id)
            }}
            onDeleted={() => {
              setCreating(false)
              setProfileId(activeProfileId)
            }}
          />
        )
      case 'modules':
        return <ModulesSection snap={snap} run={run} profileId={editingId} onOpen={(s) => go(s)} />
      case 'tickets':
        return <TrackerSettings snap={snap} run={run} initialId={focusId('trackers')} profileId={editingId} />
      case 'health':
        return <HealthSettings snap={snap} run={run} focusSecret={focus?.tab === 'health'} profileId={editingId} onOpenModules={openModules} />
      case 'flowMaps':
        return <FlowMapsSettings snap={snap} run={run} profileId={editingId} onOpenModules={openModules} />
      case 'plan':
        return <PlanSettings snap={snap} run={run} profileId={editingId} onOpenModules={openModules} />
      case 'slack':
        return (
          <div className="flex flex-col gap-4">
            {moduleOff && editedProfile && !editedProfile.modules[moduleOff] && <ModuleOffNote module={moduleOff} onOpenModules={openModules} />}
            <SlackSettings snap={snap} run={run} />
          </div>
        )
      case 'aiReview':
        return <AiReviewSection snap={snap} run={run} profileId={editingId} />
      case 'storage':
        return <StorageSection snap={snap} />
      case 'import':
        return importVisible ? <ImportSection run={run} workhub1={workhub1} /> : null
    }
  }

  return (
    <div ref={root} className="flex h-full flex-col" data-testid="settings-screen">
      <header className={cn('flex shrink-0 items-center gap-3 border-b border-border px-6 py-3', windowChrome && 'drag-region', windowChrome === 'mac' && 'pl-20', windowChrome && windowChrome !== 'mac' && 'pr-36')}>
        <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">{t('nav.settings')}</h1>
        <button type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')} data-testid="settings-close" className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-text">
          <X className="size-5" aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <SettingsNav
          section={section}
          onSection={(s) => go(s)}
          visible={visible}
          withIssues={withIssues}
          profiles={profiles}
          activeProfileId={activeProfileId}
          profileId={editingId}
          onProfile={pickProfile}
          query={query}
          onQuery={setQuery}
          onSearchKey={onSearchKey}
          searchRef={searchRef}
          groupLabel={groupLabel}
        />
        <div ref={content} className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-8 py-6">
            {snap.loadError && <Issues title={t('settings.loadError')} issues={[{ path: 'config.json', message: snap.loadError }]} />}
            <StoredIssues snap={snap} onFix={fix} />
            {showWorkhub1Tokens(window.hub.platform, workhub1) && (
              <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-sm">
                <Workhub1SecretsImport compact />
              </div>
            )}
            {query && <SearchResults hits={hits} query={query} active={activeHit} onOpen={openHit} />}
            {/* Hidden, not unmounted, while searching: a draft in the section survives a search. */}
            <section className={query ? 'hidden' : 'flex flex-col gap-4'} aria-labelledby="settings-section-title">
              <div className="flex flex-col gap-1">
                <h2 id="settings-section-title" className="text-xl font-semibold tracking-tight">
                  {inProfileGroup ? `${t(meta.label)} · ${editedProfile ? editedProfile.name || editedProfile.id : t('settings.newProfile')}` : t(meta.label)}
                </h2>
                {INTRO[section] && <p className="max-w-3xl text-base text-muted">{t(INTRO[section]!)}</p>}
                {inProfileGroup && editedProfile && activeProfileId && editedProfile.id !== activeProfileId && (
                  <p className="text-sm text-subtle" data-testid="settings-editing-other">
                    {t('settings.profileEditing', { name: editedProfile.name || editedProfile.id, active: profiles.find((p) => p.id === activeProfileId)?.name ?? activeProfileId })}
                  </p>
                )}
              </div>
              <Issues issues={issues} />
              <div key={sectionKey}>{body()}</div>
            </section>
          </div>
        </div>
      </div>
      <SaveBar store={unsaved} />
      <StoreUnsavedPrompt store={unsaved} restoreFocus={() => root.current?.focus()} />
    </div>
  )
}

/** The search's matches: breadcrumb, label and hint; a click (or Enter) opens the row. */
function SearchResults({ hits, query, active, onOpen }: { hits: SettingsHit[]; query: string; active: number; onOpen: (hit: SettingsHit) => void }) {
  const { t } = useI18n()
  if (!hits.length) return <p className="py-6 text-center text-base text-muted" data-testid="settings-search-empty">{t('settings.search.empty', { query })}</p>
  return (
    <section aria-label={t('settings.search.results')} className="flex flex-col gap-1" data-testid="settings-search-results">
      <h2 className="px-1 text-md font-semibold">{t('settings.search.results')}</h2>
      <ul className="flex flex-col gap-1">
        {hits.map((hit, i) => (
          <li key={`${hit.entry.section}:${hit.entry.label}`}>
            <button
              type="button"
              onClick={() => onOpen(hit)}
              aria-current={i === active ? 'true' : undefined}
              className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left ${i === active ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-surface-hover'}`}
            >
              <span className="text-xs text-subtle">{hit.breadcrumb.join(' › ')}</span>
              <span className="text-base text-text">{hit.label}</span>
              {hit.hint && <span className="line-clamp-2 text-xs text-muted">{hit.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The stored config's problems in plain words, each with a button to the section that fixes it. */
function StoredIssues({ snap, onFix }: { snap: ConfigSnapshot; onFix: (target: IssueTarget) => void }) {
  const { t } = useI18n()
  if (!snap.issues.length) return null
  const items = snap.issues.map((i) => humanIssue(i, snap.config, snap.providers, (k) => t(k)))
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3" data-testid="stored-issues">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-text">{t('issues.title')}</p>
        <ul className="mt-1 flex flex-col gap-1.5">
          {items.map((i) => (
            <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-text" title={i.technical}>
              <span className="min-w-0">{t(i.message, i.params)}</span>
              {i.action && (
                <Button size="sm" onClick={() => onFix(i.action!.target)}>
                  {t(i.action.label)}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
