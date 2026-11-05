import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  ALERT_SEVERITIES,
  alertRulesOf,
  appOptions,
  DEFAULT_HEALTH_REFRESH_MINUTES,
  HEALTH_ALERT_CHANNELS,
  HEALTH_ALERT_KINDS,
  HEALTH_ALERT_THRESHOLDS,
  healthAlertSettingsOf,
  parseThresholds,
  type AlertSeverity,
  type HealthAlertChannel,
  type HealthAlertKind,
  type Profile,
  type QuietHours
} from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import { Button, Input, Select, Switch } from '../components/atoms'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { SEVERITY_LABEL } from '../lib/metricAlerts'
import { withHealthAlertKind } from './alerts/alertsForm'
import { FlowLimitsGroup } from './alerts/FlowLimits'
import { SettingRow, SettingsGroup } from './settings/SettingsLayout'
import type { Run } from './settings/run'

/** Monday first; 0 is Sunday. */
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const DEFAULT_QUIET: QuietHours = { startHour: 22, endHour: 7 }

/** A number input that saves when it loses focus (or on Enter); blank means unset. */
export function NumberCell({ value, placeholder, min, max, step, disabled, label, onCommit }: { value: number | undefined; placeholder?: string; min?: number; max?: number; step?: number; disabled?: boolean; label: string; onCommit: (n: number | undefined) => void }) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value])
  const commit = () => {
    const v = draft.trim()
    const n = v === '' ? undefined : Number(v)
    if (n !== undefined && !Number.isFinite(n)) return setDraft(value === undefined ? '' : String(value))
    if (n !== value) onCommit(n)
  }
  return (
    <Input
      type="number"
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className="w-24"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

/** Settings → Alerts: when something counts as an alert, per module. Whether and where it is announced app-wide is in Notifications. */
export function AlertsSettings({ snap, run }: { snap: ConfigSnapshot; run: Run }) {
  const { t } = useI18n()
  const editable = !snap.loadError
  const profile = snap.config.profiles.find((p) => p.id === snap.config.activeProfileId)

  // Read the profile fresh: another form of Settings may have saved it a moment ago.
  const saveProfile = (change: (p: Profile) => Profile) =>
    void run(async () => {
      const latest = (await window.hub.config.get()).config.profiles.find((p) => p.id === profile?.id) ?? profile!
      return window.hub.config.saveProfile(change(latest))
    })
  const withHealth = (p: Profile, patch: Partial<NonNullable<Profile['health']>>): Profile => ({ ...p, health: { refreshMinutes: DEFAULT_HEALTH_REFRESH_MINUTES, environments: [], ...p.health, ...patch } })

  return (
    <div className="flex flex-col gap-6" data-testid="alerts-settings">
      <p className="px-1 text-sm text-muted">{t('alertsSettings.intro')}</p>
      {!profile ? (
        <p className="px-1 text-sm text-subtle">{t('alertsSettings.noProfile')}</p>
      ) : (
        <>
          <HealthKindsGroup profile={profile} editable={editable} save={(alerts) => saveProfile((p) => withHealth(p, { alerts }))} />
          <MetricsGroup profile={profile} editable={editable} save={(alertRules) => saveProfile((p) => withHealth(p, { alertRules }))} />
          <FlowLimitsGroup profile={profile} editable={editable} />
        </>
      )}
      <UsageGroup snap={snap} run={run} editable={editable} />
      {profile && <QuietHoursGroup profile={profile} editable={editable} save={(quietHours) => saveProfile((p) => ({ ...p, alerts: { ...p.alerts, quietHours } }))} />}
    </div>
  )
}

const CHANNEL_LABEL: Record<HealthAlertChannel, MessageKey> = { notification: 'alertsSettings.channel.notification', tray: 'alertsSettings.channel.tray' }

/** Health · environments: one row per alert kind, its switch, its threshold (when the detector has one) and its channels. */
export function HealthKindsGroup({ profile, editable, save }: { profile: Profile; editable: boolean; save: (alerts: NonNullable<NonNullable<Profile['health']>['alerts']>) => void }) {
  const { t } = useI18n()
  const stored = profile.health?.alerts
  const settings = healthAlertSettingsOf(stored)
  const envs = profile.health?.environments ?? []
  // The environments' own "stopped reporting after": the threshold below it changes nothing.
  const silentFloor = envs.length ? Math.min(...envs.map((e) => e.thresholds.silentAfterMinutes)) : undefined
  const change = (kind: HealthAlertKind, patch: Partial<{ notify: boolean; threshold: number | undefined; channels: HealthAlertChannel[] }>) => {
    const current = settings[kind]
    const next = { notify: current.notify, threshold: current.threshold, channels: current.channels, ...patch }
    save(withHealthAlertKind(stored, kind, next))
  }
  return (
    <SettingsGroup title={t('alertsSettings.health.title')} help={t('alertsSettings.health.help')} footnote={t('alertsSettings.health.footnote')}>
      <table className="w-full text-sm" data-testid="alerts-health">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-2 font-medium">{t('alertsSettings.col.alert')}</th>
            <th className="py-2 font-medium">{t('alertsSettings.col.notify')}</th>
            <th className="py-2 font-medium">{t('alertsSettings.col.threshold')}</th>
            <th className="py-2 font-medium">{t('alertsSettings.col.channels')}</th>
          </tr>
        </thead>
        <tbody>
          {HEALTH_ALERT_KINDS.map((kind) => {
            const s = settings[kind]
            const spec = HEALTH_ALERT_THRESHOLDS[kind]
            const label = t(`alertsSettings.kind.${kind}` as MessageKey)
            return (
              <tr key={kind} id={`alerts.health.${kind}`} data-setting-id={`alerts.health.${kind}`} className="border-t border-border">
                <td className="py-2 pr-3">
                  <span className="block">{label}</span>
                  <span className="block text-xs text-subtle">{t(`alertsSettings.kindHint.${kind}` as MessageKey)}</span>
                </td>
                <td className="py-2 pr-3">
                  <Switch checked={s.notify} disabled={!editable} aria-label={t('alertsSettings.notifyFor', { alert: label })} onChange={(on) => change(kind, { notify: on })} />
                </td>
                <td className="py-2 pr-3">
                  {spec ? (
                    <span className="inline-flex items-center gap-2">
                      <NumberCell
                        label={t('alertsSettings.thresholdFor', { alert: label })}
                        value={s.threshold}
                        min={spec.range[0]}
                        max={spec.range[1]}
                        step={spec.unit === 'factor' ? 0.5 : 1}
                        placeholder={spec.unit === 'minutes' && silentFloor !== undefined ? String(silentFloor) : undefined}
                        disabled={!editable || !s.notify}
                        onCommit={(n) => change(kind, { threshold: n === undefined ? undefined : Math.min(spec.range[1], Math.max(spec.range[0], n)) })}
                      />
                      <span className="text-xs text-subtle">{t(`alertsSettings.unit.${spec.unit}` as MessageKey)}</span>
                    </span>
                  ) : (
                    <span className="text-subtle" title={t('alertsSettings.noThreshold')}>
                      —
                    </span>
                  )}
                </td>
                <td className="py-2">
                  <span className="inline-flex gap-1.5" role="group" aria-label={t('alertsSettings.col.channels')}>
                    {HEALTH_ALERT_CHANNELS.map((c) => {
                      const on = s.channels.includes(c)
                      return (
                        <Button
                          key={c}
                          size="sm"
                          variant={on ? 'primary' : 'secondary'}
                          aria-pressed={on}
                          disabled={!editable || !s.notify}
                          onClick={() => change(kind, { channels: on ? s.channels.filter((x) => x !== c) : [...s.channels, c] })}
                        >
                          {t(CHANNEL_LABEL[c])}
                        </Button>
                      )
                    })}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </SettingsGroup>
  )
}

/** Metrics: the notification minimum and the business days of the metric alert rules (the per-metric overrides stay in Health → Alert rules). */
export function MetricsGroup({ profile, editable, save }: { profile: Profile; editable: boolean; save: (rules: ReturnType<typeof alertRulesOf>) => void }) {
  const { t, formatDate } = useI18n()
  const rules = alertRulesOf(profile.health?.alertRules)
  // 2026-01-04 is a Sunday: day `d` of the week is 4 + d.
  const weekday = (d: number) => formatDate(new Date(2026, 0, 4 + d), { weekday: 'short' })
  const toggleDay = (day: number) => {
    const days = rules.businessDays.includes(day) ? rules.businessDays.filter((d) => d !== day) : [...rules.businessDays, day].sort((a, b) => a - b)
    if (days.length) save({ ...rules, businessDays: days })
  }
  return (
    <SettingsGroup title={t('alertsSettings.metrics.title')} help={t('alertsSettings.metrics.help')}>
      <div id="alerts.metrics.severity" data-setting-id="alerts.metrics.severity">
        <SettingRow label={t('metricAlerts.settings.notifyMin')} hint={t('metricAlerts.settings.notifyMinHint')}>
          <Select
            aria-label={t('metricAlerts.settings.notifyMin')}
            value={rules.notifyMinSeverity}
            disabled={!editable}
            onChange={(v) => (ALERT_SEVERITIES as readonly string[]).includes(v) && save({ ...rules, notifyMinSeverity: v as AlertSeverity })}
            options={ALERT_SEVERITIES.map((s) => ({ value: s, label: t(SEVERITY_LABEL[s]) }))}
          />
        </SettingRow>
      </div>
      <div id="alerts.metrics.businessDays" data-setting-id="alerts.metrics.businessDays" className="flex items-center justify-between gap-6 py-3">
        <div className="min-w-0">
          <span className="text-base">{t('metricAlerts.settings.businessDays')}</span>
          <p className="text-xs text-subtle">{t('metricAlerts.settings.businessDaysHint')}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5" role="group" aria-label={t('metricAlerts.settings.businessDays')}>
          {WEEK.map((d) => {
            const on = rules.businessDays.includes(d)
            return (
              <Button key={d} size="sm" variant={on ? 'primary' : 'secondary'} aria-pressed={on} disabled={!editable} onClick={() => toggleDay(d)}>
                {weekday(d)}
              </Button>
            )
          })}
        </div>
      </div>
      <div className="flex items-center justify-between gap-6 py-3">
        <p className="text-xs text-subtle">{t('alertsSettings.metrics.overridesHint', { count: Object.keys(rules.overrides).length })}</p>
        <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />} onClick={() => window.hub.setup.openSettings('health')}>
          {t('alertsSettings.metrics.overrides')}
        </Button>
      </div>
    </SettingsGroup>
  )
}

/** Plan usage: the same switch and thresholds as Settings → Usage → Alerts (app-wide, `options.usageBudget`). */
export function UsageGroup({ snap, run, editable }: { snap: ConfigSnapshot; run: Run; editable: boolean }) {
  const { t } = useI18n()
  const budget = appOptions(snap.config).usageBudget
  const [thresholds, setThresholds] = useState(budget.thresholds.join(', '))
  useEffect(() => setThresholds(budget.thresholds.join(', ')), [budget.thresholds])
  const save = (next: typeof budget) => void run(() => window.hub.config.saveOptions({ usageBudget: next }))
  const parsed = parseThresholds(thresholds)
  return (
    <SettingsGroup title={t('alertsSettings.usage.title')} help={t('help.usage.alerts')}>
      <div id="alerts.usage.on" data-setting-id="alerts.usage.on">
        <SettingRow label={t('agentUsage.settings.alertsOn')} hint={t('agentUsage.settings.alertsHint')}>
          <div className="flex justify-end">
            <Switch checked={budget.alerts} disabled={!editable} aria-label={t('agentUsage.settings.alertsOn')} onChange={(on) => save({ ...budget, alerts: on })} />
          </div>
        </SettingRow>
      </div>
      <div id="alerts.usage.thresholds" data-setting-id="alerts.usage.thresholds">
        <SettingRow label={t('agentUsage.settings.thresholds')} hint={t('agentUsage.settings.thresholdsHint')}>
          <div className="flex gap-2">
            <Input aria-label={t('agentUsage.settings.thresholds')} value={thresholds} disabled={!editable || !budget.alerts} onChange={(e) => setThresholds(e.target.value)} />
            <Button disabled={!editable || parsed.join(',') === budget.thresholds.join(',')} onClick={() => save({ ...budget, thresholds: parsed })}>
              {t('agentUsage.settings.apply')}
            </Button>
          </div>
        </SettingRow>
      </div>
    </SettingsGroup>
  )
}

/** Quiet hours: Health, flow-map and metric alerts wait; sessions and meetings do not. */
export function QuietHoursGroup({ profile, editable, save }: { profile: Profile; editable: boolean; save: (quiet: QuietHours | null) => void }) {
  const { t } = useI18n()
  const quiet = profile.alerts?.quietHours ?? null
  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`
  const options = HOURS.map((h) => ({ value: String(h), label: hour(h) }))
  return (
    <SettingsGroup title={t('alertsSettings.quiet.title')} help={t('alertsSettings.quiet.help')} footnote={t('alertsSettings.quiet.footnote')}>
      <div id="alerts.quiet" data-setting-id="alerts.quiet">
        <SettingRow label={t('alertsSettings.quiet.on')} hint={quiet ? t('alertsSettings.quiet.range', { from: hour(quiet.startHour), to: hour(quiet.endHour) }) : t('alertsSettings.quiet.off')}>
          <div className="flex justify-end">
            <Switch checked={quiet !== null} disabled={!editable} aria-label={t('alertsSettings.quiet.on')} onChange={(on) => save(on ? DEFAULT_QUIET : null)} />
          </div>
        </SettingRow>
      </div>
      {quiet && (
        <>
          <SettingRow label={t('alertsSettings.quiet.from')}>
            <Select aria-label={t('alertsSettings.quiet.from')} value={String(quiet.startHour)} disabled={!editable} options={options} onChange={(v) => save({ ...quiet, startHour: Number(v) })} />
          </SettingRow>
          <SettingRow label={t('alertsSettings.quiet.to')} hint={quiet.startHour === quiet.endHour ? t('alertsSettings.quiet.same') : undefined}>
            <Select aria-label={t('alertsSettings.quiet.to')} value={String(quiet.endHour)} disabled={!editable} options={options} onChange={(v) => save({ ...quiet, endHour: Number(v) })} />
          </SettingRow>
        </>
      )}
    </SettingsGroup>
  )
}
