import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { TooltipProvider } from '../components/atoms'
import { ToastProvider } from '../components/molecules'
import { refreshConfig, useConfig } from '../configStore'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { usePlatform } from '../lib/platform'
import { createUnsavedChanges, type UnsavedChanges } from '../lib/unsavedChanges'
import { SettingsScreen } from './SettingsScreen'
import { settingsSection, type SettingsSectionId } from './settings/sections'

/** `#settings` or `#settings?section=<id>` -> the section to open (old tab ids map to theirs), or null for any other hash. */
export function parseSettingsHash(hash: string): { section: SettingsSectionId } | null {
  if (hash !== '#settings' && !hash.startsWith('#settings?')) return null
  const params = new URLSearchParams(hash.slice('#settings'.length + 1))
  return { section: settingsSection(params.get('section')) }
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
export function SettingsWindowRoot({ section }: { section: SettingsSectionId }) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <Toasts>
          <SettingsWindow initial={section} />
        </Toasts>
      </TooltipProvider>
    </I18nProvider>
  )
}

function Toasts({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return <ToastProvider label={t('common.notifications')}>{children}</ToastProvider>
}

function SettingsWindow({ initial }: { initial: SettingsSectionId }) {
  const { t } = useI18n()
  const platform = usePlatform()
  const snap = useConfig()
  const [section, setSection] = useState(initial)
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
        const next = settingsSection(tab)
        if (next !== sectionNow.current) unsaved.requestLeave(() => setSection(next))
      }),
    [unsaved]
  )

  return (
    <div className="h-full bg-bg">
      <SettingsScreen snap={snap} section={section} onSectionChange={setSection} onClose={close} unsaved={unsaved} windowChrome={platform} />
    </div>
  )
}
