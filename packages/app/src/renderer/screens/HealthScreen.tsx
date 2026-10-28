import { Activity, ListChecks, RotateCcw, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { folderForEvent, folderForPod, folderName, matchFolder, moduleScreens, pruneSelection, selectableItems, toggleItem, workloadName, type HealthItemId, type Profile } from '@workhub/core'
import type { HealthEnvironmentView, HealthState } from '@shared/health-api'
import { Badge, Button, Spinner, StateDot } from '../components/atoms'
import { EmptyState, useToast, RefreshButton } from '../components/molecules'
import { useHealth } from '../healthStore'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { cn } from '../lib/cn'
import { HEALTH_LABEL, HEALTH_TONE } from '../lib/health'
import { errorText } from '../lib/errorText'
import { investigateRow, investigateTogether, type HealthRow, type Investigation } from '../lib/healthInvestigate'
import { relativeTime } from '../lib/pullRequests'
import { EnvironmentPanel } from './health/EnvironmentPanel'
import { HealthRowsProvider, type HealthRowActions } from './health/HealthRows'

const STATUS_COPY: Partial<Record<HealthState, { title: MessageKey; hint: MessageKey }>> = {
  moduleOff: { title: 'health.status.moduleOff.title', hint: 'health.status.moduleOff.hint' },
  noConnection: { title: 'health.status.noConnection.title', hint: 'health.status.noConnection.hint' },
  incomplete: { title: 'health.status.incomplete.title', hint: 'health.status.incomplete.hint' },
  noEnvironments: { title: 'health.status.noEnvironments.title', hint: 'health.status.noEnvironments.hint' },
  unsupported: { title: 'health.status.unsupported.title', hint: 'health.status.unsupported.hint' }
}

export interface HealthScreenProps {
  profile: Profile | undefined
  /**
   * The profile's folders expanded into the folders inside them (the sidebar's list, which honours
   * "Only git repos"), so a service finds its repository; the profile's own folders while unknown.
   */
  projectFolders?: readonly string[]
  onOpenSettings: (tab?: string) => void
  /** Opens a new Claude session in `folder` (the profile's first one when undefined) with the draft in its composer; it is never sent. */
  onInvestigate: (draft: string, folder: string | undefined) => Promise<void> | void
}

/** The service a row is about and the folder its session opens in, before any detail is read. */
function rowTarget(row: HealthRow, folders: string[]): { name: string; folder?: string } {
  switch (row.kind) {
    case 'errors':
      return { name: row.entry.service, folder: matchFolder(folders, row.entry.service) }
    case 'silent':
      return { name: row.service.service, folder: matchFolder(folders, row.service.service) }
    case 'pod':
      return { name: workloadName(row.pod.pod), folder: folderForPod(folders, row.pod.pod) }
    case 'event':
      return { name: row.event.object ? workloadName(row.event.object) : row.event.reason, folder: folderForEvent(folders, row.event) }
    case 'flow':
      return { name: row.tx.service, folder: matchFolder(folders, row.tx.service) }
  }
}

/** Health (⌘8): the environments of the active profile, each with its verdict and the signals behind it. */
export function HealthScreen({ profile, projectFolders, onOpenSettings, onInvestigate }: HealthScreenProps) {
  const { t, tn, locale } = useI18n()
  const toast = useToast()
  const enabled = Boolean(profile && moduleScreens(profile.modules).includes('health'))
  const { view, loading, error, refresh } = useHealth(profile?.id, enabled)
  const [selected, setSelected] = useState<string | null>(null)
  const environments = enabled ? (view?.environments ?? []) : []
  const current = environments.find((e) => e.id === selected) ?? environments[0]
  useEffect(() => {
    if (selected && !environments.some((e) => e.id === selected)) setSelected(null)
  }, [selected, environments])

  // Selection mode: rows of every list can be picked and investigated together in one session.
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<HealthItemId>>(new Set())
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const selectable = useMemo(() => (current ? selectableItems(current.snapshot) : []), [current])
  const finish = () => {
    setSelecting(false)
    setPicked(new Set())
  }
  // A selection only means something in the environment it was made in.
  useEffect(() => finish(), [current?.id])
  // A row a refresh dropped cannot stay selected.
  useEffect(() => setPicked((p) => pruneSelection(p, selectable)), [selectable])
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])

  const folders = projectFolders?.length ? [...projectFolders] : (profile?.folders ?? [])
  const open = async (key: string, prepare: () => Promise<Investigation | null>) => {
    if (busyKey) return
    setBusyKey(key)
    try {
      const investigation = await prepare()
      if (investigation) await onInvestigate(investigation.draft, investigation.folder)
      return investigation
    } catch (e) {
      toast(t('health.investigate.failed', { message: errorText(e) }), 'danger')
      return null
    } finally {
      setBusyKey(null)
    }
  }
  const deps = (env: HealthEnvironmentView) => ({
    locale,
    folders,
    profileName: profile?.name ?? '',
    env,
    details: (request: Parameters<typeof window.hub.health.details>[2]) => window.hub.health.details(profile?.id ?? null, env.id, request)
  })
  const actions: HealthRowActions | null = current
    ? {
        profileId: profile?.id ?? null,
        environmentId: current.id,
        selecting,
        isSelected: (id) => picked.has(id),
        toggle: (id) => setPicked((p) => toggleItem(p, id)),
        busyKey,
        investigate: (key, row) => void open(key, () => investigateRow(row, deps(current))),
        folderHelp: (row) => {
          const target = rowTarget(row, folders)
          if (target.folder) return t('health.investigate.inFolder', { folder: folderName(target.folder) })
          return t('health.investigate.noFolder', { name: target.name, fallback: folders[0] ? folderName(folders[0]) : t('health.investigate.defaultFolder') })
        }
      }
    : null
  const investigateSelection = async () => {
    if (!current) return
    const done = await open('together', () => investigateTogether(picked, current.snapshot, deps(current)))
    if (done) finish()
  }

  // Without the module (or the profile) nothing is asked for: say so instead of waiting forever.
  const copy = enabled ? (view ? STATUS_COPY[view.state] : undefined) : STATUS_COPY.moduleOff
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
          <RefreshButton variant="button" label={t('health.refresh')} loading={loading} onRefresh={refresh} />
        )}
      </header>

      {error && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
          <p className="min-w-0 flex-1 break-words text-sm text-danger">{t('health.loadFailed', { message: error })}</p>
          <Button size="sm" icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={() => void refresh()}>
            {t('health.retry')}
          </Button>
        </div>
      )}

      {enabled && !view && !error && (
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
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label={t('health.environments')} className="flex flex-1 flex-wrap gap-1.5">
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
            {selecting ? (
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" disabled={picked.size === selectable.length} onClick={() => setPicked(new Set(selectable))}>
                  {t('health.selectAll')}
                </Button>
                <Button size="sm" variant="ghost" disabled={picked.size === 0} onClick={() => setPicked(new Set())}>
                  {t('health.clearSelection')}
                </Button>
                <Button size="sm" title={t('health.done.hint')} onClick={finish}>
                  {t('health.done')}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" icon={<ListChecks className="size-3.5" aria-hidden />} disabled={selectable.length === 0} title={t('health.select.hint')} onClick={() => setSelecting(true)}>
                {t('health.select')}
              </Button>
            )}
          </div>
          <HealthRowsProvider value={actions}>
            <EnvironmentPanel key={current.id} env={current} onRetry={() => void refresh()} retrying={loading} />
          </HealthRowsProvider>
          {picked.size > 0 && (
            <div role="region" aria-label={t('health.investigateTogether')} className="sticky bottom-3 z-10 mx-auto flex w-full max-w-xl items-center gap-3 rounded-xl border border-border bg-surface-raised px-4 py-2.5 shadow-lg">
              <span className="text-sm font-semibold tabular-nums">{tn('health.selected', picked.size)}</span>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                {t('health.clearSelection')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busyKey !== null}
                title={t('health.investigateTogether.hint')}
                icon={busyKey === 'together' ? <Spinner /> : <Sparkles className="size-3.5" aria-hidden />}
                onClick={() => void investigateSelection()}
              >
                {busyKey === 'together' ? t('health.preparing') : t('health.investigateTogether')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
