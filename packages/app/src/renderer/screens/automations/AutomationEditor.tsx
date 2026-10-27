import { useEffect, useState } from 'react'
import { AUTOMATION_EFFORTS, CLAUDE_PERMISSION_MODES, type AutomationDefinition, type EffectiveAgent, type WatchedChannel } from '@workhub/core'
import type { AgentOptionsView } from '@shared/api'
import { Button, Input, Select, Switch, Textarea } from '../../components/atoms'
import { Dialog, Field, SwitchRow } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'

const DAYS = [1, 2, 3, 4, 5, 6, 0]
/** Keeps a stored pick visible when the agent's list no longer (or not yet) offers it. */
function withCurrent(list: { value: string; label: string }[], current: string | undefined) {
  return current && !list.some((o) => o.value === current) ? [...list, { value: current, label: current }] : list
}

/** The models and modes the chosen agent offers (its CLI's listing, or what its last session reported). */
function useAgentOptions(agentKey: string): { options: AgentOptionsView | null } {
  const [options, setOptions] = useState<AgentOptionsView | null>(null)
  useEffect(() => {
    let live = true
    setOptions(null)
    void window.hub.agents.options(agentKey).then(
      (o) => live && setOptions(o),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [agentKey])
  return { options }
}

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
  const [otherChannel, setOtherChannel] = useState('')
  useEffect(() => setForm(automation), [automation])
  if (!form) return null
  const set = (patch: Partial<AutomationDefinition>) => setForm({ ...form, ...patch })
  const triggers = form.triggers
  const chosen = agents.find((a) => a.key === form.agentKey)
  const native = chosen?.agent.adapter === 'native'
  const { options } = useAgentOptions(form.agentKey)
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
            <Select value={form.agentKey} onChange={(agentKey) => set({ agentKey, model: undefined, effort: undefined, permissionMode: undefined })} options={agentOptions.map((a) => ({ value: a.key, label: a.label }))} />
          </Field>
          <Field label={t('automations.field.folder')}>
            <Input value={form.folder} onChange={(e) => set({ folder: e.target.value })} />
          </Field>
          <Field label={t('automations.field.model')}>
            <Select
              value={form.model ?? ''}
              onChange={(model) => set({ model: model || undefined })}
              options={[{ value: '', label: t('automations.option.default') }, ...withCurrent(options?.models.map((m) => ({ value: m.id, label: m.name })) ?? [], form.model)]}
            />
          </Field>
          {native && (
            <Field label={t('automations.field.effort')}>
              <Select
                value={form.effort ?? ''}
                onChange={(effort) => set({ effort: effort || undefined })}
                options={[{ value: '', label: t('automations.option.default') }, ...AUTOMATION_EFFORTS.map((e) => ({ value: e, label: t(`automations.effort.${e}` as 'automations.effort.low') }))]}
              />
            </Field>
          )}
          {(native || (options?.modes.length ?? 0) > 0) && (
            <Field label={t('automations.field.permission')} hint={t('automations.field.permissionHint')}>
              <Select
                value={form.permissionMode ?? ''}
                onChange={(permissionMode) => set({ permissionMode: permissionMode || undefined })}
                options={[
                  { value: '', label: t('automations.option.default') },
                  ...withCurrent(
                    native ? CLAUDE_PERMISSION_MODES.map((m) => ({ value: m, label: t(`automations.permission.${m}` as 'automations.permission.default') })) : (options?.modes.map((m) => ({ value: m.id, label: m.name })) ?? []),
                    form.permissionMode
                  )
                ]}
              />
            </Field>
          )}
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
          {triggers.chatChannelIds
            .filter((id) => !channels.some((c) => c.id === id))
            .map((id) => (
              <div key={id} className="flex items-center gap-2 text-sm text-warning">
                <span className="min-w-0 flex-1 truncate">{t('automations.channel.unwatched', { id })}</span>
                <Button size="sm" variant="ghost" onClick={() => set({ triggers: { ...triggers, chatChannelIds: triggers.chatChannelIds.filter((x) => x !== id) } })}>
                  {t('automations.channel.remove')}
                </Button>
              </div>
            ))}
          <Field label={t('automations.field.otherChannel')} hint={t('automations.field.otherChannelHint')}>
            <Input
              placeholder="C0123456789"
              value={otherChannel}
              onChange={(e) => setOtherChannel(e.target.value)}
              onKeyDown={(e) => {
                const id = otherChannel.trim().toUpperCase()
                if (e.key !== 'Enter' || !id) return
                e.preventDefault()
                if (!triggers.chatChannelIds.includes(id)) set({ triggers: { ...triggers, chatChannelIds: [...triggers.chatChannelIds, id] } })
                setOtherChannel('')
              }}
            />
          </Field>
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

        {triggers.intervalMinutes !== null && (
          <div className="flex flex-col gap-2">
            <SwitchRow label={t('automations.field.gate')} hint={t('automations.field.gateHint')}>
              <Switch
                checked={triggers.pendingGate !== undefined}
                onChange={(on) => {
                  const { pendingGate: _drop, ...rest } = triggers
                  set({ triggers: on ? { ...rest, pendingGate: { kind: 'prReviewQueue', stateFile: '' } } : rest })
                }}
              />
            </SwitchRow>
            {triggers.pendingGate && (
              <Field label={t('automations.field.stateFile')}>
                <Input value={triggers.pendingGate.stateFile} placeholder={t('automations.field.stateFileHint')} onChange={(e) => set({ triggers: { ...triggers, pendingGate: { kind: 'prReviewQueue', stateFile: e.target.value } } })} />
              </Field>
            )}
          </div>
        )}

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
