import { useEffect, useRef, useState } from 'react'
import type { AgentAccount } from '@workhub/core'
import type { AgentOptionsView } from '@shared/api'
import { Badge, Input, Select } from '../../components/atoms'
import { Field, HelpTip, useToast } from '../../components/molecules'
import { DeleteButton, useUnsavedChanges, useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import { accountEnvHintKey, accountListItems, signInEntries, SIGN_IN_ID_PREFIX } from '../../lib/agents'
import { accountFieldErrors } from '../../lib/configIssues'
import { isDirty, type SaveOutcome } from '../../lib/unsavedChanges'
import { useAccountUsage } from '../../lib/usage'
import { AgentsOverview, SignInDetail } from '../AgentsSettings'
import { EnvFields, useAccountEnvDraft } from '../ProfileExtraSettings'
import { MasterDetail, type SectionProps } from './shared'

const emptyAccount = (agentId: string): AgentAccount => ({ id: '', agentId, name: '' })

/**
 * Settings → Agents and accounts: every agent with its sign-ins, the agent order of the profile
 * being edited, and the accounts. An account's environment values go to the secret store.
 */
export function AccountsSection({ snap, run, initialId, profileId }: SectionProps & { initialId?: string; profileId?: string | null }) {
  const { t } = useI18n()
  const toast = useToast()
  const firstAgent = snap.agents[0]?.id ?? ''
  // Opens on the asked-for account, else the first one: a blank "new" form only when there is none.
  const initial = snap.config.accounts.find((x) => x.id === initialId) ?? snap.config.accounts[0]
  const [selected, setSelected] = useState<string | null>(initial?.id ?? null)
  const [form, setForm] = useState<AgentAccount>(initial ? { ...initial } : emptyAccount(firstAgent))
  const env = useAccountEnvDraft(selected ? snap.config.accounts.find((a) => a.id === selected) : undefined)
  // Field problems, shown only after a save attempt.
  const [errors, setErrors] = useState<ReturnType<typeof accountFieldErrors> | null>(null)
  // What the form held when it was loaded or last saved: the save bar shows while it differs.
  const [baseline, setBaseline] = useState(() => ({ form }))
  const unsaved = useUnsavedChanges()

  const formRef = useRef<HTMLDivElement>(null)
  // Every agent's own sign-in is listed with the accounts (Kiro's is its only one).
  const reads = useAccountUsage()
  const [availability, setAvailability] = useState<Record<string, boolean> | null>(null)
  useEffect(() => {
    let live = true
    void window.hub.agents.availability().then(
      (a) => live && setAvailability(a),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [snap.agents])
  const signIns = signInEntries(snap.agents, reads, availability)
  const listItems = accountListItems(signIns, snap.config.accounts)
  const signIn = selected?.startsWith(SIGN_IN_ID_PREFIX) ? signIns.find((e) => e.id === selected) : undefined
  const select = (id: string | null, agentId = firstAgent) => {
    if (id?.startsWith(SIGN_IN_ID_PREFIX)) {
      setErrors(null)
      setSelected(id)
      return
    }
    const a = snap.config.accounts.find((x) => x.id === id)
    const next = a ? { ...a } : emptyAccount(agentId)
    setErrors(null)
    setSelected(a ? a.id : null)
    setForm(next)
    setBaseline({ form: next })
    env.reset()
  }
  // From the agent list: open the account (or a new one for that agent) and bring the form into view.
  const openForm = (id: string | null, agentId?: string) =>
    unsaved.requestLeave(() => {
      select(id, agentId)
      requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    })
  const agent = snap.agents.find((a) => a.id === form.agentId)
  const envHintKey = accountEnvHintKey(form.agentId)
  // Models and modes the agent offers, as suggestions for the defaults (free text stays allowed).
  const [options, setOptions] = useState<AgentOptionsView | null>(null)
  const optionsKey = selected ? `${form.agentId}:${selected}` : form.agentId
  const configurable = agent !== undefined && agent.adapter !== 'terminal'
  useEffect(() => {
    setOptions(null)
    if (!configurable) return
    let live = true
    void window.hub.agents.options(optionsKey).then(
      (o) => live && setOptions(o),
      () => live && setOptions(null)
    )
    return () => {
      live = false
    }
  }, [optionsKey, configurable])

  const save = async (): Promise<SaveOutcome> => {
    // Nothing is sent until the id and name are valid, so the form says which field to fix.
    const found = accountFieldErrors(form, selected ? [] : snap.config.accounts.map((a) => a.id))
    setErrors(found)
    const problem = found.id ?? found.name
    if (problem) return { ok: false, problem: t(problem) }
    const { env: _plain, ...account }: AgentAccount = { ...form }
    for (const k of ['command', 'defaultModel', 'defaultMode'] as const) {
      const v = account[k]?.trim()
      if (v) account[k] = v
      else delete account[k]
    }
    if (!account.configDir) delete account.configDir
    // Only the names go to the config file; the values go to the secret store below.
    const envNames = env.names()
    if (envNames.length) account.envNames = envNames
    else delete account.envNames
    if (!(await run(() => window.hub.config.saveAccount(account)))) return { ok: false }
    setSelected(account.id)
    setBaseline({ form })
    if (!(await env.commit(account.id))) {
      toast(t('profileExtra.envSaved'), 'danger')
      return { ok: false, problem: t('profileExtra.envSaved') }
    }
    return { ok: true }
  }
  useUnsavedForm({ dirty: !signIn && (isDirty(baseline, { form }) || env.dirty), draft: { form, rows: env.rows }, save, discard: () => select(selected, form.agentId) })

  return (
    <div className="flex flex-col gap-6">
      <AgentsOverview snap={snap} run={run} profileId={profileId} onEditAccount={(id) => openForm(id)} onAddAccount={(agentId) => openForm(null, agentId)} />
      <div ref={formRef} className="flex scroll-mt-4 flex-col gap-2">
        <h2 className="flex items-center gap-1.5 px-1 text-md font-semibold">
          {t('settings.accountsList')}
          <HelpTip text={t('help.accounts.list')} label={t('settings.accountsList')} />
        </h2>
        <p className="px-1 pb-1.5 text-sm text-subtle" data-testid="accounts-hint">
          {t('settings.accountsHint')}
        </p>
        <MasterDetail
          title={t('settings.accountsList')}
          newLabel={t('common.new')}
          emptyLabel={t('settings.noneYet')}
          items={listItems}
          selected={selected}
          onSelect={select}
          label={(i) => (i.kind === 'signIn' ? i.signIn.agent.name : i.account.name || i.account.id)}
          meta={(i) => (i.kind === 'signIn' ? <Badge tone="neutral">{t('agents.signIn.badge')}</Badge> : (snap.agents.find((x) => x.id === i.account.agentId)?.name ?? i.account.agentId))}
          formTitle={signIn ? t('agents.signIn.title', { agent: signIn.agent.name }) : selected ? form.name || form.id : t('settings.newAccount')}
          form={
            signIn ? (
              <SignInDetail entry={signIn} snap={snap} run={run} onAddAccount={(agentId) => select(null, agentId)} />
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <Field label={t('settings.id')} help={t('help.id')} error={errors?.id && t(errors.id)}>
                  <Input value={form.id} disabled={selected !== null} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="kiro-acme" />
                </Field>
                <Field label={t('settings.agent')} help={t('help.account.agent')}>
                  <Select value={form.agentId} onChange={(v) => setForm({ ...form, agentId: v })} options={snap.agents.map((a) => ({ value: a.id, label: a.name }))} />
                </Field>
                <Field label={t('settings.name')} help={t('help.account.name')} className="col-span-2" error={errors?.name && t(errors.name)}>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('settings.accountNamePlaceholder')} />
                </Field>
                <Field
                  label={t('settings.configDir')}
                  help={t('help.account.configDir')}
                  hint={agent?.accountConfigEnv ? t('settings.configDirSets', { env: agent.accountConfigEnv }) : t('settings.configDirNone')}
                  className="col-span-2"
                >
                  <Input value={form.configDir ?? ''} disabled={!agent?.accountConfigEnv} onChange={(e) => setForm({ ...form, configDir: e.target.value })} placeholder="~/.acme-agent" spellCheck={false} />
                </Field>
                <div className="col-span-2 flex flex-col gap-1" data-settings-row data-testid="account-env">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-muted">{t('settings.envLines')}</span>
                    <HelpTip text={t('help.account.env')} label={t('settings.envLines')} />
                  </span>
                  <EnvFields env={env} />
                  <p className="text-xs text-subtle">{envHintKey ? `${t(envHintKey)} ` : ''}{t('settings.envStoredNote')}</p>
                </div>
                {agent && agent.adapter !== 'terminal' && (
                  <Field label={t('settings.accountCommand')} hint={t('settings.accountCommandHint', { command: agent.command })} help={t('help.account.command')} className="col-span-2">
                    <Input value={form.command ?? ''} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder={agent.command} spellCheck={false} data-testid="account-command" />
                  </Field>
                )}
                {configurable && (
                  <>
                    <Field label={t('settings.defaultModel')} hint={t('settings.defaultModelHint')} help={t('help.account.defaultModel')}>
                      <Input
                        value={form.defaultModel ?? ''}
                        onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
                        list="account-models"
                        placeholder={options?.defaultModelId ?? t('settings.agentDefaultOption')}
                        spellCheck={false}
                        data-testid="account-default-model"
                      />
                    </Field>
                    <Field label={t('settings.defaultMode')} hint={t('settings.defaultModeHint')} help={t('help.account.defaultMode')}>
                      <Input
                        value={form.defaultMode ?? ''}
                        onChange={(e) => setForm({ ...form, defaultMode: e.target.value })}
                        list="account-modes"
                        placeholder={options?.defaultModeId ?? t('settings.agentDefaultOption')}
                        spellCheck={false}
                        data-testid="account-default-mode"
                      />
                    </Field>
                    <datalist id="account-models">
                      {options?.models.map((m) => (
                        <option key={m.id} value={m.id} label={m.description ? `${m.name} · ${m.description}` : m.name} />
                      ))}
                    </datalist>
                    <datalist id="account-modes">
                      {options?.modes.map((m) => (
                        <option key={m.id} value={m.id} label={m.description ? `${m.name} · ${m.description}` : m.name} />
                      ))}
                    </datalist>
                    <p className="col-span-2 -mt-2 text-xs text-subtle" data-testid="account-options-source">
                      {options && options.source !== 'none'
                        ? t('settings.optionsSource', {
                            count: options.models.length + options.modes.length,
                            source: t(options.source === 'cli' ? 'settings.optionsSource.cli' : 'settings.optionsSource.session')
                          })
                        : t('settings.optionsNone')}
                    </p>
                  </>
                )}
              </div>
            )
          }
          headerActions={!signIn && selected && <DeleteButton name={form.name || form.id} onDelete={() => void run(() => window.hub.config.deleteAccount(selected)).then((ok) => ok && select(null))} />}
        />
      </div>
    </div>
  )
}
