import { Activity, FolderCog, Gauge, MessageSquare, Languages, Palette, Plug, Plus, Ticket, Trash2, Users, UserCog } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  appOptions,
  CONNECTION_KINDS,
  NO_MODULES,
  OPTIONAL_MODULES,
  orderAgents,
  resolveEffectiveAgents,
  type AgentAccount,
  type Connection,
  type ConnectionKind,
  type OptionalModule,
  type Profile,
  type Result,
  type SecretChange,
  type ValidationIssue,
  type WorkhubConfig
} from '@workhub/core'
import type { AgentOptionsView, ConfigSnapshot } from '@shared/api'
import { Badge, Button, Input, Select, Switch, Textarea } from '../components/atoms'
import { AgentOrderList, Card, CardBody, CardHeader, EmptyState, Field, ListRow, SwitchRow, Tabs, useToast } from '../components/molecules'
import { Workhub1Import, Workhub1SecretsImport } from '../components/organisms'
import { refreshConfig } from '../configStore'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { accountEnvHintKey } from '../lib/agents'
import { setPrefs, usePrefs } from '../lib/prefs'
import { AiReviewProfileFields } from './AiReviewSettings'
import { HealthSettings } from './HealthSettings'
import { SlackArchiveField, SlackSettings } from './SlackSettings'
import { PullRequestNotificationRows } from './PullRequestNotificationSettings'
import { MenuBarRows, OtherNotificationRows } from './NotificationExtraSettings'
import { TrackerSettings } from './TrackerSettings'
import { UpdatesSettings } from './UpdatesSettings'
import { UsageSettings } from './UsageSettings'

const KIND_LABEL: Record<ConnectionKind, MessageKey> = {
  codeHost: 'kind.codeHost',
  tracker: 'kind.tracker',
  chat: 'kind.chat',
  health: 'kind.health'
}
const MODULE_LABEL: Record<OptionalModule, MessageKey> = {
  flows: 'module.flows',
  health: 'module.health',
  chatWatcher: 'module.chatWatcher',
  automations: 'module.automations'
}

/** `KEY=value` per line <-> record. */
const toLines = (m: Record<string, string> | undefined) =>
  Object.entries(m ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
const fromLines = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('=')
        return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1)]
      })
  )

