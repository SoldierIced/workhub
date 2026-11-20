import { ExternalLink } from 'lucide-react'
import type { MetricAlert } from '@workhub/core'
import type { MetricAlertsView } from '../../shared/metric-alerts-api'
import { Spinner } from '../../renderer/components/atoms'
import type { MessageKey } from '../../renderer/i18n/translate'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { safeHref } from '../../renderer/components/molecules/Markdown'
import { cn } from '../../renderer/lib/cn'
import { useConfig, useProfileId, useRemoteData } from '../app-context'
import { Body, Empty, Header, Screen } from '../ui'
import { ProfilePicker } from './ProfilePicker'

const SEVERITY_TONE: Record<MetricAlert['severity'], string> = {
  high: 'bg-danger-soft text-danger',
  medium: 'bg-warning-soft text-warning',
  low: 'bg-info-soft text-info'
}

const SEVERITY_LABEL: Record<MetricAlert['severity'], MessageKey> = {
  high: 'metricAlerts.severity.high',
  medium: 'metricAlerts.severity.medium',
  low: 'metricAlerts.severity.low'
}

function AlertRow({ alert }: { alert: MetricAlert }) {
  const { t, formatNumber } = useI18n()
  const body = (
    <>
      <div className="flex items-start gap-2">
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold', SEVERITY_TONE[alert.severity] ?? 'bg-surface-hover text-muted')}>{SEVERITY_LABEL[alert.severity] ? t(SEVERITY_LABEL[alert.severity]) : alert.severity}</span>
        <span className="line-clamp-2 min-w-0 text-md font-medium break-words">{alert.label ?? alert.metric}</span>
      </div>
      <div className="mt-0.5 text-xs text-muted break-words">
        {alert.subject}
        {alert.segment ? ` · ${alert.segment}` : ''}
      </div>
      <div className="mt-0.5 text-xs text-muted">
        {alert.changePct !== undefined ? t('web.alerts.change', { change: formatNumber(alert.changePct, { maximumFractionDigits: 0, signDisplay: 'always' }) }) : null}
        {alert.changePct !== undefined ? ' · ' : ''}
        {t('web.alerts.value', { value: formatNumber(alert.lastValue, { maximumFractionDigits: 2 }), baseline: formatNumber(alert.baseline, { maximumFractionDigits: 2 }) })}
      </div>
    </>
  )
  const href = safeHref(alert.link)
  return (
    <li>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-start gap-3 px-4 py-3 active:bg-surface-hover">
          <div className="min-w-0 flex-1">{body}</div>
          <ExternalLink className="mt-1 size-4 shrink-0 text-subtle" aria-hidden />
        </a>
      ) : (
        <div className="px-4 py-3">{body}</div>
      )}
    </li>
  )
}

/** The profile's metric alerts, highest severity first, as the desktop's Health screen lists them. */
export function AlertsScreen() {
  const { t } = useI18n()
  const { config } = useConfig()
  const [profileId, setProfileId] = useProfileId(config)
  const alerts = useRemoteData<MetricAlertsView | null>('metricAlerts:list', [profileId], () => (profileId ? window.hub.metricAlerts.list(profileId) : Promise.resolve(null)), [profileId])
  const data = alerts.data
  const open = data?.alerts.filter((a) => a.status !== 'resolved') ?? []
  return (
    <Screen>
      <Header title={t('web.alerts.title')} right={<ProfilePicker config={config} value={profileId} onChange={setProfileId} />} />
      <Body>
        {!data && alerts.loading && <Spinner className="mx-auto mt-16 size-6" />}
        {alerts.error && <p className="px-4 pt-4 text-sm text-danger">{alerts.error}</p>}
        {data && !data.enabled && <Empty title={t('web.alerts.disabled')} hint={t('web.alerts.disabledHint')} />}
        {data?.enabled && open.length === 0 && <Empty title={t('web.alerts.empty')} hint={t('web.alerts.emptyHint')} />}
        {open.length > 0 && (
          <ul className="divide-y divide-border">
            {open.map((a) => (
              <AlertRow key={a.key} alert={a} />
            ))}
          </ul>
        )}
      </Body>
    </Screen>
  )
}
