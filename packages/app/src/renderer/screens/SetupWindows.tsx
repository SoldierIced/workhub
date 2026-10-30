import { FolderPlus, Minus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { slugId, type Profile } from '@workhub/core'
import { Button, Input, TooltipProvider } from '../components/atoms'
import { Field, ToastProvider } from '../components/molecules'
import { refreshConfig, useConfig } from '../configStore'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { cn } from '../lib/cn'
import { usePlatform } from '../lib/platform'
import { useSetupCheck } from '../lib/setup'
import { SetupChecklist } from './SetupChecklist'

/** The routes of the setup windows (`#welcome`, `#setup`, `#howitworks`); null for any other hash. */
export function parseSetupHash(hash: string): 'welcome' | 'check' | 'help' | null {
  const name = hash.replace(/^#\/?/, '').split('?')[0]
  return name === 'welcome' ? 'welcome' : name === 'setup' ? 'check' : name === 'howitworks' ? 'help' : null
}

function Frame({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  const { t } = useI18n()
  const platform = usePlatform()
  useEffect(() => {
    document.title = title
  }, [title])
  return (
    <ToastProvider label={t('common.notifications')}>
      <div className="flex h-full flex-col bg-bg">
        {/* Room for the macOS traffic lights; Windows and Linux draw their controls over the right end. */}
        <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
        <main className="min-h-0 flex-1 overflow-y-auto px-8 pb-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-6">{children}</div>
        </main>
        {footer && <footer className="flex shrink-0 items-center gap-2 border-t border-border px-8 py-3">{footer}</footer>}
      </div>
    </ToastProvider>
  )
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      {subtitle && <p className="text-base text-muted">{subtitle}</p>}
    </header>
  )
}

// --- Setup check ------------------------------------------------------------------------------

function SetupCheckPage() {
  const { t } = useI18n()
  const state = useSetupCheck()
  return (
    <Frame title={t('setup.title')}>
      <Header title={t('setup.title')} subtitle={t('setup.intro')} />
      <SetupChecklist state={state} />
    </Frame>
  )
}

// --- How Workhub works ----------------------------------------------------------------------

const HELP_SECTIONS = ['profiles', 'sessions', 'accounts', 'review', 'notifications', 'data'] as const

function HowItWorksPage() {
  const { t } = useI18n()
  return (
    <Frame title={t('howitworks.title')}>
      <Header title={t('howitworks.title')} subtitle={t('howitworks.intro')} />
      {HELP_SECTIONS.map((s) => (
        <section key={s} className="flex flex-col gap-1">
          <h2 className="text-md font-semibold">{t(`howitworks.${s}.title` as MessageKey)}</h2>
          <p className="text-base text-muted">{t(`howitworks.${s}.body` as MessageKey)}</p>
        </section>
      ))}
      <div>
        <Button onClick={() => window.hub.setup.openWindow('check')}>{t('howitworks.checkLink')}</Button>
      </div>
    </Frame>
  )
}

// --- Welcome ---------------------------------------------------------------------------------

const STEPS = ['profile', 'integrations', 'start'] as const
type Step = (typeof STEPS)[number]

const INTEGRATIONS = [
  ['accounts', 'accounts'],
  ['trackers', 'trackers'],
  ['connections', 'connections'],
  ['health', 'health'],
  ['usage', 'usage']
] as const

function ProfileStep({ name, folders, onName, onFolders }: { name: string; folders: string[]; onName: (v: string) => void; onFolders: (v: string[]) => void }) {
  const { t } = useI18n()
  const snap = useConfig()
  const existing = snap?.config.profiles ?? []
  if (existing.length > 0) {
    return (
      <>
        <Header title={t('welcome.profile.existingTitle')} subtitle={t('welcome.profile.existingSubtitle')} />
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
          {existing.map((p) => (
            <li key={p.id} className="px-4 py-3">
              <p className="text-base font-medium">{p.name}</p>
              <p className="truncate text-sm text-muted">{(p.folders ?? []).join(', ')}</p>
            </li>
          ))}
        </ul>
        <Button onClick={() => window.hub.setup.openSettings('profiles')}>{t('setup.openSettings', { tab: t('setup.tab.profiles') })}</Button>
      </>
    )
  }
  const add = async () => {
    const folder = await window.hub.pickFolder()
    if (folder && !folders.includes(folder)) onFolders([...folders, folder])
  }
  return (
    <>
      <Header title={t('welcome.profile.title')} subtitle={t('welcome.profile.subtitle')} />
      <Field label={t('welcome.profile.name')}>
        <Input value={name} onChange={(e) => onName(e.target.value)} placeholder={t('welcome.profile.namePlaceholder')} className="max-w-xs" />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-muted">{t('welcome.profile.folders')}</span>
        <p className="text-xs text-subtle">{t('welcome.profile.foldersHint')}</p>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
          {folders.length === 0 && <li className="px-4 py-3 text-sm text-muted">{t('welcome.profile.none')}</li>}
          {folders.map((f) => (
            <li key={f} className="flex items-center gap-2 px-4 py-2">
              <span className="min-w-0 flex-1 truncate text-base" title={f}>
                {f}
              </span>
              <Button size="sm" variant="ghost" aria-label={t('welcome.profile.remove', { folder: f })} icon={<Minus className="size-3.5" aria-hidden />} onClick={() => onFolders(folders.filter((x) => x !== f))} />
            </li>
          ))}
        </ul>
        <div>
          <Button icon={<FolderPlus className="size-3.5" aria-hidden />} onClick={() => void add()}>
            {t('welcome.profile.add')}
          </Button>
        </div>
      </div>
      <p className="text-xs text-subtle">{t('welcome.profile.later')}</p>
    </>
  )
}

function IntegrationsStep() {
  const { t } = useI18n()
  return (
    <>
      <Header title={t('welcome.integrations.title')} subtitle={t('welcome.integrations.subtitle')} />
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
        {INTEGRATIONS.map(([key, tab]) => (
          <li key={key} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium">{t(`welcome.integrations.${key}` as MessageKey)}</p>
              <p className="text-sm text-muted">{t(`welcome.integrations.${key}Hint` as MessageKey)}</p>
            </div>
            <Button size="sm" onClick={() => window.hub.setup.openSettings(tab)}>
              {t('setup.openSettings', { tab: t(`setup.tab.${tab}` as MessageKey) })}
            </Button>
          </li>
        ))}
      </ul>
    </>
  )
}

function StartStep() {
  const { t } = useI18n()
  const state = useSetupCheck()
  return (
    <>
      <Header title={t('welcome.start.title')} subtitle={t('welcome.start.subtitle')} />
      <SetupChecklist state={state} actions={<Button size="sm" variant="ghost" onClick={() => window.hub.setup.openWindow('help')}>{t('welcome.start.help')}</Button>} />
    </>
  )
}

function WelcomePage() {
  const { t } = useI18n()
  const snap = useConfig()
  const [step, setStep] = useState<Step>('profile')
  const [name, setName] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void refreshConfig()
    return window.hub.config.onChanged(() => void refreshConfig())
  }, [])
  const index = STEPS.indexOf(step)
  const hasProfiles = (snap?.config.profiles.length ?? 0) > 0

  const next = async () => {
    setError(false)
    // The first profile is saved when leaving its step; with no name there is nothing to save.
    if (step === 'profile' && !hasProfiles && name.trim()) {
      setBusy(true)
      const existing = snap?.config.profiles.map((p) => p.id) ?? []
      let id = slugId(name, 'profile')
      for (let n = 2; existing.includes(id); n++) id = `${slugId(name, 'profile')}-${n}`
      const profile: Profile = {
        id,
        name: name.trim(),
        connections: {},
        accountIds: [],
        modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false },
        ...(folders.length ? { folders } : {})
      }
      const r = await window.hub.config.saveProfile(profile)
      setBusy(false)
      if (!r.ok) return setError(true)
      await refreshConfig()
    }
    setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!)
  }

  const finish = () => void window.hub.setup.completeWelcome()
  return (
    <Frame
      title={t('welcome.title')}
      footer={
        <>
          <span className="text-sm text-subtle">{t('welcome.step', { n: index + 1, total: STEPS.length })}</span>
          <span className="flex-1" />
          {step !== 'start' && (
            <Button variant="ghost" onClick={finish}>
              {t('welcome.skip')}
            </Button>
          )}
          {index > 0 && <Button onClick={() => setStep(STEPS[index - 1]!)}>{t('welcome.back')}</Button>}
          {step === 'start' ? (
            <Button variant="primary" onClick={finish}>
              {t('welcome.start')}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => void next()}>
              {t('welcome.next')}
            </Button>
          )}
        </>
      }
    >
      {step === 'profile' && <ProfileStep name={name} folders={folders} onName={setName} onFolders={setFolders} />}
      {step === 'profile' && error && (
        <p role="alert" className="text-sm text-danger">
          {t('welcome.profile.saveFailed')}
        </p>
      )}
      {step === 'integrations' && <IntegrationsStep />}
      {step === 'start' && <StartStep />}
    </Frame>
  )
}

/** The root of a setup window, chosen by the URL hash. */
export function SetupWindow({ page }: { page: 'welcome' | 'check' | 'help' }) {
  return (
    <I18nProvider>
      <TooltipProvider>{page === 'welcome' ? <WelcomePage /> : page === 'check' ? <SetupCheckPage /> : <HowItWorksPage />}</TooltipProvider>
    </I18nProvider>
  )
}