function Issues({ issues, title }: { issues: ValidationIssue[]; title?: string }) {
  if (!issues.length) return null
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <ul className="flex flex-col gap-0.5">
        {issues.map((i) => (
          <li key={`${i.path}${i.message}`}>
            <code className="rounded bg-danger-soft px-1">{i.path}</code> {i.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>
interface SectionProps {
  snap: ConfigSnapshot
  run: Run
}

export function SettingsScreen({ snap, tab, onTabChange }: { snap: ConfigSnapshot | null; tab: string; onTabChange: (tab: string) => void }) {
  const { t } = useI18n()
  const notify = useToast()
  const [issues, setIssues] = useState<ValidationIssue[]>([])

  const run: Run = async (op) => {
    const r = await op()
    if (!r.ok) {
      setIssues(r.issues)
      return false
    }
    setIssues([])
    notify(t('settings.saved'))
    await refreshConfig()
    return true
  }

  if (!snap) return null
  const section = (node: ReactNode) => (
    <div className="flex flex-col gap-4">
      <Issues issues={issues} />
      {node}
    </div>
  )
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-8 py-7">
      <h1 className="text-2xl font-semibold tracking-tight">{t('nav.settings')}</h1>
      {snap.loadError && <Issues title={t('settings.loadError')} issues={[{ path: 'config.json', message: snap.loadError }]} />}
      <Issues title={t('settings.storedProblems')} issues={snap.issues} />
      {snap.issues.some((i) => i.message === 'a secret is required') && <Workhub1SecretsImport compact />}
      <Tabs
        label={t('nav.settings')}
        value={tab}
        onChange={(v) => {
          setIssues([])
          onTabChange(v)
        }}
        items={[
          { value: 'general', label: t('settings.general'), icon: <Languages className="size-4" aria-hidden />, content: section(<GeneralSection snap={snap} run={run} />) },
          { value: 'appearance', label: t('settings.appearance'), icon: <Palette className="size-4" aria-hidden />, content: <AppearanceSection /> },
          { value: 'profiles', label: t('settings.profiles'), icon: <Users className="size-4" aria-hidden />, content: section(<ProfilesSection snap={snap} run={run} />) },
          { value: 'connections', label: t('settings.connections'), icon: <Plug className="size-4" aria-hidden />, content: section(<ConnectionsSection snap={snap} run={run} />) },
          { value: 'trackers', label: t('trackers.tab'), icon: <Ticket className="size-4" aria-hidden />, content: section(<TrackerSettings snap={snap} run={run} />) },
          { value: 'health', label: t('health.settings.tab'), icon: <Activity className="size-4" aria-hidden />, content: section(<HealthSettings snap={snap} run={run} />) },
          { value: 'slack', label: t('nav.slack'), icon: <MessageSquare className="size-4" aria-hidden />, content: section(<SlackSettings snap={snap} run={run} />) },
          { value: 'accounts', label: t('settings.accounts'), icon: <UserCog className="size-4" aria-hidden />, content: section(<AccountsSection snap={snap} run={run} />) },
          { value: 'usage', label: t('agentUsage.settings.tab'), icon: <Gauge className="size-4" aria-hidden />, content: section(<UsageSettings snap={snap} run={run} />) }
        ]}
      />
    </div>
  )
}

function SettingsGroup({ title, children, footnote }: { title: string; children: ReactNode; footnote?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-md font-semibold">{title}</h2>
      <Card className="divide-y divide-border px-4">{children}</Card>
      {footnote && <p className="px-1 text-xs text-subtle">{footnote}</p>}
    </section>
  )
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <span className="text-base">{label}</span>
      <div className="w-56">{children}</div>
    </div>
  )
}

function GeneralSection({ snap, run }: SectionProps) {
  const { t } = useI18n()
  const { language } = usePrefs()
  const options = appOptions(snap.config)
  const editable = !snap.loadError
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <SettingsGroup title={t('settings.interface')} footnote={t('settings.languageHint')}>
        <SettingRow label={t('settings.language')}>
          <Select
            aria-label={t('settings.language')}
            value={language}
            onChange={(v) => setPrefs({ language: v as typeof language })}
            options={[
              { value: 'system', label: t('settings.system') },
              { value: 'en', label: 'English' },
              { value: 'es', label: 'Español' }
            ]}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={t('settings.notifications')} footnote={t('settings.notificationsNote')}>
        {(
          [
            ['notifyReplied', 'settings.notifyReplied', 'settings.notifyRepliedHint'],
            ['notifyNeedsAnswer', 'settings.notifyNeedsAnswer', 'settings.notifyNeedsAnswerHint'],
            ['notifyError', 'settings.notifyError', 'settings.notifyErrorHint']
          ] as const
        ).map(([option, label, hint]) => (
          <SwitchRow key={option} label={t(label)} hint={t(hint)}>
            <Switch checked={options[option]} disabled={!editable} onChange={(on) => void run(() => window.hub.config.saveOptions({ [option]: on }))} />
          </SwitchRow>
        ))}
      </SettingsGroup>
      <SettingsGroup title={t('settings.otherNotifications')} footnote={t('settings.otherNotificationsNote')}>
        <OtherNotificationRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('settings.menuBar')} footnote={window.hub.platform === 'linux' ? t('settings.keepInTrayLinuxNote') : undefined}>
        <MenuBarRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('updates.group')} footnote={window.hub.platform === 'mac' ? t('updates.macNote') : undefined}>
        <UpdatesSettings enabled={options.checkForUpdates} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('prevent.settings.title')} footnote={t('prevent.settings.note')}>
        <PullRequestNotificationRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      {window.hub.platform === 'mac' && editable && (
        <SettingsGroup title={t('import.group')}>
          <Workhub1Import run={run} />
        </SettingsGroup>
      )}
      <SettingsGroup title={t('settings.storage')}>
        <div className="flex items-center gap-3 py-3">
          <FolderCog className="size-4 text-muted" aria-hidden />
          <span className="flex-1 text-base">{t('settings.dataDir')}</span>
          <code className="truncate text-sm text-muted" title={snap.dataDir}>
            {snap.dataDir}
          </code>
        </div>
      </SettingsGroup>
    </div>
  )
}

