import { ExternalLink } from 'lucide-react'
import type { HealthEnvironmentView } from '@shared/health-api'
import { Badge, Button, StateDot } from '../../components/atoms'
import { Card } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { blindSpotText, HEALTH_HINT, HEALTH_LABEL, HEALTH_TONE, reasonText, visibleBlindSpots } from '../../lib/health'
import { relativeTime } from '../../lib/pullRequests'
import { ErrorsCard, EventsCard, PodsCard, ReportingCard, showsStderrCard, SlowCard, StderrCard } from './HealthCards'

/** One environment: its verdict with the reasons, what could not be read, and a card per signal. Rows act through `HealthRowsProvider`. */
export function EnvironmentPanel({ env }: { env: HealthEnvironmentView }) {
  const { t, tn, locale } = useI18n()
  const s = env.snapshot
  const tone = HEALTH_TONE[s.state]
  const blind = visibleBlindSpots(s.blindSpots)
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
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <ErrorsCard env={env} off={!errorsRead} />
        <PodsCard env={env} />
        {showsStderrCard(env) && <StderrCard env={env} />}
        <EventsCard env={env} />
        <ReportingCard env={env} />
      </div>
      <SlowCard env={env} />
    </div>
  )
}
