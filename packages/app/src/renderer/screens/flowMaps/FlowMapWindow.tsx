import { useEffect, useState } from 'react'
import type { FlowMapSummary, HealthEnvironmentView } from '@shared/health-api'
import { Spinner, TooltipProvider } from '../../components/atoms'
import { EmptyState, ToastProvider } from '../../components/molecules'
import { I18nProvider, useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { usePlatform } from '../../lib/platform'
import { FlowMapView } from './FlowMapView'

export interface FlowMapWindowTarget {
  profileId: string | null
  environmentId: string
  mapId: string
}

/** `#flow-map?profile=…&env=…&id=…` → the map a window shows; null for any other hash. */
export function parseFlowMapHash(hash: string): FlowMapWindowTarget | null {
  const m = /^#flow-map\?(.*)$/.exec(hash)
  if (!m) return null
  const q = new URLSearchParams(m[1])
  const environmentId = q.get('env')
  const mapId = q.get('id')
  if (!environmentId || !mapId) return null
  return { profileId: q.get('profile') || null, environmentId, mapId }
}

/** A flow map in a window of its own: the same view, with "Ask Claude" handed to the main window. */
export function FlowMapWindow(target: FlowMapWindowTarget) {
  const platform = usePlatform()
  return (
    <I18nProvider>
      <TooltipProvider>
        <Frame platform={platform} target={target} />
      </TooltipProvider>
    </I18nProvider>
  )
}

function Frame({ platform, target }: { platform: string; target: FlowMapWindowTarget }) {
  const { t } = useI18n()
  return (
    <ToastProvider label={t('common.notifications')}>
      <div className="flex h-full flex-col bg-bg">
        <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
        <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <Body target={target} />
        </main>
      </div>
    </ToastProvider>
  )
}

function Body({ target }: { target: FlowMapWindowTarget }) {
  const { t } = useI18n()
  const [env, setEnv] = useState<HealthEnvironmentView | null>(null)
  const [summary, setSummary] = useState<FlowMapSummary | null>(null)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let alive = true
    Promise.all([window.hub.health.get(target.profileId), window.hub.health.flowMaps(target.profileId)])
      .then(([view, maps]) => {
        if (!alive) return
        const found = view.environments.find((e) => e.id === target.environmentId)
        if (!found) return setError(t('flowMaps.status.needsHealth.hint'))
        setEnv(found)
        setSummary(maps.find((m) => m.id === target.mapId) ?? null)
      })
      .catch((e: unknown) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [target.profileId, target.environmentId, target.mapId, t])
  useEffect(() => {
    document.title = summary ? `${summary.name} · ${env?.name ?? ''}` : t('nav.flowMaps')
  }, [summary, env, t])
  if (error) return <EmptyState compact title={t('flowMaps.status.needsHealth.title')} description={error} />
  if (!env) return <p className="flex items-center gap-2 py-10 text-sm text-muted"><Spinner /> {t('flowMaps.loading')}</p>
  return <FlowMapView env={env} profileId={target.profileId} mapId={target.mapId} file={summary?.file} canOpenWindow={false} />
}