function AppearanceSection() {
  const { t } = useI18n()
  const { theme } = usePrefs()
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <SettingsGroup title={t('settings.appearance')} footnote={t('settings.themeHint')}>
        <SettingRow label={t('settings.theme')}>
          <Select
            aria-label={t('settings.theme')}
            value={theme}
            onChange={(v) => setPrefs({ theme: v as typeof theme })}
            options={[
              { value: 'system', label: t('settings.system') },
              { value: 'light', label: t('settings.light') },
              { value: 'dark', label: t('settings.dark') }
            ]}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}

/** Left: the items with a New button. Right: the form of the selected (or new) item. */
function MasterDetail<T extends { id: string }>(props: {
  title: string
  newLabel: string
  emptyLabel: string
  items: T[]
  selected: string | null
  label: (item: T) => string
  meta?: (item: T) => ReactNode
  onSelect: (id: string | null) => void
  formTitle: string
  form: ReactNode
  actions: ReactNode
}) {
  return (
    <div className="grid grid-cols-[17rem_minmax(0,1fr)] items-start gap-4">
      <Card>
        <CardHeader
          title={props.title}
          as="h2"
          actions={
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => props.onSelect(null)}>
              {props.newLabel}
            </Button>
          }
        />
        <CardBody className="px-2 pb-2">
          {props.items.length === 0 ? (
            <EmptyState compact title={props.emptyLabel} />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {props.items.map((i) => (
                <li key={i.id}>
                  <ListRow title={props.label(i)} trailing={props.meta?.(i)} selected={props.selected === i.id} onClick={() => props.onSelect(i.id)} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={props.formTitle} as="h2" />
        <CardBody className="flex flex-col gap-4">
          {props.form}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">{props.actions}</div>
        </CardBody>
      </Card>
    </div>
  )
}

function FieldGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="rounded-md border border-border px-3 pt-1 pb-2">
      <legend className="px-1 text-sm font-medium text-muted">{legend}</legend>
      {children}
    </fieldset>
  )
}

const emptyConnection = (): Connection => ({ id: '', kind: 'codeHost', provider: 'github', settings: {} })

function ConnectionsSection({ snap, run }: SectionProps) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState<Connection>(emptyConnection())
  const [settingsText, setSettingsText] = useState('')
  const [secret, setSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)

  const select = (id: string | null) => {
    const c = snap.config.connections.find((x) => x.id === id)
    setSelected(c ? c.id : null)
    setForm(c ? { ...c } : emptyConnection())
    setSettingsText(toLines(c?.settings))
    setSecret('')
    setClearSecret(false)
  }

  const providers = snap.providers.filter((p) => p.kind === form.kind)
  const provider = snap.providers.find((p) => p.id === form.provider)
  const hasSecret = selected !== null && snap.connectionsWithSecret.includes(selected)

  const save = async () => {
    const change: SecretChange = clearSecret ? { action: 'clear' } : secret ? { action: 'set', value: secret } : { action: 'keep' }
    const connection: Connection = { ...form, settings: fromLines(settingsText) }
    if (!connection.endpoint) delete connection.endpoint
    if (!connection.name) delete connection.name
    if (await run(() => window.hub.config.saveConnection(connection, change))) {
      setSelected(connection.id)
      setSecret('')
    }
  }

  return (
    <MasterDetail
      title={t('settings.connections')}
      newLabel={t('common.new')}
      emptyLabel={t('settings.noneYet')}
      items={snap.config.connections}
      selected={selected}
      onSelect={select}
      label={(c) => c.name || c.id}
      meta={(c) => c.provider}
      formTitle={selected ? (form.name || form.id) : t('settings.newConnection')}
      form={
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.id')}>
            <Input value={form.id} disabled={selected !== null} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="acme-github" />
          </Field>
          <Field label={t('settings.name')}>
            <Input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme GitHub" />
          </Field>
          <Field label={t('settings.kind')}>
            <Select
              value={form.kind}
              onChange={(v) => {
                const kind = v as ConnectionKind
                setForm({ ...form, kind, provider: snap.providers.find((p) => p.kind === kind)?.id ?? '' })
              }}
              options={CONNECTION_KINDS.map((k) => ({ value: k, label: t(KIND_LABEL[k]) }))}
            />
          </Field>
          <Field label={t('settings.provider')}>
            <Select
              value={form.provider}
              onChange={(v) => setForm({ ...form, provider: v })}
              options={providers.map((p) => ({ value: p.id, label: t('settings.providerPhase', { name: p.name, phase: p.phase }) }))}
            />
          </Field>
          <Field label={provider?.requiresEndpoint ? t('settings.endpointRequired') : t('settings.endpoint')} className="col-span-2">
            <Input
              value={form.endpoint ?? ''}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              placeholder={provider?.defaultEndpoint ?? 'https://acme.example.com'}
              spellCheck={false}
            />
          </Field>
          <Field
            label={provider?.requiresSecret ? t('settings.secretRequired') : t('settings.secret')}
            hint={t('settings.secretHint')}
            className="col-span-2"
          >
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={hasSecret ? t('settings.secretStored') : t('settings.secretNotSet')}
              autoComplete="off"
            />
          </Field>
          {hasSecret && (
            <div className="col-span-2">
              <SwitchRow label={t('settings.clearSecret')}>
                <Switch checked={clearSecret} onChange={setClearSecret} />
              </SwitchRow>
            </div>
          )}
          <Field label={t('settings.settingsLines')} className="col-span-2">
            <Textarea rows={3} value={settingsText} onChange={(e) => setSettingsText(e.target.value)} placeholder="scope=org:acme" spellCheck={false} />
          </Field>
        </div>
      }
      actions={
        <>
          <Button variant="primary" onClick={() => void save()}>
            {t('settings.saveConnection')}
          </Button>
          {selected && (
            <Button variant="danger" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => void run(() => window.hub.config.deleteConnection(selected)).then((ok) => ok && select(null))}>
              {t('common.delete')}
            </Button>
          )}
        </>
      }
    />
  )
}

