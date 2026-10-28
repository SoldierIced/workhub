import { ExternalLink, RotateCcw, TriangleAlert } from 'lucide-react'
import type { HealthEnvironmentView } from '@shared/health-api'
import { Badge, Button, Spinner, StateDot } from '../../components/atoms'
import { Card } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { blindSpotText, connectionFailure, HEALTH_HINT, HEALTH_LABEL, HEALTH_TONE, reasonText, visibleBlindSpots } from '../../lib/health'
import { relativeTime } from '../../lib/pullRequests'
import { ErrorsCard, EventsCard, PodsCard, ReportingCard, showsStderrCard, SlowCard, StderrCard } from './HealthCards'

export interface EnvironmentPanelProps {
  env: HealthEnvironmentView
  /** Reads the environment again; offered when it could not be read. */
  onRetry?: () => void
  /** A read is running: the retry waits for it. */
  retrying?: boolean
}

/**
 * One environment: its verdict with the reasons, what could not be read, and a card per signal.
 * When the cluster could not be read the failure is shown with its message and a retry, and the
 * cards are left out until there are figures to show. Rows act through `HealthRowsProvider`.
 */
export function EnvironmentPanel({ env, onRetry, retrying = false }: EnvironmentPanelProps) {
  const { t, tn, locale } = useI18n()
  const s = env.snapshot
  const tone = HEALTH_TONE[s.state]
  const failure = connectionFailure(s)
  // The failure box already says why; the same message is not repeated as a blind spot.
  const blind = visibleBlindSpots(s.blindSpots).filter((b) => !(failure && b.code === 'connection'))
  const errorsRead = !s.blindSpots.some((b) => b.code === 'apmOff' || b.code === 'errorsOff')
  return (
    <div className="flex flex-col gap-3" aria-label={env.name}>
      <Card className="flex flex-col gap-2 p-4" aria-label={t('health.environments')}>
        <div className="flex items-center gap-2">
          <StateDot tone={tone} pulse={s.state === 'degraded'} />
          <h2 className="text-lg font-semibold">{env.name}</h2>
          <Badge tone={tone}>{t(HEALTH_LABEL[s.state])}</Badge>
          <span className="text-sm text-muted">{t(HEALTH_HINT[s.state])}</span>
          {env.kibanaUrl && (
            <Button size="sm" variant="ghost" className="ml-auto" icon={<ExternalLink className="size-3.5" aria-hidden />} onClick={() => window.hub.openExternal(env.kibanaUrl!)}>
              {t('health.kibana.environment')}
            </Button>
          )}
        </div>
        {s.reasons.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={t(HEALTH_LABEL[s.state])}>
            {s.reasons.map((r) => (
              <li key={r.code}>
                <Badge tone={r.code === 'servicesSilent' ? 'warning' : 'danger'}>{reasonText(r, tn)}</Badge>
              </li>
            ))}
          </ul>
        )}
        {s.stale && s.fetchedAt !== undefined && (
          <p role="status" className="text-sm text-warning">
            {t('health.stale', { time: relativeTime(s.fetchedAt, Date.now(), locale) })}
          </p>
        )}
        {blind.length > 0 && (
          <div className="mt-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">{t('health.blind.title')}</h3>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted">
              {blind.map((b, i) => (
                <li key={`${b.code}${b.signal ?? ''}${i}`}>{blindSpotText(b, t)}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      {failure && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-danger">{t('health.failed.title', { environment: env.name })}</p>
            <p className="mt-0.5 break-words text-sm text-danger">{failure.message || t('health.failed.noDetail')}</p>
            <p className="mt-1 text-sm text-muted">{t('health.failed.hint')}</p>
          </div>
          {onRetry && (
            <Button size="sm" icon={retrying ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={retrying} onClick={onRetry}>
              {t('health.retry')}
            </Button>
          )}
        </div>
      )}
      {failure?.neverRead ? null : (
        <>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <ErrorsCard env={env} off={!errorsRead} />
            <PodsCard env={env} />
            {showsStderrCard(env) && <StderrCard env={env} />}
            <EventsCard env={env} />
            <ReportingCard env={env} />
          </div>
          <SlowCard env={env} />
        </>
      )}
    </div>
  )
}
