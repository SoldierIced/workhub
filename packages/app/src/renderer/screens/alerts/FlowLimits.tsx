import { Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { flowThresholds, formatMs, type FlowMap, type FlowMapReading, type Profile } from '@workhub/core'
import { Badge, Button, Input, Select, Switch } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { SettingsGroup } from '../settings/SettingsLayout'
import { DEFAULT_FLOW_MIN_CALLS, draftMap, flowLimitsToForm, formToFlowAlerts, mapNow, measuredParts, nowTone, saveFlowLimits, slowShareNow, timingOf, type FlowLimitsForm, type NowTone } from './alertsForm'

/** One map of the folder with what the table needs: the map, the environment that measures it and the last stored hour. */
export interface FlowLimitsEntry {
  map: FlowMap
  environmentName: string | null
  reading?: FlowMapReading
}

const rate = (r: number | undefined) => (r === undefined ? '—' : `${(r * 100).toFixed(1)} %`)
/** A share (0–1) as the percentage the inputs take, without float noise. */
const asPct = (r: number | undefined) => (r === undefined ? '' : String(Math.round(r * 10_000) / 100))

const OVER_LABEL = { flowSlow: 'alertsSettings.flow.overP95', flowErrors: 'alertsSettings.flow.overFailures', flowSlowShare: 'alertsSettings.flow.overSlowShare' } as const

/** The tone tag of the "Now" column. */
export function NowTag({ tone }: { tone: NowTone }) {
  const { t } = useI18n()
  if (tone.kind === 'none') return <span className="text-xs text-subtle">{t('alertsSettings.flow.noData')}</span>
  if (tone.kind === 'ok') return <Badge tone="success">{t('alertsSettings.flow.ok')}</Badge>
  return (
    <span className="inline-flex gap-1">
      {tone.over.map((k) => (
        <Badge key={k} tone="danger">
          {t(OVER_LABEL[k])}
        </Badge>
      ))}
    </span>
  )
}

/**
 * The limits table of one map: the default row (p95, failure share, share of calls slower than a
 * duration, notify), the minimum calls and
 * one row per part with its own limits (blank inherits). "Now" is the last stored hour against the
 * limits as typed.
 */
export function FlowMapLimitsTable({
  entry,
  form,
  editable,
  dirty,
  saving,
  error,
  onChange,
  onSave
}: {
  entry: FlowLimitsEntry
  form: FlowLimitsForm
  editable: boolean
  dirty: boolean
  saving?: boolean
  error?: string | null
  onChange: (form: FlowLimitsForm) => void
  onSave: () => void
}) {
  const { t } = useI18n()
  const { map, reading } = entry
  const parts = useMemo(() => measuredParts(map), [map])
  const draft = useMemo(() => draftMap(map, form), [map, form])
  const now = mapNow(draft, reading)
  const parsed = formToFlowAlerts(form)
  const invalid = !parsed.ok
  const free = parts.filter((p) => !form.parts.some((r) => r.key === p.key))
  const [adding, setAdding] = useState('')
  const setPart = (key: string, patch: Partial<FlowLimitsForm['parts'][number]>) => onChange({ ...form, parts: form.parts.map((r) => (r.key === key ? { ...r, ...patch } : r)) })
  const cell = 'py-1.5 pr-2 align-middle'
  const input = 'h-7 w-24 text-xs'
  return (
    <div id={`alerts.flow.${map.id}`} data-setting-id={`alerts.flow.${map.id}`} className="flex flex-col gap-2 py-3" data-testid={`flow-limits-${map.id}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base font-medium">{map.name}</span>
          <Badge tone="info">{entry.environmentName ?? t('alertsSettings.flow.everyEnvironment')}</Badge>
        </span>
        <Button size="sm" variant="primary" disabled={!editable || !dirty || invalid || saving} onClick={onSave}>
          {t('alertsSettings.flow.save')}
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 font-medium">{t('alertsSettings.flow.part')}</th>
            <th className="py-1 font-medium">{t('alertsSettings.flow.p95')}</th>
            <th className="py-1 font-medium">{t('alertsSettings.flow.failures')}</th>
            <th className="py-1 font-medium" title={t('alertsSettings.flow.slowHelp')}>{t('alertsSettings.flow.slowMs')}</th>
            <th className="py-1 font-medium" title={t('alertsSettings.flow.slowHelp')}>{t('alertsSettings.flow.slowPct')}</th>
            <th className="py-1 font-medium">{t('alertsSettings.col.notify')}</th>
            <th className="py-1 font-medium">{t('alertsSettings.flow.now')}</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-border">
            <td className={cell}>{t('alertsSettings.flow.default')}</td>
            <td className={cell}>
              <Input type="number" min={1} className={input} aria-label={t('alertsSettings.flow.p95For', { part: t('alertsSettings.flow.default') })} value={form.p95Ms} disabled={!editable} onChange={(e) => onChange({ ...form, p95Ms: e.target.value })} />
            </td>
            <td className={cell}>
              <Input type="number" min={0} max={100} step={0.5} className={input} aria-label={t('alertsSettings.flow.failuresFor', { part: t('alertsSettings.flow.default') })} value={form.errorPct} disabled={!editable} onChange={(e) => onChange({ ...form, errorPct: e.target.value })} />
            </td>
            <td className={cell}>
              <Input type="number" min={1} className={input} aria-label={t('alertsSettings.flow.slowMsFor', { part: t('alertsSettings.flow.default') })} value={form.slowMs} disabled={!editable} onChange={(e) => onChange({ ...form, slowMs: e.target.value })} />
            </td>
            <td className={cell}>
              <Input type="number" min={0} max={100} step={1} className={input} placeholder={form.slowMs.trim() ? '0' : ''} aria-label={t('alertsSettings.flow.slowPctFor', { part: t('alertsSettings.flow.default') })} value={form.slowPct} disabled={!editable} onChange={(e) => onChange({ ...form, slowPct: e.target.value })} />
            </td>
            <td className={cell}>
              <Switch checked={form.notify} disabled={!editable} aria-label={t('alertsSettings.flow.notifyFor', { map: map.name })} onChange={(on) => onChange({ ...form, notify: on })} />
            </td>
            <td className={cell}>
              <span className="inline-flex items-center gap-2 text-xs tabular-nums">
                <span>{now.p95Ms === undefined ? '—' : formatMs(now.p95Ms)}</span>
                <span className="text-subtle">{rate(now.errorRate)}</span>
                {now.slowShare !== undefined && <span className="text-subtle" title={t('alertsSettings.flow.slowNow')}>{t('alertsSettings.flow.slowShareNow', { share: rate(now.slowShare) })}</span>}
                <NowTag tone={now.tone} />
              </span>
            </td>
            <td />
          </tr>
          {form.parts.map((row) => {
            const part = parts.find((p) => p.key === row.key)
            const label = part?.label ?? row.key
            const timing = part ? timingOf(reading, part) : undefined
            const inherited = draft.alerts
            const ownSlow = part ? flowThresholds(draft, part).slowMs : undefined
            const share = slowShareNow(timing, ownSlow)
            return (
              <tr key={row.key} className="border-t border-border" data-part={row.key}>
                <td className={`${cell} pl-3`}>{label}</td>
                <td className={cell}>
                  <Input type="number" min={1} className={input} placeholder={inherited?.p95Ms !== undefined ? String(inherited.p95Ms) : ''} aria-label={t('alertsSettings.flow.p95For', { part: label })} value={row.p95Ms} disabled={!editable} onChange={(e) => setPart(row.key, { p95Ms: e.target.value })} />
                </td>
                <td className={cell}>
                  <Input type="number" min={0} max={100} step={0.5} className={input} placeholder={inherited?.errorRate !== undefined ? String(Math.round(inherited.errorRate * 10_000) / 100) : ''} aria-label={t('alertsSettings.flow.failuresFor', { part: label })} value={row.errorPct} disabled={!editable} onChange={(e) => setPart(row.key, { errorPct: e.target.value })} />
                </td>
                <td className={cell}>
                  <Input type="number" min={1} className={input} placeholder={inherited?.slowMs !== undefined ? String(inherited.slowMs) : ''} aria-label={t('alertsSettings.flow.slowMsFor', { part: label })} value={row.slowMs} disabled={!editable} onChange={(e) => setPart(row.key, { slowMs: e.target.value })} />
                </td>
                <td className={cell}>
                  <Input type="number" min={0} max={100} step={1} className={input} placeholder={asPct(inherited?.slowShare)} aria-label={t('alertsSettings.flow.slowPctFor', { part: label })} value={row.slowPct} disabled={!editable} onChange={(e) => setPart(row.key, { slowPct: e.target.value })} />
                </td>
                <td />
                <td className={cell}>
                  <span className="inline-flex items-center gap-2 text-xs tabular-nums">
                    <span>{timing && timing.count > 0 ? formatMs(timing.p95Ms) : '—'}</span>
                    <span className="text-subtle">{timing && timing.count > 0 ? rate(timing.errorRate) : ''}</span>
                    {share !== undefined && <span className="text-subtle" title={t('alertsSettings.flow.slowNow')}>{t('alertsSettings.flow.slowShareNow', { share: rate(share) })}</span>}
                    <NowTag tone={part ? nowTone(timing, flowThresholds(draft, part)) : { kind: 'none' }} />
                  </span>
                </td>
                <td className={cell}>
                  <button
                    type="button"
                    aria-label={t('alertsSettings.flow.removePart', { part: label })}
                    className="inline-flex size-6 items-center justify-center rounded-sm text-subtle hover:bg-danger-soft hover:text-danger"
                    disabled={!editable}
                    onClick={() => onChange({ ...form, parts: form.parts.filter((r) => r.key !== row.key) })}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-3">
        {free.length > 0 && (
          <span className="inline-flex items-center gap-2">
            <Select className="w-56" aria-label={t('alertsSettings.flow.pickPart')} placeholder={t('alertsSettings.flow.pickPart')} value={adding} disabled={!editable} options={free.map((p) => ({ value: p.key, label: p.label }))} onChange={setAdding} />
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" aria-hidden />}
              disabled={!editable || !adding}
              onClick={() => {
                onChange({ ...form, parts: [...form.parts, { key: adding, p95Ms: '', errorPct: '', slowMs: '', slowPct: '' }] })
                setAdding('')
              }}
            >
              {t('alertsSettings.flow.addPart')}
            </Button>
          </span>
        )}
        <label className="inline-flex items-center gap-2 text-xs text-muted">
          {t('alertsSettings.flow.minCalls')}
          <Input type="number" min={0} className={input} placeholder={String(DEFAULT_FLOW_MIN_CALLS)} aria-label={t('alertsSettings.flow.minCalls')} value={form.minCalls} disabled={!editable} onChange={(e) => onChange({ ...form, minCalls: e.target.value })} />
        </label>
      </div>
      {invalid && <p className="text-xs text-danger">{t('alertsSettings.flow.invalid')}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

/** Flow maps · limits: every valid map of the folder, grouped by `group` (maps without one last). */
export function FlowLimitsGroup({ profile, editable }: { profile: Profile; editable: boolean }) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<FlowLimitsEntry[] | null>(null)
  const [forms, setForms] = useState<Record<string, FlowLimitsForm>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const envs = profile.health?.environments

  const load = useCallback(async () => {
    const summaries = (await window.hub.health.flowMaps(profile.id)).filter((s) => !s.error)
    const list: FlowLimitsEntry[] = []
    for (const s of summaries) {
      const map = await window.hub.flowMaps.get(s.id)
      if (!map) continue
      // The environment the map names, else the first one (a map without one is listed under every environment).
      const env = (envs ?? []).find((e) => e.id === map.environmentId) ?? (map.environmentId ? undefined : envs?.[0])
      const read = env ? await window.hub.health.flowMap(profile.id, env.id, map.id, 1, false, true) : null
      list.push({ map, environmentName: map.environmentId ? (env?.name ?? map.environmentId) : null, ...(read?.ok && read.reading ? { reading: read.reading } : {}) })
    }
    setEntries(list)
    setForms(Object.fromEntries(list.map((e) => [e.map.id, flowLimitsToForm(e.map.alerts)])))
  }, [profile.id, envs])

  useEffect(() => {
    void load().catch(() => setEntries([]))
  }, [load])

  const save = async (entry: FlowLimitsEntry) => {
    const form = forms[entry.map.id]
    if (!form) return
    setSaving(entry.map.id)
    try {
      const r = await saveFlowLimits(window.hub.flowMaps, profile.id, entry.map.id, form)
      if ('errors' in r) setErrors((e) => ({ ...e, [entry.map.id]: r.errors.join('; ') }))
      else if (r.ok) {
        setErrors(({ [entry.map.id]: _gone, ...rest }) => rest)
        await load()
      }
    } finally {
      setSaving(null)
    }
  }

  const groups = useMemo(() => {
    const by = new Map<string, FlowLimitsEntry[]>()
    for (const e of entries ?? []) by.set(e.map.group ?? '', [...(by.get(e.map.group ?? '') ?? []), e])
    return [...by.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
  }, [entries])

  return (
    <div className="relative" id="alerts.flow">
      <Badge tone="accent" className="absolute right-1 top-0.5">
        {t('alertsSettings.new')}
      </Badge>
      <SettingsGroup title={t('alertsSettings.flow.title')} help={t('alertsSettings.flow.help')} footnote={t('alertsSettings.flow.footnote', { count: DEFAULT_FLOW_MIN_CALLS })}>
        {entries === null ? (
          <p className="py-3 text-sm text-subtle">{t('alertsSettings.flow.loading')}</p>
        ) : entries.length === 0 ? (
          <p className="py-3 text-sm text-subtle">{t('alertsSettings.flow.none')}</p>
        ) : (
          groups.map(([group, list]) => (
            <div key={group || '-'} className="py-2">
              <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted">{group || t('alertsSettings.flow.otherGroup')}</h3>
              {list.map((entry) => {
                const form = forms[entry.map.id] ?? flowLimitsToForm(entry.map.alerts)
                const dirty = JSON.stringify(form) !== JSON.stringify(flowLimitsToForm(entry.map.alerts))
                return (
                  <FlowMapLimitsTable
                    key={entry.map.id}
                    entry={entry}
                    form={form}
                    editable={editable}
                    dirty={dirty}
                    saving={saving === entry.map.id}
                    error={errors[entry.map.id] ?? null}
                    onChange={(next) => setForms((f) => ({ ...f, [entry.map.id]: next }))}
                    onSave={() => void save(entry)}
                  />
                )
              })}
            </div>
          ))
        )}
      </SettingsGroup>
    </div>
  )
}
