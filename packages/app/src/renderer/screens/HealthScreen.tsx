import { Activity, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { moduleScreens, type Profile, type SlowTransaction } from '@workhub/core'
import type { HealthEnvironmentView, HealthState } from '@shared/health-api'
import { Badge, Button, Spinner, StateDot } from '../components/atoms'
import { EmptyState } from '../components/molecules'
import { useHealth } from '../healthStore'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { cn } from '../lib/cn'
import { HEALTH_LABEL, HEALTH_TONE } from '../lib/health'
import { relativeTime } from '../lib/pullRequests'
import { EnvironmentPanel } from './health/EnvironmentPanel'

const STATUS_COPY: Partial<Record<HealthState, { title: MessageKey; hint: MessageKey }>> = {
  moduleOff: { title: 'health.status.moduleOff.title', hint: 'health.status.moduleOff.hint' },
  noConnection: { title: 'health.status.noConnection.title', hint: 'health.status.noConnection.hint' },
  incomplete: { title: 'health.status.incomplete.title', hint: 'health.status.incomplete.hint' },
  noEnvironments: { title: 'health.status.noEnvironments.title', hint: 'health.status.noEnvironments.hint' },
  unsupported: { title: 'health.status.unsupported.title', hint: 'health.status.unsupported.hint' }
}

export interface HealthScreenProps {
  profile: Profile | undefined
  onOpenSettings: (tab?: string) => void
  /** Drafts the summary of a slow endpoint into a new session; it is never sent. */
  onInvestigate: (env: HealthEnvironmentView, tx: SlowTransaction) => void
}

/** Health (⌘8): the environments of the active profile, each with its verdict and the signals behind it. */
export function HealthScreen({ profile, onOpenSettings, onInvestigate }: HealthScreenProps) {
  const { t, locale } = useI18n()
  const enabled = Boolean(profile && moduleScreens(profile.modules).includes('health'))
  const { view, loading, error, refresh } = useHealth(profile?.id, enabled)
  const [selected, setSelected] = useState<string | null>(null)
  const environments = view?.environments ?? []
  const current = environments.find((e) => e.id === selected) ?? environments[0]
  useEffect(() => {
    if (selected && !environments.some((e) => e.id === selected)) setSelected(null)
  }, [selected, environments])

  const copy = view ? STATUS_COPY[view.state] : undefined
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-8 py-7">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{profile?.name ? `${profile.name} · ${t('nav.health')}` : t('nav.health')}</h1>
          <p className="mt-0.5 max-w-2xl text-base text-muted">{t('health.subtitle')}</p>
        </div>
        {view?.state === 'demo' && <Badge tone="info">{t('health.demo')}</Badge>}
        {view?.updatedAt !== undefined && <span className="mt-1.5 text-sm text-subtle">{t('health.updated', { time: relativeTime(view.updatedAt, Date.now(), locale) })}</span>}
        {environments.length > 0 && (
          <Button size="sm" icon={loading ? <Spinner /> : <RefreshCw className="size-3.5" aria-hidden />} disabled={loading} onClick={() => void refresh()}>
            {t('health.refresh')}
          </Button>
        )}
      </header>

      {error && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {!view && !error && (
        <p className="flex items-center gap-2 py-10 text-sm text-muted" role="status">
          <Spinner /> {t('health.loading')}
        </p>
      )}

      {copy && (
        <EmptyState
          icon={<Activity className="size-6" aria-hidden />}
          title={t(copy.title)}
          description={t(copy.hint)}
          action={
            <Button variant="primary" onClick={() => onOpenSettings('health')}>
              {t('health.openSettings')}
            </Button>
          }
        />
      )}

      {current && (
        <>
          <div role="tablist" aria-label={t('health.environments')} className="flex flex-wrap gap-1.5">
            {environments.map((e) => {
              const active = e.id === current.id
              return (
                <button
                  key={e.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelected(e.id)}
                  className={cn(
                    'inline-flex h-8 items-center gap-2 rounded-md border px-3 text-base transition-colors',
                    active ? 'border-accent/60 bg-accent-soft text-text' : 'border-border bg-surface text-muted hover:bg-surface-hover hover:text-text'
                  )}
                >
                  <StateDot tone={HEALTH_TONE[e.snapshot.state]} />
                  {e.name}
                  <span className="text-xs text-subtle">{t(HEALTH_LABEL[e.snapshot.state])}</span>
                </button>
              )
            })}
          </div>
          <EnvironmentPanel key={current.id} env={current} onInvestigate={onInvestigate} />
        </>
      )}
    </div>
  )
}
