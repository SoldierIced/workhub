import { Copy, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { flowKey, isSystemContainer, itemId, podStatusHeadline, type FlowDetails, type K8sEvent, type PodDetails, type PodIssue, type ServiceErrorCount, type ServiceErrorDetails, type ServiceReporting, type SlowTransaction } from '@workhub/core'
import type { HealthEnvironmentView } from '@shared/health-api'
import { Badge, Button } from '../../components/atoms'
import { Card, CardBody, CardHeader, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { formatMs, formatRate, groupTitle, infraRequest, leadGroupText, noPodMetrics, POD_LABEL, POD_TONE, shortType, TREND_LABEL, TREND_TONE, whyText } from '../../lib/health'
import { relativeTime } from '../../lib/pullRequests'
import { DetailFooter, Disclosure, InvestigateButton, KibanaLink, PickRow, useHealthDetail } from './HealthRows'
import { FlowDetailsView } from './FlowDetailsView'

const Empty = ({ children }: { children: string }) => <p className="text-sm text-subtle">{children}</p>

// Errors -------------------------------------------------------------------------------------------

export function ErrorsCard({ env, off }: { env: HealthEnvironmentView; off: boolean }) {
  const { t } = useI18n()
  const errors = env.snapshot.errorServices
  const hasChronic = errors.some((e) => e.stats.state === 'chronic')
  return (
    <Card aria-label={t('health.errors.title')}>
      <CardHeader title={t('health.errors.title')} meta={t('health.errors.meta', { hours: env.errorWindowHours })} />
      <CardBody>
        {errors.length === 0 ? (
          <Empty>{off ? t('health.errors.off') : t('health.errors.empty')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {errors.map((e) => (
              <ErrorRow key={e.service} entry={e} env={env} />
            ))}
          </ul>
        )}
        {hasChronic && <p className="mt-2 text-xs text-subtle">{t('health.trend.chronicNote')}</p>}
      </CardBody>
    </Card>
  )
}

/** A service with errors. Expanding it reads its top error groups once (kept 10 minutes) and says why it is listed. */
function ErrorRow({ entry, env }: { entry: ServiceErrorCount; env: HealthEnvironmentView }) {
  const i18n = useI18n()
  const { t, formatNumber } = i18n
  const [open, setOpen] = useState(false)
  const details = useHealthDetail<ServiceErrorDetails>({ kind: 'errors', service: entry.service }, open)
  const hours = env.errorWindowHours
  const groups = details.value?.groups
  const lead = groups ? leadGroupText(groups, entry.stats.recent, i18n) : null
  return (
    <PickRow id={itemId('errors', entry.service)} label={entry.service}>
      <div className="flex items-center gap-2 text-sm">
        <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
          <span className="block truncate font-medium" title={entry.service}>
            {entry.service}
          </span>
        </Disclosure>
        <span className="text-xs text-subtle">{t('health.errors.typical', { count: formatNumber(entry.stats.typicalDay) })}</span>
        <Badge tone={TREND_TONE[entry.stats.state]}>{t(TREND_LABEL[entry.stats.state])}</Badge>
        <span className="w-14 text-right tabular-nums">{formatNumber(entry.stats.recent)}</span>
        <KibanaLink url={env.errorUrls[entry.service] ?? env.serviceUrls[entry.service]} label={t('health.kibana.service', { service: entry.service })} />
        <InvestigateButton rowKey={itemId('errors', entry.service)} row={{ kind: 'errors', entry }} compact />
      </div>
      {open && (
        <div className="mt-1.5 flex flex-col gap-2 pl-5 text-sm">
          <p>{whyText(entry.stats, hours, i18n)}</p>
          {lead && (
            <p className="text-xs text-muted">
              {lead}
              {groups?.[0]?.isNew && groups[0].firstSeen !== undefined ? ` ${t('health.errors.newSince', { time: relativeTime(groups[0].firstSeen, Date.now(), i18n.locale) })}` : ''}
            </p>
          )}
          {groups &&
            (groups.length === 0 ? (
              <p className="text-xs text-muted">{t('health.errors.noGroups', { hours })}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <h4 className="text-xs font-semibold">{t('health.errors.groups', { hours })}</h4>
                {groups.map((g) => (
                  <div key={g.groupingKey} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate" title={g.exceptionType ?? groupTitle(g)}>
                        <span className="font-semibold">{shortType(groupTitle(g))}</span>
                        <span className="text-muted">
                          {' · '}
                          {[
                            formatNumber(g.recent),
                            g.endpoint,
                            g.firstSeen !== undefined ? t('health.errors.groupFirst', { time: relativeTime(g.firstSeen, Date.now(), i18n.locale) }) : undefined,
                            g.lastSeen !== undefined ? t('health.errors.groupLast', { time: relativeTime(g.lastSeen, Date.now(), i18n.locale) }) : undefined,
                            !g.isNew && g.daysWithData > 1 ? t('health.errors.groupDays', { active: g.activeDays, days: g.daysWithData }) : undefined
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </p>
                      {g.message && <p className="line-clamp-2 text-xs text-muted select-text">{g.message}</p>}
                      {g.culprit && g.culprit !== groupTitle(g) && <p className="truncate text-xs text-subtle">{t('health.errors.culprit', { culprit: g.culprit })}</p>}
                    </div>
                    {g.isNew && <Badge tone={TREND_TONE.new}>{t(TREND_LABEL.new)}</Badge>}
                    <KibanaLink url={g.kibanaUrl} label={t('health.errors.kibanaGroup')} />
                  </div>
                ))}
              </div>
            ))}
          <DetailFooter state={details} fetchedAt={details.value?.fetchedAt} />
        </div>
      )}
    </PickRow>
  )
}

// Pods ---------------------------------------------------------------------------------------------

export function PodsCard({ env }: { env: HealthEnvironmentView }) {
  const { t, tn } = useI18n()
  const s = env.snapshot
  return (
    <Card aria-label={t('health.pods.title')}>
      <CardHeader title={t('health.pods.title')} />
      <CardBody>
        {s.podVisibility !== 'visible' ? (
          <NoPodMetrics env={env} />
        ) : s.pods.length === 0 ? (
          <Empty>{t('health.pods.empty')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {s.pods.map((p) => (
              <PodRow key={p.pod} pod={p} env={env} restartsLabel={p.recentRestarts > 0 ? tn('health.pod.restarts', p.recentRestarts) : undefined} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

/** A pod that needs attention. Expanding it reads its container status, last warning events and stderr once (kept 10 minutes). */
function PodRow({ pod, env, restartsLabel }: { pod: PodIssue; env: HealthEnvironmentView; restartsLabel?: string }) {
  const { t, tn, locale, formatNumber } = useI18n()
  const [open, setOpen] = useState(false)
  const details = useHealthDetail<PodDetails>({ kind: 'pod', pod: pod.pod }, open)
  const d = details.value
  const headline = podStatusHeadline(d?.status)
  const hours = env.errorWindowHours
  const status = d?.status
  const statusLine = status
    ? [
        status.container ? (status.namespace ? t('health.pods.containerIn', { container: status.container, namespace: status.namespace }) : t('health.pods.container', { container: status.container })) : undefined,
        status.waitingReason ? t('health.pods.waiting', { reason: status.waitingReason }) : undefined,
        status.lastTerminatedReason
          ? [t('health.pods.ended', { reason: status.lastTerminatedReason }), status.lastExitCode !== undefined ? t('health.pods.exit', { code: status.lastExitCode }) : undefined, status.lastTerminatedAt !== undefined ? relativeTime(status.lastTerminatedAt, Date.now(), locale) : undefined]
              .filter(Boolean)
              .join(', ')
          : undefined
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <PickRow id={itemId('pod', pod.pod)} label={pod.pod}>
      <div className="flex items-center gap-2 text-sm">
        <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
          <span className="block truncate font-mono text-xs" title={pod.pod}>
            {pod.pod}
          </span>
        </Disclosure>
        {restartsLabel && <span className="text-xs text-subtle">{restartsLabel}</span>}
        {headline && <Badge tone="danger">{headline}</Badge>}
        <Badge tone={POD_TONE[pod.kind]}>{t(POD_LABEL[pod.kind])}</Badge>
        <KibanaLink url={env.podUrls[pod.pod]} label={t('health.kibana.pod', { pod: pod.pod })} />
        <InvestigateButton rowKey={itemId('pod', pod.pod)} row={{ kind: 'pod', pod }} compact />
      </div>
      {open && (
        <div className="mt-1.5 flex flex-col gap-2.5 pl-5 text-sm">
          {statusLine && <p className="text-xs text-muted">{statusLine}</p>}
          {d && (
            <>
              <section className="flex flex-col gap-1">
                <h4 className="text-xs font-semibold">{t('health.pods.events', { hours })}</h4>
                {d.eventsError ? (
                  <p className="text-xs text-warning">{t('health.pods.eventsFailed', { error: d.eventsError })}</p>
                ) : d.events.length === 0 ? (
                  <p className="text-xs text-muted">{t('health.pods.noEvents')}</p>
                ) : (
                  d.events.map((e) => (
                    <div key={e.reason}>
                      <p className="truncate">
                        <span className="font-semibold">{e.reason}</span>
                        <span className="text-muted">
                          {' · '}
                          {[e.lastSeen !== undefined ? relativeTime(e.lastSeen, Date.now(), locale) : undefined, tn('health.pods.times', Math.max(e.occurrences ?? 0, e.count), { count: formatNumber(Math.max(e.occurrences ?? 0, e.count)) })]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </p>
                      {e.message && <p className="line-clamp-2 text-xs text-muted select-text">{e.message}</p>}
                    </div>
                  ))
                )}
              </section>
              <section className="flex flex-col gap-1">
                <h4 className="text-xs font-semibold">{t('health.pods.stderr')}</h4>
                {d.stderrError ? (
                  <p className="text-xs text-warning">{t('health.pods.stderrFailed', { error: d.stderrError })}</p>
                ) : d.stderr.length === 0 ? (
                  <p className="text-xs text-muted">{t('health.pods.noStderr', { hours })}</p>
                ) : (
                  <pre className="overflow-x-auto rounded-md bg-surface-hover p-2 font-mono text-xs whitespace-pre-wrap select-text">{d.stderr.map((l) => l.text).join('\n')}</pre>
                )}
              </section>
            </>
          )}
          <DetailFooter state={details} fetchedAt={d?.fetchedAt} />
        </div>
      )}
    </PickRow>
  )
}

/** Why there is nothing to say about pods, and what to do about it. */
function NoPodMetrics({ env }: { env: HealthEnvironmentView }) {
  const { t } = useI18n()
  const toast = useToast()
  const copy = noPodMetrics(env, env.snapshot.podVisibility)
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-dashed border-border-strong p-3">
      <EyeOff className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-sm font-semibold">{t(copy.title)}</p>
        <p className="text-xs text-muted">{t(copy.hint, { environment: env.name })}</p>
        {copy.askInfra && (
          <Button
            size="sm"
            className="self-start"
            icon={<Copy className="size-3.5" aria-hidden />}
            onClick={() => {
              void navigator.clipboard.writeText(infraRequest(env, t)).then(() => toast(t('health.pods.copied')))
            }}
          >
            {t('health.pods.copyRequest')}
          </Button>
        )}
      </div>
    </div>
  )
}

// Container stderr -------------------------------------------------------------------------------

/** Shown where stderr is read instead of pod metrics, when there is something to say. */
export const showsStderrCard = (env: HealthEnvironmentView): boolean =>
  env.k8sIndexSuffix !== '' && env.snapshot.podVisibility !== 'visible' && (env.snapshot.containerStderr.length > 0 || env.snapshot.blindSpots.some((b) => b.code === 'unread' && b.signal === 'stderr'))

/** stderr volume per container while pod metrics are missing. Infrastructure containers are hidden unless asked for. */
export function StderrCard({ env }: { env: HealthEnvironmentView }) {
  const { t, formatNumber } = useI18n()
  const [showSystem, setShowSystem] = useState(false)
  const entries = env.snapshot.containerStderr
  const isSystem = (e: (typeof entries)[number]) => isSystemContainer(e.key, e.namespace)
  const systemCount = entries.filter(isSystem).length
  const shown = showSystem ? entries : entries.filter((e) => !isSystem(e))
  const unread = env.snapshot.blindSpots.find((b) => b.code === 'unread' && b.signal === 'stderr')
  return (
    <Card aria-label={t('health.stderr.title')}>
      <CardHeader title={t('health.stderr.title')} meta={t('health.stderr.meta', { hours: env.errorWindowHours })} />
      <CardBody className="flex flex-col gap-2">
        {unread ? (
          <p className="text-sm text-warning">{unread.detail}</p>
        ) : (
          <>
            {shown.length === 0 ? (
              <Empty>{systemCount > 0 ? t('health.stderr.onlySystem') : t('health.stderr.empty')}</Empty>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {shown.slice(0, 8).map((e) => (
                  <li key={e.key} className="flex items-center gap-2 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.namespace ? `${e.key} · ${e.namespace}` : e.key}>
                      {e.key}
                      {isSystem(e) && <span className="ml-1.5 font-sans text-subtle">{t('health.stderr.system')}</span>}
                    </span>
                    <Badge tone={TREND_TONE[e.stats.state]}>{t(TREND_LABEL[e.stats.state])}</Badge>
                    <span className="w-14 text-right tabular-nums">{formatNumber(e.stats.recent)}</span>
                  </li>
                ))}
              </ul>
            )}
            {systemCount > 0 && (
              <label className="flex items-center gap-1.5 text-xs text-muted" title={t('health.stderr.showSystemHint')}>
                <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
                {t('health.stderr.showSystem', { count: systemCount })}
              </label>
            )}
            <p className="text-xs text-subtle">{t('health.stderr.note')}</p>
          </>
        )}
      </CardBody>
    </Card>
  )
}

// Warning events -----------------------------------------------------------------------------------

export function EventsCard({ env }: { env: HealthEnvironmentView }) {
  const { t } = useI18n()
  const events = env.snapshot.events
  return (
    <Card aria-label={t('health.events.title')}>
      <CardHeader title={t('health.events.title')} />
      <CardBody>
        {events.length === 0 ? (
          <Empty>{t('health.events.empty')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {events.map((e) => (
              <EventRow key={e.reason} event={e} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

function EventRow({ event: e }: { event: K8sEvent }) {
  const { t, locale, formatNumber } = useI18n()
  return (
    <PickRow id={itemId('event', e.reason)} label={e.reason} className="text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{e.reason}</span>
        <Badge tone={TREND_TONE[e.stats.state]}>{t(TREND_LABEL[e.stats.state])}</Badge>
        <span className="w-12 text-right tabular-nums">{formatNumber(e.stats.recent)}</span>
        <InvestigateButton rowKey={itemId('event', e.reason)} row={{ kind: 'event', event: e }} compact />
      </div>
      {(e.message || e.object) && (
        <p className="truncate text-xs text-subtle" title={e.message}>
          {[e.object, e.message].filter(Boolean).join(' · ')}
          {e.lastSeen ? ` · ${t('health.events.last', { time: relativeTime(e.lastSeen, Date.now(), locale) })}` : ''}
        </p>
      )}
    </PickRow>
  )
}

// Services that stopped reporting ---------------------------------------------------------------

export function ReportingCard({ env }: { env: HealthEnvironmentView }) {
  const { t, tn } = useI18n()
  const s = env.snapshot
  const read = s.reportingServiceCount > 0 || s.silentServices.length > 0
  return (
    <Card aria-label={t('health.reporting.title')}>
      <CardHeader title={t('health.reporting.title')} />
      <CardBody>
        {!read ? (
          <Empty>{t('health.reporting.none')}</Empty>
        ) : s.silentServices.length === 0 ? (
          <Empty>{tn('health.reporting.ok', s.reportingServiceCount)}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {s.silentServices.map((x) => (
              <SilentRow key={x.service} service={x} url={env.serviceUrls[x.service]} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

function SilentRow({ service: s, url }: { service: ServiceReporting; url: string | undefined }) {
  const { t } = useI18n()
  return (
    <PickRow id={itemId('silent', s.service)} label={s.service}>
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{s.service}</span>
        <Badge tone="warning">{t('health.reporting.silent', { minutes: s.silentMinutes })}</Badge>
        <KibanaLink url={url} label={t('health.kibana.service', { service: s.service })} />
        <InvestigateButton rowKey={itemId('silent', s.service)} row={{ kind: 'silent', service: s }} compact />
      </div>
    </PickRow>
  )
}

// Slow flows ---------------------------------------------------------------------------------------

export function SlowCard({ env }: { env: HealthEnvironmentView }) {
  const { t } = useI18n()
  const slow = env.snapshot.slow
  return (
    <Card aria-label={t('health.slow.title')}>
      <CardHeader title={t('health.slow.title')} meta={t('health.slow.meta', { hours: env.slowFlowHours })} />
      <CardBody>
        {slow.length === 0 ? (
          <Empty>{t('health.slow.empty')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {slow.map((tx) => (
              <SlowRow key={flowKey(tx)} tx={tx} env={env} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

/** A slow endpoint. Expanding it reads where the time of its slowest executions goes, and how this window compares with the one before. */
function SlowRow({ tx, env }: { tx: SlowTransaction; env: HealthEnvironmentView }) {
  const { t, tn, formatNumber } = useI18n()
  const [open, setOpen] = useState(false)
  const details = useHealthDetail<FlowDetails>({ kind: 'flow', service: tx.service, name: tx.name }, open)
  const top = details.value?.spans[0]
  const id = itemId('flow', flowKey(tx))
  return (
    <PickRow id={id} label={`${tx.service} ${tx.name}`} className="py-2">
      <div className="flex items-center gap-3 text-sm">
        <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
          <span className="block truncate font-medium" title={tx.name}>
            {tx.name}
          </span>
          <span className="block truncate text-xs text-subtle">
            {tx.service} · {tn('health.slow.calls', tx.calls, { count: formatNumber(tx.calls) })}
            {tx.failureRate > 0 ? ` · ${t('health.slow.failures', { rate: formatRate(tx.failureRate) })}` : ''}
            {top ? ` · ${top.resource}: ${t('health.slow.topSpan', { kind: [top.type, top.subtype].filter(Boolean).join(' · '), share: formatRate(top.shareOfWallTime) })}` : ''}
          </span>
        </Disclosure>
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
        <KibanaLink url={env.serviceUrls[tx.service]} label={t('health.kibana.service', { service: tx.service })} />
        <InvestigateButton rowKey={id} row={{ kind: 'flow', tx }} />
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2.5 pl-5 text-sm">
          {details.value && <FlowDetailsView details={details.value} />}
          <DetailFooter state={details} fetchedAt={details.value?.fetchedAt} />
        </div>
      )}
    </PickRow>
  )
}
