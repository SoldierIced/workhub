import { ExternalLink, Sparkles } from 'lucide-react'
import type { K8sEvent, PodIssue, ServiceErrorCount, ServiceReporting, SlowTransaction } from '@workhub/core'
import { Badge, Button } from '../../components/atoms'
import { Card, CardBody, CardHeader } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { formatMs, formatRate, POD_LABEL, POD_TONE, TREND_LABEL, TREND_TONE } from '../../lib/health'
import { relativeTime } from '../../lib/pullRequests'

const Empty = ({ children }: { children: string }) => <p className="text-sm text-subtle">{children}</p>

function KibanaLink({ url, label }: { url: string | undefined; label: string }) {
  if (!url) return null
  return (
    <button type="button" aria-label={label} title={label} onClick={() => window.hub.openExternal(url)} className="inline-flex size-6 items-center justify-center rounded-sm text-subtle hover:bg-surface-hover hover:text-text">
      <ExternalLink className="size-3.5" aria-hidden />
    </button>
  )
}

export function ErrorsCard({ errors, off, hours, serviceUrls }: { errors: ServiceErrorCount[]; off: boolean; hours: number; serviceUrls: Record<string, string> }) {
  const { t, formatNumber } = useI18n()
  const hasChronic = errors.some((e) => e.stats.state === 'chronic')
  return (
    <Card aria-label={t('health.errors.title')}>
      <CardHeader title={t('health.errors.title')} meta={t('health.errors.meta', { hours })} />
      <CardBody>
        {errors.length === 0 ? (
          <Empty>{off ? t('health.errors.off') : t('health.errors.empty')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {errors.map((e) => (
              <li key={e.service} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium" title={e.service}>
                  {e.service}
                </span>
                <span className="text-xs text-subtle">{t('health.errors.typical', { count: formatNumber(e.stats.typicalDay) })}</span>
                <Badge tone={TREND_TONE[e.stats.state]}>{t(TREND_LABEL[e.stats.state])}</Badge>
                <span className="w-14 text-right tabular-nums">{formatNumber(e.stats.recent)}</span>
                <KibanaLink url={serviceUrls[e.service]} label={t('health.kibana.service', { service: e.service })} />
              </li>
            ))}
          </ul>
        )}
        {hasChronic && <p className="mt-2 text-xs text-subtle">{t('health.trend.chronicNote')}</p>}
      </CardBody>
    </Card>
  )
}

export function PodsCard({ pods, visible }: { pods: PodIssue[]; visible: boolean }) {
  const { t, tn } = useI18n()
  return (
    <Card aria-label={t('health.pods.title')}>
      <CardHeader title={t('health.pods.title')} />
      <CardBody>
        {!visible ? (
          <Empty>{t('health.pods.notVisible')}</Empty>
        ) : pods.length === 0 ? (
          <Empty>{t('health.pods.empty')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {pods.map((p) => (
              <li key={p.pod} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={p.pod}>
                  {p.pod}
                </span>
                {p.recentRestarts > 0 && <span className="text-xs text-subtle">{tn('health.pod.restarts', p.recentRestarts)}</span>}
                <Badge tone={POD_TONE[p.kind]}>{t(POD_LABEL[p.kind])}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

export function EventsCard({ events }: { events: K8sEvent[] }) {
  const { t, locale, formatNumber } = useI18n()
  return (
    <Card aria-label={t('health.events.title')}>
      <CardHeader title={t('health.events.title')} />
      <CardBody>
        {events.length === 0 ? (
          <Empty>{t('health.events.empty')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {events.map((e) => (
              <li key={e.reason} className="py-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{e.reason}</span>
                  <Badge tone={TREND_TONE[e.stats.state]}>{t(TREND_LABEL[e.stats.state])}</Badge>
                  <span className="w-12 text-right tabular-nums">{formatNumber(e.stats.recent)}</span>
                </div>
                {(e.message || e.object) && (
                  <p className="truncate text-xs text-subtle" title={e.message}>
                    {[e.object, e.message].filter(Boolean).join(' · ')}
                    {e.lastSeen ? ` · ${t('health.events.last', { time: relativeTime(e.lastSeen, Date.now(), locale) })}` : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

export function ReportingCard({ silent, reporting, read, serviceUrls }: { silent: ServiceReporting[]; reporting: number; read: boolean; serviceUrls: Record<string, string> }) {
  const { t, tn } = useI18n()
  return (
    <Card aria-label={t('health.reporting.title')}>
      <CardHeader title={t('health.reporting.title')} />
      <CardBody>
        {!read ? (
          <Empty>{t('health.reporting.none')}</Empty>
        ) : silent.length === 0 ? (
          <Empty>{tn('health.reporting.ok', reporting)}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {silent.map((s) => (
              <li key={s.service} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{s.service}</span>
                <Badge tone="warning">{t('health.reporting.silent', { minutes: s.silentMinutes })}</Badge>
                <KibanaLink url={serviceUrls[s.service]} label={t('health.kibana.service', { service: s.service })} />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

export function SlowCard({ slow, hours, serviceUrls, onInvestigate }: { slow: SlowTransaction[]; hours: number; serviceUrls: Record<string, string>; onInvestigate: (tx: SlowTransaction) => void }) {
  const { t, tn, formatNumber } = useI18n()
  return (
    <Card aria-label={t('health.slow.title')}>
      <CardHeader title={t('health.slow.title')} meta={t('health.slow.meta', { hours })} />
      <CardBody>
        {slow.length === 0 ? (
          <Empty>{t('health.slow.empty')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {slow.map((tx) => (
              <li key={`${tx.service}|${tx.name}`} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium" title={tx.name}>
                    {tx.name}
                  </p>
                  <p className="truncate text-xs text-subtle">
                    {tx.service} · {tn('health.slow.calls', tx.calls, { count: formatNumber(tx.calls) })}
                    {tx.failureRate > 0 ? ` · ${t('health.slow.failures', { rate: formatRate(tx.failureRate) })}` : ''}
                  </p>
                </div>
                <dl className="flex shrink-0 items-center gap-4 tabular-nums">
                  {(
                    [
                      ['health.slow.p50', tx.p50Ms],
                      ['health.slow.p95', tx.p95Ms],
                      ['health.slow.p99', tx.p99Ms]
                    ] as const
                  ).map(([label, ms]) => (
                    <div key={label} className="text-right">
                      <dt className="text-xs text-subtle">{t(label)}</dt>
                      <dd className={label === 'health.slow.p95' ? 'font-semibold' : ''}>{formatMs(ms)}</dd>
                    </div>
                  ))}
                </dl>
                <KibanaLink url={serviceUrls[tx.service]} label={t('health.kibana.service', { service: tx.service })} />
                <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" aria-hidden />} onClick={() => onInvestigate(tx)}>
                  {t('health.investigate')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