const emptyAccount = (agentId: string): AgentAccount => ({ id: '', agentId, name: '' })

function AccountsSection({ snap, run }: SectionProps) {
  const { t } = useI18n()
  const firstAgent = snap.agents[0]?.id ?? ''
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState<AgentAccount>(emptyAccount(firstAgent))
  const [envText, setEnvText] = useState('')

  const select = (id: string | null) => {
    const a = snap.config.accounts.find((x) => x.id === id)
    setSelected(a ? a.id : null)
    setForm(a ? { ...a } : emptyAccount(firstAgent))
    setEnvText(toLines(a?.env))
  }
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

  const save = async () => {
    const account: AgentAccount = { ...form, env: fromLines(envText) }
    for (const k of ['command', 'defaultModel', 'defaultMode'] as const) {
      const v = account[k]?.trim()
      if (v) account[k] = v
      else delete account[k]
    }
    if (!account.configDir) delete account.configDir
    if (!Object.keys(account.env ?? {}).length) delete account.env
    if (await run(() => window.hub.config.saveAccount(account))) setSelected(account.id)
  }

  return (
    <MasterDetail
      title={t('settings.accounts')}
      newLabel={t('common.new')}
      emptyLabel={t('settings.noneYet')}
      items={snap.config.accounts}
      selected={selected}
      onSelect={select}
      label={(a) => a.name || a.id}
      meta={(a) => snap.agents.find((x) => x.id === a.agentId)?.name ?? a.agentId}
      formTitle={selected ? form.name || form.id : t('settings.newAccount')}
      form={
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.id')}>
            <Input value={form.id} disabled={selected !== null} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="kiro-acme" />
          </Field>
          <Field label={t('settings.agent')}>
            <Select value={form.agentId} onChange={(v) => setForm({ ...form, agentId: v })} options={snap.agents.map((a) => ({ value: a.id, label: a.name }))} />
          </Field>
          <Field label={t('settings.name')} className="col-span-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme work" />
          </Field>
          <Field
            label={t('settings.configDir')}
            hint={agent?.accountConfigEnv ? t('settings.configDirSets', { env: agent.accountConfigEnv }) : t('settings.configDirNone')}
            className="col-span-2"
          >
            <Input
              value={form.configDir ?? ''}
              disabled={!agent?.accountConfigEnv}
              onChange={(e) => setForm({ ...form, configDir: e.target.value })}
              placeholder="~/.acme-agent"
              spellCheck={false}
            />
          </Field>
          <Field label={t('settings.envLines')} hint={envHintKey ? t(envHintKey) : undefined} className="col-span-2">
            <Textarea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="ACME_ACCOUNT=work" spellCheck={false} />
          </Field>
          {agent && agent.adapter !== 'terminal' && (
            <Field label={t('settings.accountCommand')} hint={t('settings.accountCommandHint', { command: agent.command })} className="col-span-2">
              <Input value={form.command ?? ''} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder={agent.command} spellCheck={false} data-testid="account-command" />
            </Field>
          )}
          {configurable && (
            <>
              <Field label={t('settings.defaultModel')} hint={t('settings.defaultModelHint')}>
                <Input
                  value={form.defaultModel ?? ''}
                  onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
                  list="account-models"
                  placeholder={options?.defaultModelId ?? t('settings.agentDefaultOption')}
                  spellCheck={false}
                  data-testid="account-default-model"
                />
              </Field>
              <Field label={t('settings.defaultMode')} hint={t('settings.defaultModeHint')}>
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
                {options?.models.map((m) => <option key={m.id} value={m.id} label={m.description ? `${m.name} · ${m.description}` : m.name} />)}
              </datalist>
              <datalist id="account-modes">
                {options?.modes.map((m) => <option key={m.id} value={m.id} label={m.description ? `${m.name} · ${m.description}` : m.name} />)}
              </datalist>
              <p className="col-span-2 -mt-2 text-xs text-subtle" data-testid="account-options-source">
                {options && options.source !== 'none'
                  ? t('settings.optionsSource', { count: options.models.length + options.modes.length, source: t(options.source === 'cli' ? 'settings.optionsSource.cli' : 'settings.optionsSource.session') })
                  : t('settings.optionsNone')}
              </p>
            </>
          )}
        </div>
      }
      actions={
        <>
          <Button variant="primary" onClick={() => void save()}>
            {t('settings.saveAccount')}
          </Button>
          {selected && (
            <Button variant="danger" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => void run(() => window.hub.config.deleteAccount(selected)).then((ok) => ok && select(null))}>
              {t('common.delete')}
            </Button>
          )}
        </>
      }
    />
  )
}

