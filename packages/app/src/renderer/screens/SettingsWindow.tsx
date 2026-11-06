import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { TooltipProvider } from '../components/atoms'
import { ToastProvider } from '../components/molecules'
import { refreshConfig, useConfig } from '../configStore'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { usePlatform } from '../lib/platform'
import { createUnsavedChanges, type UnsavedChanges } from '../lib/unsavedChanges'
import { SettingsScreen, type SettingsProfileRequest, type SettingsSpotlight } from './SettingsScreen'
import { settingsTarget, type SettingsSectionId, type SettingsTarget } from './settings/sections'

/**
 * `#settings` or `#settings?section=<id>` (`<id>#<anchor>` also points at a group,
 * `profiles/<profileId>/<tab>` opens a profile) -> the place to open (old tab ids map to theirs),
 * or null for any other hash.
 */
export function parseSettingsHash(hash: string): SettingsTarget | null {
  if (hash !== '#settings' && !hash.startsWith('#settings?')) return null
  const params = new URLSearchParams(hash.slice('#settings'.length + 1))
  return settingsTarget(params.get('section'))
}

/**
 * Reports to main whether the drafts are unsaved (only when that changes), so the window's own
 * close button asks about them first. Returns the unsubscribe function.
 */
export function reportDirty(unsaved: Pick<UnsavedChanges, 'subscribe' | 'snapshot'>, report: (dirty: boolean) => void): () => void {
  let last = false
  return unsaved.subscribe(() => {
    const dirty = unsaved.snapshot().dirty
    if (dirty === last) return
    last = dirty
    report(dirty)
  })
}

/** The root of the Settings window: the same providers as the main window, Settings full-window. */
export function SettingsWindowRoot({ section, group, profile }: SettingsTarget) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <Toasts>
          <SettingsWindow initial={section} initialGroup={group} initialProfile={profile} />
        </Toasts>
      </TooltipProvider>
    </I18nProvider>
  )
}

function Toasts({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return <ToastProvider label={t('common.notifications')}>{children}</ToastProvider>
}

function SettingsWindow({ initial, initialGroup, initialProfile }: { initial: SettingsSectionId; initialGroup?: string; initialProfile?: SettingsTarget['profile'] }) {
  const { t } = useI18n()
  const platform = usePlatform()
  const snap = useConfig()
  const [section, setSection] = useState(initial)
  // The group a `section#anchor` target points at; a new `at` points again.
  const [spotlight, setSpotlight] = useState<SettingsSpotlight | null>(() => (initialGroup ? { group: initialGroup, at: Date.now() } : null))
  // The profile (and tab) a target opens; a new `at` opens it again.
  const [profileRequest, setProfileRequest] = useState<SettingsProfileRequest | null>(() => (initialProfile ? { ...initialProfile, at: Date.now() } : null))
  const [unsaved] = useState(createUnsavedChanges)
  const sectionNow = useRef(section)
  sectionNow.current = section

  // A change made here (or anywhere else) reaches every window through `config:changed`.
  useEffect(() => {
    void refreshConfig()
    return window.hub.config.onChanged(() => void refreshConfig())
  }, [])
  useEffect(() => {
    document.title = t('settings.windowTitle')
  }, [t])
  useEffect(() => reportDirty(unsaved, (dirty) => window.hub.settings.setDirty(dirty)), [unsaved])

  // ✕, Esc and the window's own close button: the drafts are saved or discarded first.
  const close = useCallback(() => unsaved.requestLeave(() => window.hub.settings.close()), [unsaved])
  useEffect(() => window.hub.settings.onCloseRequest(close), [close])
  // Opened again (⌘,, a "Fix" or "Open Settings" link elsewhere) on another section: the drafts of this one are asked about first.
  useEffect(
    () =>
      window.hub.settings.onNavigate((tab) => {
        const { section: next, group, profile } = settingsTarget(tab)
        const point = () => {
          if (profile) setProfileRequest({ ...profile, at: Date.now() })
          setSpotlight(group ? { group, at: Date.now() } : null)
        }
        if (next === sectionNow.current && !profile) return point()
        unsaved.requestLeave(() => {
          setSection(next)
          point()
        })
      }),
    [unsaved]
  )

  return (
    <div className="h-full bg-bg">
      <SettingsScreen snap={snap} section={section} onSectionChange={setSection} onClose={close} unsaved={unsaved} windowChrome={platform} spotlight={spotlight} profileRequest={profileRequest} />
    </div>
  )
}
