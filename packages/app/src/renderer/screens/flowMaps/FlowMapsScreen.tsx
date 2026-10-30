import { Route, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { moduleScreens, type Profile } from '@workhub/core'
import type { FlowMapSummary, HealthEnvironmentView } from '@shared/health-api'
import { Badge, Button, Spinner, StateDot } from '../../components/atoms'
import { EmptyState } from '../../components/molecules'
import { useHealth } from '../../healthStore'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { HEALTH_LABEL, HEALTH_TONE } from '../../lib/health'
import { FlowMapView } from './FlowMapView'

export interface FlowMapsScreenProps {
  profile: Profile | undefined
  onOpenSettings: (tab?: string) => void
  /** Opens a new Claude session with the draft in its composer; it is never sent. */
  onInvestigate: (draft: string, folder: string | undefined) => Promise<void> | void
}

/** Flow maps (⌘7): the environments of the active profile, the maps of the data folder for the chosen one, and the opened map. */
export function FlowMapsScreen({ profile, onOpenSettings, onInvestigate }: FlowMapsScreenProps) {
  const { t, tn } = useI18n()
  const modules = profile ? moduleScreens(profile.modules) : []
  const enabled = modules.includes('flowMaps')
  const healthOn = modules.includes('health')
  const { view, loading, error, refresh } = useHealth(profile?.id, enabled && healthOn)
  const [selected, setSelected] = useState<string | null>(null)
  const environments = enabled && healthOn ? (view?.environments ?? []) : []
  const current = environments.find((e) => e.id === selected) ?? environments[0]
  useEffect(() => {
    if (selected && !environments.some((e) => e.id === selected)) setSelected(null)
  }, [selected, environments])

  const ready = view?.state === 'ready' || view?.state === 'demo'
  const status: 'moduleOff' | 'needsHealth' | null = !enabled ? 'moduleOff' : !healthOn || (view && !ready) ? 'needsHealth' : null

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-8 py-7">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{profile?.name ? `${profile.name} · ${t('nav.flowMaps')}` : t('nav.flowMaps')}</h1>
          <p className="mt-0.5 max-w-2xl text-base text-muted">{t('flowMaps.subtitle')}</p>
        </div>
        {view?.state === 'demo' && <Badge tone="info">{t('health.demo')}</Badge>}
      </header>

      {error && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
          <p className="min-w-0 flex-1 break-words text-sm text-danger">{t('health.loadFailed', { message: error })}</p>
          <Button size="sm" icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={() => void refresh()}>
            {t('health.retry')}
          </Button>
        </div>
      )}

      {enabled && healthOn && !view && !error && (
        <p className="flex items-center gap-2 py-10 text-sm text-muted" role="status">
          <Spinner /> {t('health.loading')}
        </p>
      )}

      {status && (
        <EmptyState
          icon={<Route className="size-6" aria-hidden />}
          title={t(`flowMaps.status.${status}.title`)}
          description={t(`flowMaps.status.${status}.hint`)}
          action={
            <Button variant="primary" onClick={() => onOpenSettings(status === 'moduleOff' ? 'flowMaps' : 'health')}>
              {t('flowMaps.openSettings')}
            </Button>
          }
        />
      )}

      {current && (
        <>
          <div role="tablist" aria-label={t('flowMaps.environments')} className="flex flex-wrap gap-1.5">
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
          <MapsForEnvironment key={current.id} env={current} profileId={profile?.id ?? null} onInvestigate={onInvestigate} onOpenSettings={onOpenSettings} tn={tn} />
        </>
      )}
    </div>
  )
}

/** The maps of the folder that name this environment (or none), and the one opened. */
function MapsForEnvironment({ env, profileId, onInvestigate, onOpenSettings, tn }: { env: HealthEnvironmentView; profileId: string | null; onInvestigate: FlowMapsScreenProps['onInvestigate']; onOpenSettings: (tab?: string) => void; tn: ReturnType<typeof useI18n>['tn'] }) {
  const { t } = useI18n()
  const [maps, setMaps] = useState<FlowMapSummary[] | null>(null)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<string | null>(null)
  const load = () =>
    window.hub.health
      .flowMaps(profileId)
      .then((m) => {
        setMaps(m)
        setError(undefined)
      })
      .catch((e: unknown) => setError(errorText(e)))
  useEffect(() => void load(), [profileId]) // eslint-disable-line react-hooks/exhaustive-deps
  const listed = (maps ?? []).filter((m) => !m.environmentId || m.environmentId === env.id)
  // One map opens by itself; otherwise the one picked (or the first valid one once the list is in).
  const opened = open ?? listed.find((m) => !m.error)?.id ?? null
  const current = listed.find((m) => m.id === opened)
  return (
    <div className="flex flex-col gap-3" data-testid="flow-maps">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t('flowMaps.maps')}</span>
        {maps && <span className="text-xs text-muted">{tn('flowMaps.count', listed.length)}</span>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onOpenSettings('flowMaps')}>{t('flowMaps.openSettings')}</Button>
        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => void load()}>{t('flowMaps.reload')}</Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {maps && listed.length === 0 && <p className="text-sm text-muted">{t('flowMaps.empty')}</p>}
      {listed.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {listed.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                disabled={Boolean(m.error)}
                title={m.error ? t('flowMaps.invalid', { error: m.error }) : m.description ?? m.file}
                onClick={() => setOpen(m.id)}
                className={cn('flex flex-col items-start rounded-md border px-3 py-1.5 text-left transition-colors', m.error ? 'border-danger/40 text-danger' : opened === m.id ? 'border-accent/60 bg-accent-soft' : 'border-border bg-surface hover:bg-surface-hover')}
              >
                <span className="text-sm font-medium">{m.name}</span>
                <span className="text-xs text-muted">{m.error ? t('flowMaps.invalidShort') : t('flowMaps.size', { nodes: m.nodes, edges: m.edges })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {current && !current.error && <FlowMapView key={`${env.id}:${current.id}`} env={env} profileId={profileId} mapId={current.id} file={current.file} onAsk={(draft, folder) => void onInvestigate(draft, folder)} />}
    </div>
  )
}
