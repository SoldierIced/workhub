import { Play, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RemoteAutomation, RemotePage } from '../../shared/remote-api'
import { REMOTE_FEATURES } from '../../shared/remote-api'
import { Spinner } from '../../renderer/components/atoms'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { relativeTime } from '../../renderer/lib/pullRequests'
import { useNow } from '../../renderer/lib/usage'
import { goBack, useClient, useClientStatus, useRemoteData } from '../app-context'
import { loadAutomations } from '../automations'
import { Body, Empty, Header, Screen } from '../ui'

const HEALTH_TONE: Record<string, string> = {
  off: 'bg-surface-hover text-muted',
  idle: 'bg-success-soft text-success',
  waiting: 'bg-info-soft text-info',
  paused: 'bg-warning-soft text-warning',
  failing: 'bg-danger-soft text-danger',
  running: 'bg-accent-soft text-accent'
}

const ACTION = 'flex min-h-11 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium active:bg-surface-hover disabled:opacity-60'

function AutomationRow({ automation: a, online, now, onDone }: { automation: RemoteAutomation; online: boolean; now: number; onDone: () => void }) {
  const { t, locale } = useI18n()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async (call: () => Promise<unknown>) => {
    setPending(true)
    setError(null)
    try {
      const answer = (await call()) as { ok?: boolean } | undefined
      if (answer && answer.ok === false) setError(t('web.automations.failed'))
    } catch (err) {
      setError(t('web.automations.refused', { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setPending(false)
      onDone()
    }
  }
  const running = a.health === 'running'
  return (
    <li className="px-4 py-3" data-testid="automation-row">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-md font-medium [overflow-wrap:anywhere]">{a.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
            <span className={cn('rounded-full px-2 py-px text-xs font-semibold', HEALTH_TONE[a.health] ?? HEALTH_TONE['off'])}>{t(`automations.health.${a.health}` as 'automations.health.idle')}</span>
            {a.lastRun ? (
              <span>
                {t('web.automations.lastRun', { time: relativeTime(a.lastRun.at, now, locale) })} · {t(`automations.outcome.${a.lastRun.outcome}` as 'automations.outcome.ok')}
              </span>
            ) : (
              <span>{t('web.automations.neverRun')}</span>
            )}
            {a.nextRunAt !== undefined && <span>{t('web.automations.next', { time: relativeTime(a.nextRunAt, now, locale) })}</span>}
          </div>
        </div>
        {/* Only off: an automation an agent added or edited is turned on at the desktop, never from here. */}
        {a.enabled && (
          <button type="button" role="switch" aria-checked="true" aria-label={t('web.automations.turnOff', { name: a.name })} disabled={pending || !online} onClick={() => void act(() => window.hub.automations.setEnabled(a.id, false))} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center disabled:opacity-60">
            <span className="relative inline-flex h-7 w-12 items-center rounded-full border border-accent bg-accent">
              <span className="ml-auto mr-0.5 size-5 rounded-full bg-accent-fg" />
            </span>
          </button>
        )}
      </div>
      {!a.enabled && <p className="mt-1 text-xs text-subtle">{t('web.automations.turnOnAtDesktop')}</p>}
      {!a.active && <p className="mt-1 text-xs text-warning">{t('automations.moduleOff')}</p>}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {a.enabled && (
        <div className="mt-2">
          {running ? (
            <button type="button" className={ACTION} disabled={pending || !online} onClick={() => void act(() => window.hub.automations.stop(a.id))}>
              {pending ? <Spinner className="size-3.5" /> : <Square className="size-3.5" aria-hidden />}
              {t('automations.stop')}
            </button>
          ) : (
            <button type="button" className={ACTION} disabled={pending || !online} onClick={() => void act(() => window.hub.automations.runNow(a.id))}>
              {pending ? <Spinner className="size-3.5" /> : <Play className="size-3.5" aria-hidden />}
              {t('automations.runNow')}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

/** The automations of the desktop: their state, run now, stop, and turn off. Turning one on stays on the desktop. */
export function AutomationsScreen() {
  const { t } = useI18n()
  const client = useClient()
  const online = useClientStatus().state === 'online'
  const now = useNow()
  const supported = client.supports(REMOTE_FEATURES.automations)
  const list = useRemoteData<RemoteAutomation[]>(null, [], () => (supported ? loadAutomations((request) => client.transport.invoke('remote:automations', request) as Promise<RemotePage<RemoteAutomation>>) : Promise.resolve([])), [supported])
  // The desktop says when anything changed (a run started or ended, a switch): read the list again.
  useEffect(() => client.transport.subscribe('automations:changed', () => list.reload()), [])
  const rows = list.data ?? []
  return (
    <Screen>
      <Header title={t('web.automations.title')} back={() => goBack({ screen: 'settings' })} />
      <Body>
        {!list.data && list.loading && <Spinner className="mx-auto mt-16 size-6" />}
        {list.error && <p className="px-4 pt-4 text-sm text-danger">{list.error}</p>}
        {!supported && <Empty title={t('web.automations.updateDesktop')} />}
        {supported && list.data && rows.length === 0 && <Empty title={t('web.automations.empty')} hint={t('web.automations.emptyHint')} />}
        {rows.length > 0 && (
          <ul className="divide-y divide-border">
            {rows.map((a) => (
              <AutomationRow key={a.id} automation={a} online={online} now={now} onDone={list.reload} />
            ))}
          </ul>
        )}
      </Body>
    </Screen>
  )
}