const emptyProfile = (): Profile => ({ id: '', name: '', connections: {}, accountIds: [], modules: { ...NO_MODULES } })

function ProfilesSection({ snap, run }: SectionProps) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState<Profile>(emptyProfile())

  const select = (id: string | null) => {
    const p = snap.config.profiles.find((x) => x.id === id)
    setSelected(p ? p.id : null)
    setForm(p ? structuredClone(p) : emptyProfile())
  }
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id))
  const allAgents = form.agentIds === undefined
  // The agents this profile offers as it is being edited, in the user's order.
  const orderedAgents = orderAgents(form.preferredAgents, resolveEffectiveAgents({ ...snap.config, profiles: [form] }, form.id || null))

  const save = async () => {
    const folders = form.folders?.map((f) => f.trim()).filter(Boolean)
    const profile: Profile = { ...form, folders: folders?.length ? folders : undefined }
    if (!profile.folders) delete profile.folders
    if (!profile.preferredAgents?.length) delete profile.preferredAgents
    if (await run(() => window.hub.config.saveProfile(profile))) setSelected(form.id)
  }

  return (
    <MasterDetail
      title={t('settings.profiles')}
      newLabel={t('common.new')}
      emptyLabel={t('settings.noneYet')}
      items={snap.config.profiles}
      selected={selected}
      onSelect={select}
      label={(p) => p.name || p.id}
      meta={(p) => (snap.config.activeProfileId === p.id ? <Badge tone="accent">{t('settings.active')}</Badge> : null)}
      formTitle={selected ? form.name || form.id : t('settings.newProfile')}
      form={
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('settings.id')}>
              <Input value={form.id} disabled={selected !== null} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="acme" />
            </Field>
            <Field label={t('settings.name')}>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme" />
            </Field>
          </div>
          <Field label={t('settings.folders')} hint={t('settings.foldersHint')}>
            <Textarea
              rows={3}
              value={(form.folders ?? []).join('\n')}
              spellCheck={false}
              onChange={(e) => {
                const folders = e.target.value.split('\n')
                setForm({ ...form, folders: folders.some((f) => f.trim()) ? folders : undefined })
              }}
            />
          </Field>
          <FieldGroup legend={t('settings.connections')}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
              {CONNECTION_KINDS.map((kind) => (
                <Field key={kind} label={t(KIND_LABEL[kind])}>
                  <Select
                    value={form.connections[kind] ?? ''}
                    onChange={(v) => {
                      const connections = { ...form.connections }
                      if (v) connections[kind] = v
                      else delete connections[kind]
                      setForm({ ...form, connections })
                    }}
                    options={[
                      { value: '', label: t('common.none') },
                      ...snap.config.connections.filter((c) => c.kind === kind).map((c) => ({ value: c.id, label: c.name || c.id }))
                    ]}
                  />
                </Field>
              ))}
            </div>
          </FieldGroup>
          <FieldGroup legend={t('settings.accounts')}>
            {snap.config.accounts.length === 0 && <p className="py-2 text-sm text-subtle">{t('settings.noAccounts')}</p>}
            {snap.config.accounts.map((a) => (
              <SwitchRow key={a.id} label={`${a.name} (${a.agentId})`}>
                <Switch checked={form.accountIds.includes(a.id)} onChange={(on) => setForm({ ...form, accountIds: toggle(form.accountIds, a.id, on) })} />
              </SwitchRow>
            ))}
          </FieldGroup>
          <FieldGroup legend={t('settings.agentsOffered')}>
            <SwitchRow label={t('settings.allAgents')}>
              <Switch
                checked={allAgents}
                onChange={(on) => {
                  const next = { ...form }
                  if (on) delete next.agentIds
                  else next.agentIds = []
                  setForm(next)
                }}
              />
            </SwitchRow>
            {!allAgents &&
              snap.agents.map((a) => (
                <SwitchRow key={a.id} label={a.name}>
                  <Switch checked={form.agentIds?.includes(a.id) ?? false} onChange={(on) => setForm({ ...form, agentIds: toggle(form.agentIds ?? [], a.id, on) })} />
                </SwitchRow>
              ))}
          </FieldGroup>
          <FieldGroup legend={t('settings.agentOrder')}>
            <p className="pt-1 text-sm text-subtle">{t('settings.agentOrderHint')}</p>
            <AgentOrderList agents={orderedAgents} onChange={(keys) => setForm({ ...form, preferredAgents: keys })} />
          </FieldGroup>
          <FieldGroup legend={t('settings.modules')}>
            {OPTIONAL_MODULES.map((m) => (
              <SwitchRow key={m} label={t(MODULE_LABEL[m])}>
                <Switch checked={form.modules[m]} onChange={(on) => setForm({ ...form, modules: { ...form.modules, [m]: on } })} />
              </SwitchRow>
            ))}
          </FieldGroup>
          <FieldGroup legend={t('aiReview.settings.legend')}>
            <AiReviewProfileFields form={form} agents={orderedAgents} onChange={(aiReview) => setForm({ ...form, aiReview })} />
          </FieldGroup>
          <FieldGroup legend={t('nav.slack')}>
            <SlackArchiveField value={form.slackArchiveMinutes} onChange={(minutes) => setForm({ ...form, slackArchiveMinutes: minutes })} />
          </FieldGroup>
        </>
      }
      actions={
        <>
          <Button variant="primary" onClick={() => void save()}>
            {t('settings.saveProfile')}
          </Button>
          {selected && snap.config.activeProfileId !== selected && (
            <Button onClick={() => void run(() => window.hub.config.setActiveProfile(selected))}>{t('settings.makeActive')}</Button>
          )}
          {selected && (
            <Button variant="danger" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => void run(() => window.hub.config.deleteProfile(selected)).then((ok) => ok && select(null))}>
              {t('common.delete')}
            </Button>
          )}
        </>
      }
    />
  )
}
