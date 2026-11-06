import { ChevronDown, ChevronRight, FolderOpen, Pencil, Plus, Star } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { accountAgentId, CLAUDE_MODEL_SUGGESTIONS, usageAccountKey, type AgentAccount, type AgentDefinition, type Profile } from '@workhub/core'
import type { AgentOptionsView, ConfigSnapshot } from '@shared/api'
import { Badge, Button, Input, Select, Switch } from '../../components/atoms'
import { Card, Field, HelpTip, OptionOrCustom, SwitchRow, useToast } from '../../components/molecules'
import { DeleteButton, useUnsavedChanges, useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import { accountIdFromName, isProfileDefault, makeAccountDefault, makeSignInDefault, profileDefaultAgent, signInOffered, withAccountInProfile } from '../../lib/accountDefaults'
import { accountEnvHintKey, accountListItems, agentGlyph, defaultSignInFolder, signInEntries, type LoginState, type SignInEntry } from '../../lib/agents'
import { accountFieldErrors } from '../../lib/configIssues'
import { modelOptions } from '../../lib/optionOrCustom'
import { isDirty, type SaveOutcome } from '../../lib/unsavedChanges'
import { useAccountUsage } from '../../lib/usage'
import { AgentsOverview, Login, SignInDetail } from '../AgentsSettings'
import { EnvFields, useAccountEnvDraft } from '../ProfileExtraSettings'
import type { Run } from './run'
import { saveProfilePatch, type SectionProps } from './shared'

/** What the accounts list has open: an account's form (`id` null: a new one) or an agent's own sign-in. */
type Editing = { kind: 'account'; id: string | null; agentId: string } | { kind: 'signIn'; id: string } | null

/** Agents that take accounts of their own: not a terminal, not one that uses another agent's accounts. */
const takesAccounts = (agent: AgentDefinition, agents: readonly AgentDefinition[]) => agent.adapter !== 'terminal' && !(agent.accountsOf && agents.some((b) => b.id === agent.accountsOf))

/**
 * Settings → Agents and accounts: the accounts first (one card per sign-in, which one new sessions
 * of the profile start with, a way to make another one the default and to add one), then every
 * agent with how it runs and the profile's agent order. An account's environment values go to the
 * secret store.
 */
export function AccountsSection({ snap, run, initialId, profileId }: SectionProps & { initialId?: string; profileId?: string | null }) {
  const { t } = useI18n()
  const unsaved = useUnsavedChanges()
  const agents = snap.agents
  const accountAgents = agents.filter((a) => takesAccounts(a, agents))
  const firstAgent = accountAgents[0]?.id ?? agents[0]?.id ?? ''
  const initialAccount = snap.config.accounts.find((x) => x.id === initialId)
  const [editing, setEditing] = useState<Editing>(initialAccount ? { kind: 'account', id: initialAccount.id, agentId: initialAccount.agentId } : null)
  const top = useRef<HTMLDivElement>(null)

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
  const signIns = signInEntries(agents, reads, availability)
  const items = accountListItems(signIns, snap.config.accounts)

  // The profile whose default is shown and set: the one being edited, else the active one.
  const profile = snap.config.profiles.find((p) => p.id === (profileId ?? snap.config.activeProfileId))
  const profileName = profile ? profile.name || profile.id : ''
  const defaultAgent = profileDefaultAgent(snap.config, profile?.id)
  const editable = !snap.loadError
  const makeDefault = (patch: (p: Profile) => Profile) => profile && void saveProfilePatch(run, profile.id, patch)

  const open = (next: Editing) =>
    unsaved.requestLeave(() => {
      setEditing(next)
      if (next?.kind === 'account' && next.id === null) requestAnimationFrame(() => top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    })
  const addAccount = (agentId = firstAgent) => open({ kind: 'account', id: null, agentId })
  const close = () => setEditing(null)

  // Per agent: its own sign-in, then its accounts (as `accountListItems` orders them).
  const groups: { agent: AgentDefinition | undefined; agentId: string; signIn?: SignInEntry; accounts: AgentAccount[] }[] = []
  for (const item of items) {
    if (item.kind === 'signIn') groups.push({ agent: item.signIn.agent, agentId: accountAgentId(item.signIn.agent), signIn: item.signIn, accounts: [] })
    else {
      const last = groups[groups.length - 1]
      if (last && last.agentId === item.account.agentId) last.accounts.push(item.account)
      else groups.push({ agent: agents.find((a) => a.id === item.account.agentId), agentId: item.account.agentId, accounts: [item.account] })
    }
  }
  const loginOf = (account: AgentAccount): LoginState => {
    const read = reads.find((r) => r.key === usageAccountKey(account.agentId, account.id))
    if (!read) return { state: 'unknown' }
    if (read.windows.length) return { state: 'ok' }
    return read.error ? { state: 'error', error: read.error } : { state: 'unknown' }
  }

  return (
    <div className="flex flex-col gap-6">
      <section ref={top} className="flex scroll-mt-4 flex-col gap-3" data-settings-group="accounts" data-testid="accounts">
        <div className="flex flex-wrap items-start gap-3 px-1">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-1.5 text-md font-semibold">
              {t('settings.accountsList')}
              <HelpTip text={t('help.accounts.list')} label={t('settings.accountsList')} />
            </h2>
            <p className="max-w-3xl text-sm text-muted" data-testid="accounts-hint">
              {t('accounts.intro')}
            </p>
          </div>
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} disabled={!editable || accountAgents.length === 0} onClick={() => addAccount()} data-testid="accounts-add">
            {t('accounts.add')}
          </Button>
        </div>
        <p className="px-1 text-sm text-text" data-testid="accounts-default">
          {profile && defaultAgent ? t('accounts.defaultFor', { profile: profileName, name: defaultAgent.label }) : t('accounts.defaultNone')}
          <span className="block text-xs text-subtle">{t('accounts.defaultHelp')}</span>
        </p>
        {editing?.kind === 'account' && editing.id === null && (
          <AccountEditor key={`new:${editing.agentId}`} snap={snap} run={run} account={null} agentId={editing.agentId} profile={profile} onClose={close} />
        )}
        {groups.map((g) => (
          <div key={g.agentId} className="flex flex-col gap-2" data-testid="accounts-agent" data-agent={g.agentId}>
            <h3 className="px-1 text-sm font-semibold text-muted">{g.agent?.name ?? g.agentId}</h3>
            {g.signIn && (
              <SignInCard
                entry={g.signIn}
                isDefault={isProfileDefault(defaultAgent, g.signIn.agent.id, null)}
                canMakeDefault={editable && profile !== undefined && signInOffered(snap.config, profile.id, g.signIn.agent.id)}
                onMakeDefault={() => makeDefault((p) => makeSignInDefault(p, g.signIn!.agent.id))}
                profileName={profileName}
                expanded={editing?.kind === 'signIn' && editing.id === g.signIn.id}
                onToggle={() => open(editing?.kind === 'signIn' && editing.id === g.signIn!.id ? null : { kind: 'signIn', id: g.signIn!.id })}
                details={<SignInDetail entry={g.signIn} snap={snap} run={run} onAddAccount={(agentId) => addAccount(agentId)} />}
              />
            )}
            {g.accounts.map((account) =>
              editing?.kind === 'account' && editing.id === account.id ? (
                <AccountEditor key={account.id} snap={snap} run={run} account={account} agentId={account.agentId} profile={profile} onClose={close} />
              ) : (
                <AccountCard
                  key={account.id}
                  account={account}
                  agent={g.agent}
                  login={loginOf(account)}
                  isDefault={isProfileDefault(defaultAgent, account.agentId, account.id)}
                  inProfile={profile?.accountIds.includes(account.id) ?? false}
                  profileName={profileName}
                  canMakeDefault={editable && profile !== undefined}
                  onMakeDefault={() => makeDefault((p) => makeAccountDefault(p, account))}
                  onEdit={() => open({ kind: 'account', id: account.id, agentId: account.agentId })}
                />
              )
            )}
          </div>
        ))}
      </section>
      <AgentsOverview snap={snap} run={run} profileId={profileId} onEditAccount={(id) => open({ kind: 'account', id, agentId: snap.config.accounts.find((a) => a.id === id)?.agentId ?? firstAgent })} onAddAccount={(agentId) => addAccount(agentId)} />
    </div>
  )
}

/** The badges every card shows: the default one, and whether the profile offers the account. */
function DefaultBadge() {
  const { t } = useI18n()
  return (
    <Badge tone="accent" icon={<Star className="size-3" aria-hidden />} data-testid="accounts-default-badge">
      {t('accounts.badge.default')}
    </Badge>
  )
}

function MakeDefaultButton({ profileName, onClick }: { profileName: string; onClick: () => void }) {
  const { t } = useI18n()
  return (
    <Button size="sm" onClick={onClick} title={t('accounts.makeDefaultHint', { profile: profileName })} data-testid="accounts-make-default">
      {t('accounts.makeDefault')}
    </Button>
  )
}

/** One account: its name, agent, where it signs in, its extras, and its actions. */
function AccountCard(props: {
  account: AgentAccount
  agent: AgentDefinition | undefined
  login: LoginState
  isDefault: boolean
  inProfile: boolean
  profileName: string
  canMakeDefault: boolean
  onMakeDefault: () => void
  onEdit: () => void
}) {
  const { t } = useI18n()
  const { account, agent } = props
  const env = agent?.accountConfigEnv
  const folderLine = env
    ? account.configDir
      ? t('accounts.configDirLine', { folder: account.configDir, env })
      : t('accounts.configDirDefault', { folder: defaultSignInFolder(agent) ?? '' })
    : t('accounts.noConfigDir')
  return (
    <Card className="flex flex-col gap-1.5 px-4 py-3" data-testid="accounts-card" data-account={account.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold">{account.name || account.id}</span>
        <Badge tone="neutral">{agent?.name ?? account.agentId}</Badge>
        {props.isDefault && <DefaultBadge />}
        {!props.inProfile && props.profileName && <Badge tone="warning">{t('accounts.badge.notInProfile', { profile: props.profileName })}</Badge>}
        <Login login={props.login} />
        <span className="ml-auto flex items-center gap-1.5">
          {!props.isDefault && props.canMakeDefault && <MakeDefaultButton profileName={props.profileName} onClick={props.onMakeDefault} />}
          <Button size="sm" variant="ghost" icon={<Pencil className="size-3" aria-hidden />} onClick={props.onEdit} data-testid="accounts-edit">
            {t('agents.edit')}
          </Button>
        </span>
      </div>
      <p className="text-sm text-muted">{folderLine}</p>
      {(account.envNames?.length || account.defaultModel || account.command) && (
        <p className="flex flex-wrap gap-x-4 text-xs text-subtle">
          {account.envNames?.length ? <span>{t('accounts.envLine', { names: account.envNames.join(', ') })}</span> : null}
          {account.defaultModel && <span>{t('accounts.modelLine', { model: account.defaultModel })}</span>}
          {account.command && <span>{t('accounts.commandLine', { command: account.command })}</span>}
        </p>
      )}
    </Card>
  )
}

/** An agent's own sign-in on this computer (sessions without an account use it), with its details on demand. */
function SignInCard(props: {
  entry: SignInEntry
  isDefault: boolean
  canMakeDefault: boolean
  onMakeDefault: () => void
  profileName: string
  expanded: boolean
  onToggle: () => void
  details: ReactNode
}) {
  const { t } = useI18n()
  const { agent } = props.entry
  const folder = defaultSignInFolder(agent)
  return (
    <Card className="flex flex-col gap-1.5 px-4 py-3" data-testid="accounts-sign-in" data-agent={agent.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold">{t('accounts.ownSignIn')}</span>
        <Badge tone="neutral">{agent.name}</Badge>
        {props.isDefault && <DefaultBadge />}
        <Login login={props.entry.login} />
        <span className="ml-auto flex items-center gap-1.5">
          {!props.isDefault && props.canMakeDefault && <MakeDefaultButton profileName={props.profileName} onClick={props.onMakeDefault} />}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={props.expanded}
            icon={props.expanded ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
            onClick={props.onToggle}
          >
            {t(props.expanded ? 'accounts.hideDetails' : 'accounts.details')}
          </Button>
        </span>
      </div>
      <p className="text-sm text-muted">{folder ? t('accounts.ownSignInFolder', { folder }) : t('accounts.ownSignInNoFolder')}</p>
      {props.expanded && <div className="pt-2">{props.details}</div>}
    </Card>
  )
}

interface AccountDraft {
  form: AgentAccount
  /** Whether the profile shown offers the account. */
  offer: boolean
}

/**
 * The form of one account (`account` null: a new one for `agentId`): name, agent and config folder
 * up front; the id, environment, command and session defaults under "More options". Saved by its
 * own button or the save bar.
 */
function AccountEditor({ snap, run, account, agentId, profile, onClose }: { snap: ConfigSnapshot; run: Run; account: AgentAccount | null; agentId: string; profile: Profile | undefined; onClose: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const unsaved = useUnsavedChanges()
  const isNew = account === null
  const [saved, setSaved] = useState<AgentAccount | null>(account)
  const initial = (): AccountDraft => ({ form: account ? { ...account } : { id: '', agentId, name: '' }, offer: account ? (profile?.accountIds.includes(account.id) ?? false) : profile !== undefined })
  const [draft, setDraft] = useState<AccountDraft>(initial)
  const [baseline, setBaseline] = useState<AccountDraft>(draft)
  const { form } = draft
  const setForm = (next: AgentAccount) => setDraft((d) => ({ ...d, form: next }))
  // A new account's id follows its name until the user edits the id.
  const [idEdited, setIdEdited] = useState(false)
  const [more, setMore] = useState(!isNew)
  const env = useAccountEnvDraft(saved ?? undefined)
  const [errors, setErrors] = useState<ReturnType<typeof accountFieldErrors> | null>(null)
  const agents = snap.agents
  const agent = agents.find((a) => a.id === form.agentId)
  const envHintKey = accountEnvHintKey(form.agentId)
  const configurable = agent !== undefined && agent.adapter !== 'terminal'
  const takenIds = snap.config.accounts.map((a) => a.id)

  // Models and modes the agent offers, as choices for the defaults ("Other…" takes any id).
  const [options, setOptions] = useState<AgentOptionsView | null>(null)
  const optionsKey = saved ? `${form.agentId}:${saved.id}` : form.agentId
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
  const isClaude = agent !== undefined && agentGlyph(agent.id, agent.adapter) === 'claude'
  const models = modelOptions(options?.models.map((m) => ({ value: m.id, label: m.description ? `${m.name} · ${m.description}` : m.name })) ?? [], isClaude, CLAUDE_MODEL_SUGGESTIONS)
  const modes = options?.modes.map((m) => ({ value: m.id, label: m.description ? `${m.name} · ${m.description}` : m.name })) ?? []

  const save = async (): Promise<SaveOutcome> => {
    // Nothing is sent until the id and name are valid, so the form says which field to fix.
    const found = accountFieldErrors(form, saved ? [] : takenIds)
    setErrors(found)
    const problem = found.id ?? found.name
    if (problem) {
      if (found.id) setMore(true)
      return { ok: false, problem: t(problem) }
    }
    const { env: _plain, ...next }: AgentAccount = { ...form, name: form.name.trim() }
    for (const k of ['command', 'defaultModel', 'defaultMode', 'configDir'] as const) {
      const v = next[k]?.trim()
      if (v) next[k] = v
      else delete next[k]
    }
    // Only the names go to the config file; the values go to the secret store below.
    const envNames = env.names()
    if (envNames.length) next.envNames = envNames
    else delete next.envNames
    if (!(await run(() => window.hub.config.saveAccount(next)))) return { ok: false }
    setSaved(next)
    if (profile && draft.offer !== baseline.offer) {
      if (!(await saveProfilePatch(run, profile.id, (p) => withAccountInProfile(p, next.id, draft.offer)))) return { ok: false }
    }
    setBaseline(draft)
    if (!(await env.commit(next.id))) {
      toast(t('profileExtra.envSaved'), 'danger')
      return { ok: false, problem: t('profileExtra.envSaved') }
    }
    return { ok: true }
  }
  const dirty = isDirty(baseline, draft) || env.dirty
  useUnsavedForm({ dirty, draft: { draft, rows: env.rows }, save, discard: () => {
    setDraft(baseline)
    setErrors(null)
    env.reset()
  } })
  const saveNow = async () => {
    if (await unsaved.saveAll()) onClose()
  }
  const pickConfigDir = async () => {
    const picked = await window.hub.pickFolder()
    if (picked) setForm({ ...form, configDir: picked })
  }
  const accountAgents = agents.filter((a) => takesAccounts(a, agents))

  return (
    <Card className="flex flex-col gap-4 border-accent/40 px-4 py-4" data-testid="accounts-editor">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-md font-semibold">{isNew ? t('accounts.editor.new') : form.name || form.id}</h3>
        {!isNew && <Badge tone="neutral">{agent?.name ?? form.agentId}</Badge>}
        <span className="ml-auto flex items-center gap-1.5">
          {saved && <DeleteButton name={form.name || form.id} onDelete={() => void run(() => window.hub.config.deleteAccount(saved.id)).then((ok) => ok && onClose())} />}
        </span>
      </div>
      {isNew && <p className="-mt-2 text-sm text-subtle">{t('accounts.editor.newIntro')}</p>}
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('settings.name')} help={t('help.account.name')} error={errors?.name && t(errors.name)}>
          <Input
            value={form.name}
            autoFocus={isNew}
            onChange={(e) => {
              const name = e.target.value
              setForm({ ...form, name, ...(isNew && !idEdited ? { id: accountIdFromName(name, takenIds) } : {}) })
              setErrors(null)
            }}
            placeholder={t('settings.accountNamePlaceholder')}
            data-testid="account-name"
          />
        </Field>
        <Field label={t('settings.agent')} help={t('help.account.agent')}>
          <Select
            value={form.agentId}
            onChange={(v) => setForm({ ...form, agentId: v })}
            options={[...accountAgents, ...agents.filter((a) => a.id === form.agentId && !accountAgents.includes(a))].map((a) => ({ value: a.id, label: a.name }))}
          />
        </Field>
        {agent?.accountConfigEnv ? (
          <Field label={t('settings.configDir')} help={t('help.account.configDir')} hint={t('accounts.editor.configDirHint', { env: agent.accountConfigEnv, folder: defaultSignInFolder(agent) ?? '' })} className="col-span-2">
            <div className="flex gap-2">
              <Input value={form.configDir ?? ''} onChange={(e) => setForm({ ...form, configDir: e.target.value })} placeholder={`~/.${agent.id}-work`} spellCheck={false} className="min-w-0 flex-1" data-testid="account-config-dir" />
              <Button icon={<FolderOpen className="size-3.5" aria-hidden />} onClick={() => void pickConfigDir()} data-testid="account-config-dir-pick">
                {t('accounts.editor.configDirPick')}
              </Button>
            </div>
          </Field>
        ) : (
          <p className="col-span-2 text-sm text-subtle">{t('settings.configDirNone')}</p>
        )}
        {profile && (
          <div className="col-span-2">
            <SwitchRow label={t('accounts.editor.offerIn', { profile: profile.name || profile.id })} hint={t('accounts.editor.offerInHint')}>
              <Switch checked={draft.offer} onChange={(offer) => setDraft((d) => ({ ...d, offer }))} />
            </SwitchRow>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <button type="button" className="flex items-center gap-1 self-start text-sm font-medium text-muted hover:text-text" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          {t('accounts.editor.more')}
          <span className="font-normal text-subtle">· {t('accounts.editor.moreHint')}</span>
        </button>
        {more && (
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('settings.id')} help={t('help.id')} hint={isNew ? t('accounts.editor.idAuto') : undefined} error={errors?.id && t(errors.id)} className="col-span-2">
              <Input
                value={form.id}
                disabled={!isNew}
                onChange={(e) => {
                  setIdEdited(true)
                  setForm({ ...form, id: e.target.value })
                  setErrors(null)
                }}
                placeholder="claude-work"
                spellCheck={false}
              />
            </Field>
            <div className="col-span-2 flex flex-col gap-1" data-settings-row data-testid="account-env">
              <span className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-muted">{t('settings.envLines')}</span>
                <HelpTip text={t('help.account.env')} label={t('settings.envLines')} />
              </span>
              <EnvFields env={env} />
              <p className="text-xs text-subtle">
                {envHintKey ? `${t(envHintKey)} ` : ''}
                {t('settings.envStoredNote')}
              </p>
            </div>
            {configurable && (
              <>
                <Field label={t('settings.accountCommand')} hint={t('settings.accountCommandHint', { command: agent.command })} help={t('help.account.command')} className="col-span-2">
                  <Input value={form.command ?? ''} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder={agent.command} spellCheck={false} data-testid="account-command" />
                </Field>
                <Field label={t('settings.defaultModel')} hint={t('settings.defaultModelHint')} help={t('help.account.defaultModel')}>
                  <OptionOrCustom
                    value={form.defaultModel ?? ''}
                    onChange={(defaultModel) => setForm({ ...form, defaultModel })}
                    options={models}
                    emptyLabel={options?.defaultModelId ? t('accounts.editor.agentDefaultNamed', { name: options.defaultModelId }) : t('settings.agentDefaultOption')}
                    aria-label={t('settings.defaultModel')}
                    data-testid="account-default-model"
                  />
                </Field>
                <Field label={t('settings.defaultMode')} hint={t('settings.defaultModeHint')} help={t('help.account.defaultMode')}>
                  <OptionOrCustom
                    value={form.defaultMode ?? ''}
                    onChange={(defaultMode) => setForm({ ...form, defaultMode })}
                    options={modes}
                    emptyLabel={options?.defaultModeId ? t('accounts.editor.agentDefaultNamed', { name: options.defaultModeId }) : t('settings.agentDefaultOption')}
                    aria-label={t('settings.defaultMode')}
                    data-testid="account-default-mode"
                  />
                </Field>
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
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onClose}>{t(dirty ? 'common.cancel' : 'common.close')}</Button>
        <Button variant="primary" disabled={!dirty || Boolean(snap.loadError)} onClick={() => void saveNow()} data-testid="accounts-editor-save">
          {t(isNew ? 'accounts.editor.create' : 'accounts.editor.save')}
        </Button>
      </div>
    </Card>
  )
}
