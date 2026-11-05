import { Route, RotateCcw, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { flowAlertsOf, moduleScreens, type Profile } from '@workhub/core'
import type { FlowMapState, FlowMapSummary, HealthEnvironmentView } from '@shared/health-api'
import { Badge, Button, Spinner, StateDot } from '../../components/atoms'
import { EmptyState } from '../../components/molecules'
import { useHealth } from '../../healthStore'
import { useI18n } from '../../i18n/I18nProvider'
import { errorText } from '../../lib/errorText'
import { HEALTH_LABEL, HEALTH_TONE } from '../../lib/health'
import { FlowMapList, groupFlowMaps } from './FlowMapList'
import { FlowMapView } from './FlowMapView'
import { Segmented } from './Segmented'

export interface FlowMapsScreenProps {
  profile: Profile | undefined
  onOpenSettings: (tab?: string) => void
  /** Opens a new Claude session with the draft in its composer; it is never sent. */
  onInvestigate: (draft: string, folder: string | undefined) => Promise<void> | void
}

/**
 * Flow maps (⌘7): one header row (title, the environments of the active profile, Reload and
 * Settings), the maps of the data folder for the chosen environment in a side list, and the opened
 * map. Without Health the maps are still listed and drawn, without numbers.
 */
export function FlowMapsScreen({ profile, onOpenSettings, onInvestigate }: FlowMapsScreenProps) {
  const { t } = useI18n()
  const modules = profile ? moduleScreens(profile.modules) : []
  const enabled = modules.includes('flowMaps')
  const healthOn = modules.includes('health')
  const { view, loading, error, refresh } = useHealth(profile?.id, enabled && healthOn)
  const [selected, setSelected] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const environments = enabled && healthOn ? (view?.environments ?? []) : []
  const current = environments.find((e) => e.id === selected) ?? environments[0]
  useEffect(() => {
    if (selected && !environments.some((e) => e.id === selected)) setSelected(null)
  }, [selected, environments])

  const ready = view?.state === 'ready' || view?.state === 'demo'
  // Health off, or on but not usable yet: the maps are drawn without numbers.
  const healthOff = enabled && (!healthOn || (view !== undefined && view !== null && (!ready || environments.length === 0)))

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-6 py-5">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{t('nav.flowMaps')}</h1>
        {current && (
          <Segmented
            tabs
            label={t('flowMaps.environments')}
            value={current.id}
            onChange={setSelected}
            options={environments.map((e) => ({ value: e.id, label: e.name, icon: <StateDot tone={HEALTH_TONE[e.snapshot.state]} />, tooltip: t(HEALTH_LABEL[e.snapshot.state]) }))}
          />
        )}
        {healthOff && <Badge tone="warning">{t('flowMaps.healthOff.badge')}</Badge>}
        {view?.state === 'demo' && <Badge tone="info">{t('health.demo')}</Badge>}
        <span className="flex-1" />
        {enabled && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => setReloads((n) => n + 1)}>
              {t('flowMaps.reload')}
            </Button>
            <Button size="sm" variant="ghost" icon={<Settings className="size-3.5" aria-hidden />} onClick={() => onOpenSettings('flowMaps')}>
              {t('flowMaps.settingsButton')}
            </Button>
          </div>
        )}
      </header>

      {error && healthOn && (
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

      {!enabled && (
        <EmptyState
          icon={<Route className="size-6" aria-hidden />}
          title={t('flowMaps.status.moduleOff.title')}
          description={`${t('flowMaps.subtitle')} ${t('flowMaps.status.moduleOff.hint')}`}
          action={
            <Button variant="primary" onClick={() => onOpenSettings('flowMaps')}>
              {t('flowMaps.openSettings')}
            </Button>
          }
        />
      )}

      {(current || healthOff) && (
        <MapsForEnvironment key={current?.id ?? ''} env={current ?? null} reloads={reloads} profileId={profile?.id ?? null} onInvestigate={onInvestigate} onOpenSettings={onOpenSettings} />
      )}
    </div>
  )
}

/** The maps of the folder that name this environment (or none; all of them without Health): the side list, and the one opened next to it. */
function MapsForEnvironment({ env, reloads, profileId, onInvestigate, onOpenSettings }: { env: HealthEnvironmentView | null; reloads: number; profileId: string | null; onInvestigate: FlowMapsScreenProps['onInvestigate']; onOpenSettings: (tab?: string) => void }) {
  const { t } = useI18n()
  const [maps, setMaps] = useState<FlowMapSummary[] | null>(null)
  const [states, setStates] = useState<Record<string, FlowMapState>>({})
  const [alerts, setAlerts] = useState<Record<string, number>>({})
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let alive = true
    window.hub.health
      .flowMaps(profileId)
      .then((m) => {
        if (!alive) return
        setMaps(m)
        setError(undefined)
      })
      .catch((e: unknown) => alive && setError(errorText(e)))
    if (!env) return () => void (alive = false)
    // The dots and counts come from the stored history only: listing the maps never reads the cluster.
    window.hub.health
      .flowMapStates(profileId, env.id)
      .then(async (s) => {
        if (!alive) return
        setStates(s)
        const counts: Record<string, number> = {}
        await Promise.all(
          Object.entries(s)
            .filter(([, state]) => state === 'alert')
            .map(async ([id]) => {
              const r = await window.hub.health.flowMap(profileId, env.id, id, 1, false, true).catch(() => null)
              if (r?.ok && r.reading) counts[id] = new Set(flowAlertsOf(r.map, r.reading, env).map((a) => `${a.part.of}:${a.part.key}`)).size
            })
        )
        if (alive) setAlerts(counts)
      })
      .catch(() => alive && setStates({}))
    return () => void (alive = false)
  }, [profileId, env?.id, reloads]) // eslint-disable-line react-hooks/exhaustive-deps
  const listed = (maps ?? []).filter((m) => !env || !m.environmentId || m.environmentId === env.id)
  // One map opens by itself; otherwise the one picked (or the first valid one of the list once it is in).
  const first = groupFlowMaps(listed).flatMap((g) => g.maps).find((m) => !m.error)
  const opened = open ?? first?.id ?? null
  const current = listed.find((m) => m.id === opened)
  return (
    <div className="flex flex-col gap-3" data-testid="flow-maps">
      {error && <p className="text-sm text-danger">{error}</p>}
      {maps && listed.length === 0 && (
        <EmptyState
          compact
          icon={<Route className="size-5" aria-hidden />}
          title={t('flowMaps.noMaps')}
          description={`${t('flowMaps.subtitle')} ${t('flowMaps.empty')}`}
          action={<Button onClick={() => onOpenSettings('flowMaps')}>{t('flowMaps.openSettings')}</Button>}
        />
      )}
      {listed.length > 0 && (
        <div className="flex items-start gap-4">
          <FlowMapList maps={listed} states={states} alerts={alerts} opened={opened} query={query} onQuery={setQuery} onOpen={setOpen} />
          <div className="min-w-0 flex-1">
            {current && !current.error && (
              <FlowMapView key={`${env?.id ?? ''}:${current.id}:${reloads}`} env={env} profileId={profileId} mapId={current.id} file={current.file} onOpenSettings={onOpenSettings} onAsk={(draft, folder) => void onInvestigate(draft, folder)} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
