import { useEffect, useState } from 'react'
import type { AutomationDefinition, EffectiveAgent, WatchedChannel } from '@workhub/core'
import { Button, Input, Select, Switch, Textarea } from '../../components/atoms'
import { Dialog, Field, SwitchRow } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'

const DAYS = [1, 2, 3, 4, 5, 6, 0]
const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : fallback)

export interface AutomationEditorProps {
  automation: AutomationDefinition | null
  agents: EffectiveAgent[]
  channels: WatchedChannel[]
  onClose: () => void
  onSave: (a: AutomationDefinition) => Promise<boolean>
}

/** The automation's form: what it sends, where, when it fires, its limits and its session policy. */
export function AutomationEditor({ automation, agents, channels, onClose, onSave }: AutomationEditorProps) {
  const { t } = useI18n()
  const [form, setForm] = useState<AutomationDefinition | null>(automation)
  useEffect(() => setForm(automation), [automation])
  if (!form) return null
  const set = (patch: Partial<AutomationDefinition>) => setForm({ ...form, ...patch })
  const triggers = form.triggers
  const agentOptions = agents.some((a) => a.key === form.agentKey) ? agents : [...agents, { key: form.agentKey, label: form.agentKey } as EffectiveAgent]

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('automations.editor.title')}
      className="w-[min(720px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void onSave(form).then((ok) => ok && onClose())}>
            {t('automations.editor.save')}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
        <Field label={t('automations.field.name')}>
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t('automations.field.prompt')} hint={t('automations.field.promptHint')}>
          <Textarea rows={3} value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('automations.field.agent')}>
            <Select value={form.agentKey} onChange={(agentKey) => set({ agentKey })} options={agentOptions.map((a) => ({ value: a.key, label: a.label }))} />
          </Field>
          <Field label={t('automations.field.folder')}>
            <Input value={form.folder} onChange={(e) => set({ folder: e.target.value })} />
          </Field>
          <Field label={t('automations.field.view')}>
            <Select
              value={form.view}
              onChange={(v) => set({ view: v === 'console' ? 'console' : 'app' })}
              options={[
                { value: 'app', label: t('automations.view.app') },
                { value: 'console', label: t('automations.view.console') }
              ]}
            />
          </Field>
          <Field label={t('automations.field.policy')} hint={t(form.sessionPolicy === 'reuse' ? 'automations.policy.reuseHint' : 'automations.policy.newEachRunHint')}>
            <Select
              value={form.sessionPolicy}
              onChange={(v) => set({ sessionPolicy: v === 'newEachRun' ? 'newEachRun' : 'reuse' })}
              options={[
                { value: 'reuse', label: t('automations.policy.reuse') },
                { value: 'newEachRun', label: t('automations.policy.newEachRun') }
              ]}
            />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-muted">{t('automations.field.chatTrigger')}</legend>
          {channels.length === 0 && <p className="text-sm text-subtle">{t('automations.noChannels')}</p>}
          {channels.map((c) => (
            <SwitchRow key={c.id} label={`#${c.name}`} hint={c.purpose || undefined}>
              <Switch
                checked={triggers.chatChannelIds.includes(c.id)}
                onChange={(on) => set({ triggers: { ...triggers, chatChannelIds: on ? [...triggers.chatChannelIds, c.id] : triggers.chatChannelIds.filter((x) => x !== c.id) } })}
              />
            </SwitchRow>
          ))}
          <Field label={t('automations.field.prOwner')} hint={t('automations.field.prOwnerHint')}>
            <Input value={triggers.prOwner} onChange={(e) => set({ triggers: { ...triggers, prOwner: e.target.value.trim() } })} />
          </Field>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('automations.field.interval')} hint={t('automations.field.intervalHint')}>
            <Input
              type="number"
              min={1}
              value={triggers.intervalMinutes ?? ''}
              onChange={(e) => set({ triggers: { ...triggers, intervalMinutes: e.target.value.trim() ? Math.max(1, num(e.target.value, 1)) : null } })}
            />
          </Field>
          <Field label={t('automations.field.maxRuns')}>
            <Input type="number" min={1} value={form.limits.maxRuns} onChange={(e) => set({ limits: { ...form.limits, maxRuns: Math.max(1, num(e.target.value, 1)) } })} />
          </Field>
          <Field label={t('automations.field.perMinutes')}>
            <Input type="number" min={1} value={form.limits.perMinutes} onChange={(e) => set({ limits: { ...form.limits, perMinutes: Math.max(1, num(e.target.value, 1)) } })} />
          </Field>
          <Field label={t('automations.field.maxPerDay')}>
            <Input type="number" min={1} value={form.limits.maxPerDay ?? ''} onChange={(e) => set({ limits: { ...form.limits, maxPerDay: e.target.value.trim() ? Math.max(1, num(e.target.value, 1)) : null } })} />
          </Field>
          <Field label={t('automations.field.usage')}>
            <Input type="number" min={1} max={100} value={form.usageThreshold} onChange={(e) => set({ usageThreshold: Math.min(100, Math.max(1, num(e.target.value, 85))) })} />
          </Field>
          <Field label={t('automations.field.timeout')}>
            <Input type="number" min={1} value={form.runTimeoutMinutes} onChange={(e) => set({ runTimeoutMinutes: Math.max(1, num(e.target.value, 30)) })} />
          </Field>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('automations.field.hours')}>
            <div className="flex items-center gap-2">
              <Input type="number" min={0} max={23} className="w-20" aria-label={t('slack.settings.from')} value={form.window.startHour} onChange={(e) => set({ window: { ...form.window, startHour: num(e.target.value, 9) } })} />
              <span className="text-sm text-muted">–</span>
              <Input type="number" min={1} max={24} className="w-20" aria-label={t('slack.settings.to')} value={form.window.endHour} onChange={(e) => set({ window: { ...form.window, endHour: num(e.target.value, 19) } })} />
            </div>
          </Field>
          <div className="flex flex-wrap gap-1">
            {DAYS.map((d) => {
              const on = form.window.days.includes(d)
              return (
                <Button key={d} size="sm" variant={on ? 'primary' : 'secondary'} aria-pressed={on} onClick={() => set({ window: { ...form.window, days: on ? form.window.days.filter((x) => x !== d) : [...form.window.days, d].sort() } })}>
                  {t(`slack.day.${d}` as 'slack.day.0')}
                </Button>
              )
            })}
          </div>
        </div>

        <SwitchRow label={t('automations.field.receivesReplies')} hint={t('automations.field.receivesRepliesHint')}>
          <Switch checked={form.receivesChatReplies} onChange={(receivesChatReplies) => set({ receivesChatReplies })} />
        </SwitchRow>
        <SwitchRow label={t('automations.field.enabled')}>
          <Switch checked={form.enabled} onChange={(enabled) => set({ enabled })} />
        </SwitchRow>
      </div>
    </Dialog>
  )
}
