import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  MIN_WATCH_INTERVAL_MINUTES,
  type ChatWatcherSettings,
  type Result,
  type WorkhubConfig
} from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import { Badge, Button, IconButton, Input, Select, Switch } from '../components/atoms'
import { Card, CardBody, CardHeader, Field, SwitchRow, useToast } from '../components/molecules'
import { reloadSlack, useSlack } from '../chatStore'
import { useI18n } from '../i18n/I18nProvider'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

const DAYS = [1, 2, 3, 4, 5, 6, 0]

/** Settings → Slack: what the watcher reads, when, with which account, and the tracking hook per account. */
export function SlackSettings({ snap, run }: { snap: ConfigSnapshot; run: Run }) {
  const { t } = useI18n()
  const toast = useToast()
  const slack = useSlack()
  const [form, setForm] = useState<ChatWatcherSettings | null>(null)
  useEffect(() => {
    if (slack && !form) setForm(structuredClone(slack.settings))
  }, [slack, form])
  if (!slack || !form) return null

  const set = (patch: Partial<ChatWatcherSettings>) => setForm({ ...form, ...patch })
  const save = async () => {
    const settings = { ...form, channels: form.channels.map((c) => ({ ...c, id: c.id.trim(), name: c.name.trim() || c.id.trim() })) }
    if (await run(() => window.hub.slack.saveSettings(settings))) void reloadSlack()
  }
  const accounts = slack.hooks.map((h) => ({ value: h.accountId ?? '', label: h.name }))
  const setHook = async (accountId: string | null, install: boolean) => {
    const r = await window.hub.slack.setHook(accountId, install)
    if (!r.ok) toast(r.error === 'demoMode' ? t('slack.hook.demoMode') : r.error, 'danger')
  }
  void snap

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('slack.settings.watcher')} meta={slack.demo ? <Badge tone="info">{t('slack.demo')}</Badge> : undefined} />
        <CardBody className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('slack.settings.explain')}</p>
          <SwitchRow label={t('slack.settings.enabled')}>
            <Switch checked={form.enabled} onChange={(enabled) => set({ enabled })} />
          </SwitchRow>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('slack.settings.account')}>
              <Select value={form.accountId ?? ''} onChange={(v) => set({ accountId: v || null })} options={accounts} />
            </Field>
            <Field label={t('slack.settings.model')}>
              <Input value={form.model} onChange={(e) => set({ model: e.target.value })} />
            </Field>
            <Field label={t('slack.settings.interval')} hint={t('slack.settings.intervalHint', { min: MIN_WATCH_INTERVAL_MINUTES })}>
              <Input type="number" min={MIN_WATCH_INTERVAL_MINUTES} value={form.intervalMinutes} onChange={(e) => set({ intervalMinutes: Math.max(MIN_WATCH_INTERVAL_MINUTES, Number(e.target.value) || MIN_WATCH_INTERVAL_MINUTES) })} />
            </Field>
            <Field label={t('slack.settings.usage')} hint={t('slack.settings.usageHint')}>
              <Input type="number" min={1} max={100} value={form.usageThreshold} onChange={(e) => set({ usageThreshold: Math.min(100, Math.max(1, Number(e.target.value) || 85)) })} />
            </Field>
            <Field label={t('slack.settings.hours')}>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={23} className="w-20" aria-label={t('slack.settings.from')} value={form.startHour} onChange={(e) => set({ startHour: Number(e.target.value) })} />
                <span className="text-sm text-muted">–</span>
                <Input type="number" min={1} max={24} className="w-20" aria-label={t('slack.settings.to')} value={form.endHour} onChange={(e) => set({ endHour: Number(e.target.value) })} />
              </div>
            </Field>
          </div>
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="mb-1 text-sm font-medium text-muted">{t('slack.settings.days')}</legend>
            {DAYS.map((d) => {
              const on = form.weekdays.includes(d)
              return (
                <Button key={d} size="sm" variant={on ? 'primary' : 'secondary'} aria-pressed={on} onClick={() => set({ weekdays: on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d].sort() })}>
                  {t(`slack.day.${d}` as 'slack.day.0')}
                </Button>
              )
            })}
          </fieldset>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-muted">{t('slack.settings.channels')}</span>
            {form.channels.map((c, i) => (
              <div key={i} className="flex gap-2">
                <Input className="w-40" placeholder="C0123456789" aria-label={t('slack.settings.channelId')} value={c.id} onChange={(e) => set({ channels: form.channels.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)) })} />
                <Input className="w-40" placeholder={t('slack.settings.channelName')} aria-label={t('slack.settings.channelName')} value={c.name} onChange={(e) => set({ channels: form.channels.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <Input className="flex-1" placeholder={t('slack.settings.purpose')} aria-label={t('slack.settings.purpose')} value={c.purpose} onChange={(e) => set({ channels: form.channels.map((x, j) => (j === i ? { ...x, purpose: e.target.value } : x)) })} />
                <IconButton label={t('common.delete')} icon={<Trash2 className="size-3.5" />} onClick={() => set({ channels: form.channels.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <Button size="sm" variant="secondary" className="self-start" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => set({ channels: [...form.channels, { id: '', name: '', purpose: '' }] })}>
              {t('slack.settings.addChannel')}
            </Button>
          </div>
          <Button variant="primary" className="self-start" onClick={() => void save()}>
            {t('slack.settings.save')}
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('slack.hook.title')} />
        <CardBody className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('slack.hook.explain')}</p>
          {slack.demo && <p className="text-sm text-warning">{t('slack.hook.demoMode')}</p>}
          <ul className="flex flex-col gap-2">
            {slack.hooks.map((h) => (
              <li key={h.accountId ?? 'default'} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-base">{h.name}</div>
                  <div className="truncate text-xs text-subtle">{h.configDir}</div>
                </div>
                <Badge tone={h.status.state === 'installed' ? 'success' : h.status.state === 'unreadable' ? 'danger' : 'neutral'}>{t(`slack.hook.${h.status.state}`)}</Badge>
                {h.status.state === 'installed' ? (
                  <Button size="sm" variant="secondary" disabled={slack.demo} onClick={() => void setHook(h.accountId, false)}>
                    {t('slack.hook.remove')}
                  </Button>
                ) : (
                  <Button size="sm" disabled={slack.demo || h.status.state === 'unreadable'} onClick={() => void setHook(h.accountId, true)}>
                    {t('slack.hook.install')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  )
}
