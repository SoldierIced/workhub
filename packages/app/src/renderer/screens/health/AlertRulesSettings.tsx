import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ALERT_SEVERITIES, DEFAULT_HEALTH_REFRESH_MINUTES, HEALTH_METRICS, METRIC_ALERT_THRESHOLD_RANGES, type AlertThresholds, type Profile, type Result, type WorkhubConfig } from '@workhub/core'
import { Button, Input, Select, Switch } from '../../components/atoms'
import { Card, CardBody, CardHeader, Field } from '../../components/molecules'
import { useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { alertRulesToForm, formToAlertRules, OVERRIDE_FIELDS, SEVERITY_LABEL, type AlertRulesForm, type OverrideForm } from '../../lib/metricAlerts'
import { isDirty } from '../../lib/unsavedChanges'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

const THRESHOLD_KEYS = Object.keys(METRIC_ALERT_THRESHOLD_RANGES) as (keyof AlertThresholds)[]
/** Monday first; 0 is Sunday. */
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const EMPTY_OVERRIDE: OverrideForm = { metric: '', minVolume: '', jumpPct: '', rateDropPoints: '', critical: false, muted: false }

/** Settings → Health → Alert rules: default thresholds, business days, the notification minimum and per-metric overrides. Saved with the save bar. */
export function AlertRulesSettings({ profile, editable, run }: { profile: Profile; editable: boolean; run: Run }) {
  const { t, formatDate } = useI18n()
  const [form, setForm] = useState<AlertRulesForm>(() => alertRulesToForm(profile.health?.alertRules))
  const [baseline, setBaseline] = useState<AlertRulesForm>(form)

  useEffect(() => {
    const next = alertRulesToForm(profile.health?.alertRules)
    setForm(next)
    setBaseline(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])

  useUnsavedForm({
    dirty: isDirty(baseline, form),
    draft: form,
    save: async () => {
      const alertRules = formToAlertRules(form)
      // Read the profile fresh: the environments form may have been saved a moment ago by the same save bar.
      const ok = await run(async () => {
        const latest = (await window.hub.config.get()).config.profiles.find((p) => p.id === profile.id) ?? profile
        return window.hub.config.saveProfile({ ...latest, health: { refreshMinutes: DEFAULT_HEALTH_REFRESH_MINUTES, environments: [], ...latest.health, alertRules } })
      })
      if (!ok) return { ok: false }
      const saved = alertRulesToForm(alertRules)
      setForm(saved)
      setBaseline(saved)
      return { ok: true }
    },
    discard: () => setForm(baseline)
  })

  const setThreshold = (key: keyof AlertThresholds, value: number) => setForm((f) => ({ ...f, thresholds: { ...f.thresholds, [key]: value } }))
  const toggleDay = (day: number) => setForm((f) => ({ ...f, businessDays: f.businessDays.includes(day) ? f.businessDays.filter((d) => d !== day) : [...f.businessDays, day].sort((a, b) => a - b) }))
  const updateOverride = (index: number, patch: Partial<OverrideForm>) => setForm((f) => ({ ...f, overrides: f.overrides.map((o, i) => (i === index ? { ...o, ...patch } : o)) }))
  // 2026-01-04 is a Sunday: day `d` of the week is 4 + d.
  const weekday = (d: number) => formatDate(new Date(2026, 0, 4 + d), { weekday: 'short' })

  return (
    <Card>
      <CardHeader
        title={t('metricAlerts.settings.title')}
        help={t('metricAlerts.settings.help')}
        actions={
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} disabled={!editable} onClick={() => setForm((f) => ({ ...f, overrides: [...f.overrides, { ...EMPTY_OVERRIDE }] }))}>
            {t('metricAlerts.settings.addOverride')}
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <p className="text-xs text-subtle">{t('metricAlerts.settings.intro')}</p>
        <div className="grid grid-cols-2 gap-4">
          {THRESHOLD_KEYS.map((key) => (
            <Field key={key} label={t(`metricAlerts.settings.threshold.${key}` as MessageKey)} hint={t(`metricAlerts.settings.thresholdHint.${key}` as MessageKey)}>
              <Input
                type="number"
                min={METRIC_ALERT_THRESHOLD_RANGES[key][0]}
                max={METRIC_ALERT_THRESHOLD_RANGES[key][1]}
                step={key === 'jumpStdDevs' || key === 'rateDropPoints' ? 0.5 : 1}
                value={form.thresholds[key]}
                disabled={!editable}
                onChange={(e) => setThreshold(key, Number(e.target.value))}
              />
            </Field>
          ))}
        </div>
        <Field label={t('metricAlerts.settings.businessDays')} hint={t('metricAlerts.settings.businessDaysHint')}>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('metricAlerts.settings.businessDays')}>
            {WEEK.map((d) => {
              const on = form.businessDays.includes(d)
              return (
                <Button key={d} size="sm" variant={on ? 'primary' : 'secondary'} aria-pressed={on} disabled={!editable} onClick={() => toggleDay(d)}>
                  {weekday(d)}
                </Button>
              )
            })}
          </div>
        </Field>
        <Field label={t('metricAlerts.settings.notifyMin')} hint={t('metricAlerts.settings.notifyMinHint')} className="max-w-72">
          <Select
            value={form.notifyMinSeverity}
            disabled={!editable}
            onChange={(v) => setForm((f) => ({ ...f, notifyMinSeverity: (ALERT_SEVERITIES as readonly string[]).includes(v) ? (v as AlertRulesForm['notifyMinSeverity']) : f.notifyMinSeverity }))}
            options={ALERT_SEVERITIES.map((s) => ({ value: s, label: t(SEVERITY_LABEL[s]) }))}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted">{t('metricAlerts.settings.overrides')}</h3>
          {form.overrides.length === 0 && <p className="text-xs text-subtle">{t('metricAlerts.settings.noOverrides')}</p>}
          <datalist id="metric-alert-ids">
            {HEALTH_METRICS.map((m) => (
              <option key={m.id} value={m.id} />
            ))}
          </datalist>
          {form.overrides.map((o, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] items-end gap-2 rounded-md border border-border p-2">
              <Field label={t('metricAlerts.settings.metric')}>
                <Input value={o.metric} list="metric-alert-ids" placeholder="health.errors" spellCheck={false} className="font-mono" disabled={!editable} onChange={(e) => updateOverride(i, { metric: e.target.value })} />
              </Field>
              {OVERRIDE_FIELDS.map((k) => (
                <Field key={k} label={t(`metricAlerts.settings.threshold.${k}` as MessageKey)}>
                  <Input type="number" value={o[k]} placeholder={String(form.thresholds[k])} disabled={!editable} onChange={(e) => updateOverride(i, { [k]: e.target.value })} />
                </Field>
              ))}
              <button
                type="button"
                aria-label={t('metricAlerts.settings.removeOverride', { metric: o.metric || '—' })}
                className="mb-1 inline-flex size-6 items-center justify-center rounded-sm text-subtle hover:bg-danger-soft hover:text-danger"
                disabled={!editable}
                onClick={() => setForm((f) => ({ ...f, overrides: f.overrides.filter((_, j) => j !== i) }))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
              <div className="col-span-5 flex flex-wrap items-center gap-4 text-sm text-muted">
                <span className="inline-flex items-center gap-2">
                  <Switch checked={o.critical} disabled={!editable} onChange={(on) => updateOverride(i, { critical: on })} aria-label={t('metricAlerts.settings.critical')} />
                  {t('metricAlerts.settings.critical')}
                </span>
                <span className="inline-flex items-center gap-2">
                  <Switch checked={o.muted} disabled={!editable} onChange={(on) => updateOverride(i, { muted: on })} aria-label={t('metricAlerts.settings.muted')} />
                  {t('metricAlerts.settings.muted')}
                </span>
              </div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}
