import { BellOff, ExternalLink, Inbox, RotateCcw } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { availableAlertActions, moduleScreens, SNOOZE_CHOICES, type MetricAlert, type MetricAlertAction, type MetricAlertActionType, type SnoozeChoice } from '@workhub/core'
import { Badge, Button, Select, Spinner } from '../../components/atoms'
import { EmptyState, RefreshButton, useToast } from '../../components/molecules'
import { useConfig } from '../../configStore'
import { errorText } from '../../lib/errorText'
import { Sparkline } from '../../components/molecules/Sparkline'
import { useI18n, type I18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { relativeTime } from '../../lib/pullRequests'
import {
  changeText,
  DEFAULT_ALERT_FILTERS,
  filterAlerts,
  KIND_FILTERS,
  KIND_LABEL,
  metricName,
  SEVERITY_FILTERS,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  STATUS_FILTERS,
  STATUS_LABEL,
  type AlertFilters
} from '../../lib/metricAlerts'
import { useMetricAlerts } from '../../metricAlertsStore'

const SNOOZE_LABEL: Record<SnoozeChoice, MessageKey> = { '7d': 'metricAlerts.snooze.7d', '30d': 'metricAlerts.snooze.30d', trendChange: 'metricAlerts.snooze.trendChange' }

/** A local `YYYY-MM-DD` as a short date. */
const dayDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

interface ActionContext {
  alert: MetricAlert
  busy: boolean
  act: (action: MetricAlertAction) => void
  /** Files the alert in Plan's inbox as a pending bug. */
  sendToInbox: () => void
  t: I18n['t']
}

/**
 * How each action shows on a row, by action type. A new action adds its type in core's
 * `availableAlertActions` and one entry here.
 */
const ACTION_CONTROLS: Record<MetricAlertActionType, (c: ActionContext) => ReactNode> = {
  track: ({ busy, act, t }) => (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ type: 'track' })}>
      {t('metricAlerts.action.track')}
    </Button>
  ),
  snooze: ({ busy, act, t }) => (
    <Select
      value=""
      placeholder={t('metricAlerts.action.snooze')}
      aria-label={t('metricAlerts.action.snooze')}
      disabled={busy}
      className="h-7 w-auto min-w-28 text-sm"
      onChange={(v) => {
        if ((SNOOZE_CHOICES as readonly string[]).includes(v)) act({ type: 'snooze', until: v as SnoozeChoice })
      }}
      options={SNOOZE_CHOICES.map((c) => ({ value: c, label: t(SNOOZE_LABEL[c]) }))}
    />
  ),
  resolve: ({ busy, act, t }) => (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ type: 'resolve' })}>
      {t('metricAlerts.action.resolve')}
    </Button>
  ),
  reopen: ({ busy, act, t }) => (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ type: 'reopen' })}>
      {t('metricAlerts.action.reopen')}
    </Button>
  ),
  sendToInbox: ({ busy, sendToInbox, t }) => (
    <Button size="sm" variant="ghost" disabled={busy} icon={<Inbox className="size-3.5" aria-hidden />} title={t('metricAlerts.action.sendToInboxHint')} onClick={sendToInbox}>
      {t('metricAlerts.action.sendToInbox')}
    </Button>
  )
}

function AlertRow({ alert, profileId, busy, act, inbox, sendToInbox }: { alert: MetricAlert; profileId: string; busy: boolean; act: (action: MetricAlertAction) => void; inbox: boolean; sendToInbox: () => void }) {
  const { t, formatDate } = useI18n()
  const name = metricName(alert, t)
  const change = changeText(alert, t('metricAlerts.points'))
  const where = alert.segment ? `${alert.subject} · ${alert.segment}` : alert.subject
  const since = formatDate(dayDate(alert.firstSeenDay), { day: 'numeric', month: 'short' })
  const snoozed =
    alert.status === 'snoozed'
      ? alert.snoozedUntil === 'trendChange'
        ? t('metricAlerts.snoozedTrend')
        : typeof alert.snoozedUntil === 'number'
          ? t('metricAlerts.snoozedUntil', { date: formatDate(alert.snoozedUntil, { day: 'numeric', month: 'short' }) })
          : null
      : null
  return (
    <li className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0" data-testid="metric-alert">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={SEVERITY_TONE[alert.severity]}>{t(SEVERITY_LABEL[alert.severity])}</Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-text" title={`${name} · ${where}`}>
            {name} <span className="font-normal text-muted">· {where}</span>
          </p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{t(KIND_LABEL[alert.kind])}</span>
            {change && <span className="font-medium tabular-nums text-text">{change}</span>}
            <span className="tabular-nums">{t('metricAlerts.values', { value: alert.lastValue, baseline: alert.baseline })}</span>
            <span>{t('metricAlerts.since', { date: since })}</span>
            <span>{t(STATUS_LABEL[alert.status])}</span>
            {snoozed && <span>{snoozed}</span>}
          </p>
        </div>
        <Sparkline values={alert.history.map((h) => h.value)} label={t('metricAlerts.sparkline', { name, where })} />
        <div className="flex shrink-0 items-center gap-1">
          {alert.link && (
            <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />} title={t('metricAlerts.openLink')} aria-label={t('metricAlerts.openLink')} onClick={() => window.hub.openExternal(alert.link!, profileId)} />
          )}
          {availableAlertActions(alert, { inbox }).map((type) => (
            <span key={type}>{ACTION_CONTROLS[type]({ alert, busy, act, sendToInbox, t })}</span>
          ))}
        </div>
      </div>
      {alert.proposeResolve && alert.status !== 'resolved' && (
        <div className="flex items-center gap-2 rounded-md bg-success-soft px-3 py-1.5 text-sm text-success" role="note">
          <span className="flex-1">{t('metricAlerts.proposeResolve')}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ type: 'resolve' })}>
            {t('metricAlerts.action.resolve')}
          </Button>
        </div>
      )}
    </li>
  )
}

/** Health → Alerts: the profile's metric alerts, highest severity first, with filters and the per-alert actions. */
export function MetricAlertsPanel({ profileId }: { profileId: string }) {
  const { t, tn, locale } = useI18n()
  const { view, loading, error, refresh, act } = useMetricAlerts(profileId)
  const toast = useToast()
  const snap = useConfig()
  const inbox = moduleScreens(snap?.config.profiles.find((p) => p.id === profileId)?.modules).includes('planner')
  const [filters, setFilters] = useState<AlertFilters>(DEFAULT_ALERT_FILTERS)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const all = view?.alerts ?? []
  const shown = useMemo(() => filterAlerts(all, filters), [all, filters])
  const run = (key: string, action: MetricAlertAction) => {
    setBusyKey(key)
    void act(key, action).finally(() => setBusyKey(null))
  }
  const sendToInbox = (key: string) => {
    setBusyKey(key)
    window.hub.planner
      .fromAlert(profileId, key)
      .then((r) => toast(r.ok ? t('metricAlerts.sentToInbox') : r.error, r.ok ? undefined : 'danger'), (e: unknown) => toast(errorText(e), 'danger'))
      .finally(() => setBusyKey(null))
  }
  const filter = <K extends keyof AlertFilters>(key: K, value: AlertFilters[K]) => setFilters((f) => ({ ...f, [key]: value }))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">{t('metricAlerts.intro')}</p>
        {view?.updatedAt !== undefined && <span className="text-sm text-subtle">{t('metricAlerts.evaluated', { time: relativeTime(view.updatedAt, Date.now(), locale) })}</span>}
        <RefreshButton variant="button" label={t('metricAlerts.refresh')} loading={loading} onRefresh={refresh} />
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('metricAlerts.filters')}>
        <div className="w-40 shrink-0"><Select value={filters.status} aria-label={t('metricAlerts.filter.status')} onChange={(v) => filter('status', v as AlertFilters['status'])} options={STATUS_FILTERS.map((s) => ({ value: s, label: s === 'all' ? t('metricAlerts.filter.allStatuses') : s === 'open' ? t('metricAlerts.filter.open') : t(STATUS_LABEL[s]) }))} /></div>
        <div className="w-40 shrink-0"><Select value={filters.severity} aria-label={t('metricAlerts.filter.severity')} onChange={(v) => filter('severity', v as AlertFilters['severity'])} options={SEVERITY_FILTERS.map((s) => ({ value: s, label: s === 'all' ? t('metricAlerts.filter.allSeverities') : t(SEVERITY_LABEL[s]) }))} /></div>
        <div className="w-44 shrink-0"><Select value={filters.kind} aria-label={t('metricAlerts.filter.kind')} onChange={(v) => filter('kind', v as AlertFilters['kind'])} options={KIND_FILTERS.map((k) => ({ value: k, label: k === 'all' ? t('metricAlerts.filter.allKinds') : t(KIND_LABEL[k]) }))} /></div>
        <span className="text-sm text-subtle">{tn('metricAlerts.count', shown.length)}</span>
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
          <p className="min-w-0 flex-1 break-words text-sm text-danger">{t('metricAlerts.loadFailed', { message: error })}</p>
          <Button size="sm" icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={() => void refresh()}>
            {t('health.retry')}
          </Button>
        </div>
      )}
      {!view && !error ? (
        <p className="flex items-center gap-2 py-10 text-sm text-muted" role="status">
          <Spinner /> {t('metricAlerts.loading')}
        </p>
      ) : shown.length === 0 ? (
        <EmptyState compact icon={<BellOff className="size-5" aria-hidden />} title={all.length === 0 ? t('metricAlerts.empty') : t('metricAlerts.emptyFiltered')} description={all.length === 0 ? t('metricAlerts.emptyHint') : undefined} />
      ) : (
        <ul className="rounded-lg border border-border bg-surface shadow-sm">
          {shown.map((a) => (
            <AlertRow key={a.key} alert={a} profileId={profileId} busy={busyKey === a.key} act={(action) => run(a.key, action)} inbox={inbox} sendToInbox={() => sendToInbox(a.key)} />
          ))}
        </ul>
      )}
    </div>
  )
}
