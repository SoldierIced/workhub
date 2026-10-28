import { Activity, ChevronRight, FolderCog, TriangleAlert, Gauge, MessageSquare, Languages, Palette, Plug, Plus, Ticket, Users, UserCog } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  appOptions,
  automaticProfileColor,
  CONNECTION_KINDS,
  FAILOVER_MODES,
  failoverMode,
  NO_MODULES,
  OFFERED_MODULES,
  orderAgents,
  resolveEffectiveAgents,
  slugId,
  type AgentAccount,
  type Connection,
  type ConnectionKind,
  type FailoverMode,
  type OfferedModule,
  type Profile,
  type Result,
  type SecretChange,
  type ValidationIssue,
  type WorkhubConfig
} from '@workhub/core'
import type { AgentOptionsView, ConfigSnapshot, Workhub1Preview } from '@shared/api'
import { Badge, Button, Input, Select, Switch, Textarea } from '../components/atoms'
import { AgentOrderList, Card, CardBody, CardHeader, EmptyState, Field, HelpTip, ListRow, SwitchRow, Tabs, useToast } from '../components/molecules'
import { Workhub1Import, Workhub1SecretsImport } from '../components/organisms'
import { DeleteButton, useUnsavedChanges, useUnsavedForm } from '../components/organisms/UnsavedChanges'
import { refreshConfig } from '../configStore'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { accountEnvHintKey, accountListItems, signInEntries, SIGN_IN_ID_PREFIX } from '../lib/agents'
import { useAccountUsage } from '../lib/usage'
import { accountFieldErrors, friendlyIssue, humanIssue, profileFieldErrors, type IssueTarget } from '../lib/configIssues'
import { showWorkhub1Migration, showWorkhub1Tokens, useWorkhub1Preview } from '../lib/workhub1'
import { setPrefs, usePrefs } from '../lib/prefs'
import { isDirty, type SaveOutcome } from '../lib/unsavedChanges'
import { AiReviewProfileFields } from './AiReviewSettings'
import { ProfileColorField } from './ProfileColorField'
import { HealthSettings } from './HealthSettings'
import { SlackArchiveField, SlackSettings } from './SlackSettings'
import { PullRequestNotificationRows } from './PullRequestNotificationSettings'
import { DefaultFolderField, ProfileExtraFields, prunedFolderOptions, useProfileEnvDraft } from './ProfileExtraSettings'
import { SetupEntryGroup } from './SetupEntryGroup'
import { AppBadgeRows, MenuBarRows, OtherNotificationRows } from './NotificationExtraSettings'
import { NotificationMasterRows } from './NotificationMasterRow'
import { VoiceSettingsGroup } from './VoiceSettings'
import { ProtectedBranchesRows } from './ProtectedBranchesRows'
import { TrackerSettings } from './TrackerSettings'
import { UpdatesSettings } from './UpdatesSettings'
import { UsageSettings } from './UsageSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { AgentsOverview, SignInDetail } from './AgentsSettings'
import { SettingRow, SettingsGroup } from './settings/SettingsLayout'

const KIND_LABEL: Record<ConnectionKind, MessageKey> = {
  codeHost: 'kind.codeHost',
  tracker: 'kind.tracker',
  chat: 'kind.chat',
  health: 'kind.health'
}
const MODULE_LABEL: Record<OfferedModule, MessageKey> = {
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
  const { t } = useI18n()
  if (!issues.length) return null
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <ul className="flex flex-col gap-0.5">
        {[...new Set(issues.map((i) => friendlyIssue(i, (k, p) => t(k, p))))].map((text) => (
          <li key={text}>{text}</li>
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

/** The stored config's problems in plain words, each with a button to the form that fixes it. */
function StoredIssues({ snap, onFix }: { snap: ConfigSnapshot; onFix: (target: IssueTarget) => void }) {
  const { t } = useI18n()
  if (!snap.issues.length) return null
  const items = snap.issues.map((i) => humanIssue(i, snap.config, snap.providers, (k) => t(k)))
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3" data-testid="stored-issues">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-text">{t('issues.title')}</p>
        <ul className="mt-1 flex flex-col gap-1.5">
          {items.map((i) => (
            <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-text" title={i.technical}>
              <span className="min-w-0">{t(i.message, i.params)}</span>
              {i.action && (
                <Button size="sm" onClick={() => onFix(i.action!.target)}>
                  {t(i.action.label)}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** One-sentence description under the tab bar: what the tab is for. */
function TabIntro({ text }: { text: string }) {
  return <p className="-mt-1 max-w-3xl text-base text-muted">{text}</p>
}

export interface SettingsScreenProps {
  snap: ConfigSnapshot | null
  tab: string
  onTabChange: (tab: string) => void
  /** Replaces the plain title, e.g. with the modal's title and close button. */
  heading?: ReactNode
}

export function SettingsScreen({ snap, tab, onTabChange, heading }: SettingsScreenProps) {
  const { t } = useI18n()
  const notify = useToast()
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  // The item a "fix" button asked to open; the tab's form starts on it.
  const [focus, setFocus] = useState<IssueTarget | null>(null)
  // Workhub 1 on this Mac (read again after every config change): drives the migration UI's visibility.
  const workhub1 = useWorkhub1Preview(snap?.config)

  const unsaved = useUnsavedChanges()

  const run: Run = async (op) => {
    const r = await op()
    if (!r.ok) {
      setIssues(r.issues)
      const first = r.issues[0]
      unsaved.reportProblem(first ? friendlyIssue(first, (k, p) => t(k, p)) : null)
      return false
    }
    setIssues([])
    unsaved.reportProblem(null)
    // A save from the save bar says "Saved" there; a switch that saves at once says it here.
    if (!unsaved.snapshot().saving) notify(t('settings.saved'))
    await refreshConfig()
    return true
  }

  if (!snap) return null
  const section = (node: ReactNode, intro?: string) => (
    <div className="flex flex-col gap-4">
      {intro && <TabIntro text={intro} />}
      <Issues issues={issues} />
      {node}
    </div>
  )
  const focusId = (t: IssueTarget['tab']) => (focus?.tab === t ? focus.id : undefined)
  const fix = (target: IssueTarget) =>
    unsaved.requestLeave(() => {
      setIssues([])
      setFocus({ ...target })
      onTabChange(target.tab)
    })
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col px-8 pb-7">
      <Tabs
        variant="fill"
        header={
          <>
            {heading ?? <h1 className="text-2xl font-semibold tracking-tight">{t('nav.settings')}</h1>}
            {snap.loadError && <Issues title={t('settings.loadError')} issues={[{ path: 'config.json', message: snap.loadError }]} />}
            <StoredIssues snap={snap} onFix={fix} />
            {showWorkhub1Tokens(window.hub.platform, workhub1) && (
              <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-sm">
                <Workhub1SecretsImport compact />
              </div>
            )}
          </>
        }
        label={t('nav.settings')}
        value={tab}
        onChange={(v) =>
          unsaved.requestLeave(() => {
            setIssues([])
            setFocus(null)
            onTabChange(v)
          })
        }
        items={[
          { value: 'general', label: t('settings.general'), icon: <Languages className="size-4" aria-hidden />, content: section(<GeneralSection snap={snap} run={run} workhub1={workhub1} />, t('help.tab.general')) },
          { value: 'appearance', label: t('settings.appearance'), icon: <Palette className="size-4" aria-hidden />, content: section(<AppearanceSettings />, t('help.tab.appearance')) },
          { value: 'profiles', label: t('settings.profiles'), icon: <Users className="size-4" aria-hidden />, content: section(
              <div className="flex flex-col gap-6">
                <ProfilesSection key={focusId('profiles')} snap={snap} run={run} initialId={focusId('profiles')} />
                <SetupEntryGroup />
              </div>,
              t('help.tab.profiles')
            ) },
          { value: 'connections', label: t('settings.connections'), icon: <Plug className="size-4" aria-hidden />, content: section(<ConnectionsSection key={focusId('connections')} snap={snap} run={run} initialId={focusId('connections')} />, t('help.tab.connections')) },
          { value: 'trackers', label: t('trackers.tab'), icon: <Ticket className="size-4" aria-hidden />, content: section(<TrackerSettings key={focusId('trackers')} snap={snap} run={run} initialId={focusId('trackers')} />) },
          { value: 'health', label: t('health.settings.tab'), icon: <Activity className="size-4" aria-hidden />, content: section(<HealthSettings snap={snap} run={run} focusSecret={focus?.tab === 'health'} />) },
          { value: 'slack', label: t('nav.slack'), icon: <MessageSquare className="size-4" aria-hidden />, content: section(<SlackSettings snap={snap} run={run} />) },
          { value: 'accounts', label: t('settings.accounts'), icon: <UserCog className="size-4" aria-hidden />, content: section(<AccountsSection key={focusId('accounts')} snap={snap} run={run} initialId={focusId('accounts')} />, t('help.tab.accounts')) },
          { value: 'usage', label: t('agentUsage.settings.tab'), icon: <Gauge className="size-4" aria-hidden />, content: section(<UsageSettings snap={snap} run={run} />, t('help.tab.usage')) }
        ]}
      />
    </div>
  )
}

function GeneralSection({ snap, run, workhub1 }: SectionProps & { workhub1: Workhub1Preview | null }) {
  const { t } = useI18n()
  const { language } = usePrefs()
  const options = appOptions(snap.config)
  const editable = !snap.loadError
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t('settings.interface')} help={t('help.general.interface')} footnote={t('settings.languageHint')}>
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
      <SettingsGroup title={t('settings.sessionsGroup')} help={t('help.general.sessions')}>
        <SwitchRow label={t('settings.reopenSessions')} hint={t('settings.reopenSessionsHint')}>
          <Switch
            checked={options.reopenSessions}
            disabled={!editable}
            aria-label={t('settings.reopenSessions')}
            onChange={(on) => void run(() => window.hub.config.saveOptions({ reopenSessions: on }))}
          />
        </SwitchRow>
      </SettingsGroup>
      <SettingsGroup title={t('settings.notifications')} help={t('help.general.notifications')} footnote={t('settings.notificationsNote')}>
        <NotificationMasterRows config={snap.config} editable={editable} run={run} />
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
      <SettingsGroup title={t('settings.otherNotifications')} help={t('help.general.otherNotifications')} footnote={t('settings.otherNotificationsNote')}>
        <OtherNotificationRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      <VoiceSettingsGroup config={snap.config} editable={editable} run={run} />
      <SettingsGroup title={t('settings.menuBar')} help={t('help.general.menuBar')} footnote={window.hub.platform === 'linux' ? t('settings.keepInTrayLinuxNote') : undefined}>
        <MenuBarRows config={snap.config} editable={editable} run={run} />
        <AppBadgeRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('updates.group')} help={t('help.general.updates')} footnote={window.hub.platform === 'mac' ? t('updates.macNote') : undefined}>
        <UpdatesSettings enabled={options.checkForUpdates} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('prevent.settings.title')} help={t('help.general.prEvents')} footnote={t('prevent.settings.note')}>
        <PullRequestNotificationRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('settings.pullRequests')}>
        <ProtectedBranchesRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('settings.storage')} help={t('help.general.storage')}>
        <div className="flex items-center gap-3 py-3">
          <FolderCog className="size-4 text-muted" aria-hidden />
          <span className="flex-1 text-base">{t('settings.dataDir')}</span>
          <code className="truncate text-sm text-muted" title={snap.dataDir}>
            {snap.dataDir}
          </code>
        </div>
      </SettingsGroup>
      {editable && showWorkhub1Migration(window.hub.platform, workhub1) && (
        <details className="group rounded-lg border border-border bg-surface shadow-sm" data-testid="workhub1-migration">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 select-none">
            <ChevronRight className="size-4 text-muted transition-transform group-open:rotate-90" aria-hidden />
            <span className="text-md font-semibold">{t('import.migrate')}</span>
            <HelpTip text={t('help.general.import')} label={t('import.migrate')} />
            <span className="ml-2 min-w-0 truncate text-sm text-subtle">{t('import.migrateHint')}</span>
          </summary>
          <div className="border-t border-border px-4">
            <Workhub1Import run={run} showTokens={showWorkhub1Tokens(window.hub.platform, workhub1)} />
          </div>
        </details>
      )}
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
  /** Actions on the selected item (make active, delete), next to its name; none for an entry that is only shown (an agent's own sign-in). Saving is the save bar's. */
  headerActions?: ReactNode
}) {
  // Picking another item (or New) asks first when the form has unsaved changes.
  const unsaved = useUnsavedChanges()
  const pick = (id: string | null) => unsaved.requestLeave(() => props.onSelect(id))
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <Card>
        <CardHeader
          title={props.title}
          as="h2"
          actions={
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => pick(null)}>
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
                  <ListRow title={props.label(i)} trailing={props.meta?.(i)} selected={props.selected === i.id} onClick={() => pick(i.id)} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={props.formTitle} as="h2" actions={props.headerActions} />
        <CardBody className="flex flex-col gap-4">{props.form}</CardBody>
      </Card>
    </div>
  )
}

function FieldGroup({ legend, help, children }: { legend: string; help?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="rounded-md border border-border px-3 pt-1 pb-2">
      <legend className="flex items-center gap-1.5 px-1 text-sm font-medium text-muted">
        {legend}
        {help && <HelpTip text={help} label={legend} />}
      </legend>
      {children}
    </fieldset>
  )
}

const emptyConnection = (): Connection => ({ id: '', kind: 'codeHost', provider: 'github', settings: {} })

function ConnectionsSection({ snap, run, initialId }: SectionProps & { initialId?: string }) {
  const { t } = useI18n()
  // Opens on the asked-for connection, else the first one: a blank "new" form only when there is none.
  const initial = snap.config.connections.find((x) => x.id === initialId) ?? snap.config.connections[0]
  const [selected, setSelected] = useState<string | null>(initial?.id ?? null)
  const [form, setForm] = useState<Connection>(initial ? { ...initial } : emptyConnection())
  const [settingsText, setSettingsText] = useState(toLines(initial?.settings))
  const secretInput = useRef<HTMLInputElement>(null)
  // Opened from "Enter token": put the cursor in the secret field.
  useEffect(() => {
    if (initialId) secretInput.current?.focus()
  }, [initialId])
  const [secret, setSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [idError, setIdError] = useState(false)
  // What the form held when it was loaded or last saved: the save bar shows while it differs.
  const [baseline, setBaseline] = useState(() => ({ form, settingsText }))

  const select = (id: string | null) => {
    const c = snap.config.connections.find((x) => x.id === id)
    const next = c ? { ...c } : emptyConnection()
    setSelected(c ? c.id : null)
    setForm(next)
    setSettingsText(toLines(c?.settings))
    setBaseline({ form: next, settingsText: toLines(c?.settings) })
    setSecret('')
    setClearSecret(false)
    setIdError(false)
  }

  const providers = snap.providers.filter((p) => p.kind === form.kind)
  const provider = snap.providers.find((p) => p.id === form.provider)
  const hasSecret = selected !== null && snap.connectionsWithSecret.includes(selected)

  const save = async (): Promise<SaveOutcome> => {
    if (!form.id.trim()) {
      setIdError(true)
      return { ok: false, problem: t('settings.idRequired') }
    }
    const change: SecretChange = clearSecret ? { action: 'clear' } : secret ? { action: 'set', value: secret } : { action: 'keep' }
    const connection: Connection = { ...form, settings: fromLines(settingsText) }
    if (!connection.endpoint) delete connection.endpoint
    if (!connection.name) delete connection.name
    if (!(await run(() => window.hub.config.saveConnection(connection, change)))) return { ok: false }
    setSelected(connection.id)
    setSecret('')
    setClearSecret(false)
    setBaseline({ form, settingsText })
    return { ok: true }
  }
  useUnsavedForm({
    dirty: isDirty(baseline, { form, settingsText }) || secret !== '' || clearSecret,
    draft: { form, settingsText, secret, clearSecret },
    save,
    discard: () => select(selected)
  })

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
          <Field label={t('settings.id')} help={t('help.id')} error={idError ? t('settings.idRequired') : undefined}>
            <Input
              value={form.id}
              disabled={selected !== null}
              onChange={(e) => {
                setForm({ ...form, id: e.target.value })
                setIdError(false)
              }}
              placeholder="acme-github"
            />
          </Field>
          <Field label={t('settings.name')}>
            <Input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme GitHub" />
          </Field>
          <Field label={t('settings.kind')} help={t('help.connection.kind')}>
            <Select
              value={form.kind}
              onChange={(v) => {
                const kind = v as ConnectionKind
                setForm({ ...form, kind, provider: snap.providers.find((p) => p.kind === kind)?.id ?? '' })
              }}
              options={CONNECTION_KINDS.map((k) => ({ value: k, label: t(KIND_LABEL[k]) }))}
            />
          </Field>
          <Field label={t('settings.provider')} help={t('help.connection.provider')}>
            <Select
              value={form.provider}
              onChange={(v) => setForm({ ...form, provider: v })}
              options={providers.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Field>
          <Field label={provider?.requiresEndpoint ? t('settings.endpointRequired') : t('settings.endpoint')} help={t('help.connection.endpoint')} className="col-span-2">
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
            help={t('help.connection.secret')}
            className="col-span-2"
          >
            <Input
              ref={secretInput}
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
          <Field label={t('settings.settingsLines')} help={t('help.connection.settings')} className="col-span-2">
            <Textarea rows={3} value={settingsText} onChange={(e) => setSettingsText(e.target.value)} placeholder="scope=org:acme" spellCheck={false} />
          </Field>
        </div>
      }
      headerActions={selected && <DeleteButton name={form.name || form.id} onDelete={() => void run(() => window.hub.config.deleteConnection(selected)).then((ok) => ok && select(null))} />}
    />
  )
}

const emptyAccount = (agentId: string): AgentAccount => ({ id: '', agentId, name: '' })

function AccountsSection({ snap, run, initialId }: SectionProps & { initialId?: string }) {
  const { t } = useI18n()
  const firstAgent = snap.agents[0]?.id ?? ''
  // Opens on the asked-for account, else the first one: a blank "new" form only when there is none.
  const initial = snap.config.accounts.find((x) => x.id === initialId) ?? snap.config.accounts[0]
  const [selected, setSelected] = useState<string | null>(initial?.id ?? null)
  const [form, setForm] = useState<AgentAccount>(initial ? { ...initial } : emptyAccount(firstAgent))
  const [envText, setEnvText] = useState(toLines(initial?.env))
  // Field problems, shown only after a save attempt.
  const [errors, setErrors] = useState<ReturnType<typeof accountFieldErrors> | null>(null)
  // What the form held when it was loaded or last saved: the save bar shows while it differs.
  const [baseline, setBaseline] = useState(() => ({ form, envText }))
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
    setEnvText(toLines(a?.env))
    setBaseline({ form: next, envText: toLines(a?.env) })
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
    const account: AgentAccount = { ...form, env: fromLines(envText) }
    for (const k of ['command', 'defaultModel', 'defaultMode'] as const) {
      const v = account[k]?.trim()
      if (v) account[k] = v
      else delete account[k]
    }
    if (!account.configDir) delete account.configDir
    if (!Object.keys(account.env ?? {}).length) delete account.env
    if (!(await run(() => window.hub.config.saveAccount(account)))) return { ok: false }
    setSelected(account.id)
    setBaseline({ form, envText })
    return { ok: true }
  }
  useUnsavedForm({ dirty: !signIn && isDirty(baseline, { form, envText }), draft: { form, envText }, save, discard: () => select(selected, form.agentId) })

  return (
    <div className="flex flex-col gap-6">
      <AgentsOverview snap={snap} run={run} onEditAccount={(id) => openForm(id)} onAddAccount={(agentId) => openForm(null, agentId)} />
      <div ref={formRef} className="flex scroll-mt-4 flex-col gap-2">
        <h2 className="flex items-center gap-1.5 px-1 text-md font-semibold">
          {t('settings.accountsList')}
          <HelpTip text={t('help.accounts.list')} label={t('settings.accountsList')} />
        </h2>
        <p className="px-1 text-sm text-subtle" data-testid="accounts-hint">
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
                  <Input
                    value={form.configDir ?? ''}
                    disabled={!agent?.accountConfigEnv}
                    onChange={(e) => setForm({ ...form, configDir: e.target.value })}
                    placeholder="~/.acme-agent"
                    spellCheck={false}
                  />
                </Field>
                <Field label={t('settings.envLines')} hint={envHintKey ? t(envHintKey) : undefined} help={t('help.account.env')} className="col-span-2">
                  <Textarea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="ACME_ACCOUNT=work" spellCheck={false} />
                </Field>
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

const emptyProfile = (): Profile => ({ id: '', name: '', connections: {}, accountIds: [], modules: { ...NO_MODULES } })

function ProfilesSection({ snap, run, initialId }: SectionProps & { initialId?: string }) {
  const { t } = useI18n()
  const toast = useToast()
  // Opens on the asked-for profile, else the active one: a blank "new" form only when there is none.
  const initial = snap.config.profiles.find((x) => x.id === initialId) ?? snap.config.profiles.find((x) => x.id === snap.config.activeProfileId) ?? snap.config.profiles[0]
  const [selected, setSelected] = useState<string | null>(initial?.id ?? null)
  const [form, setForm] = useState<Profile>(initial ? structuredClone(initial) : emptyProfile())
  // A new profile's id follows its name until the user edits the id themselves.
  const [idEdited, setIdEdited] = useState(false)
  // Field problems, shown only after a save attempt.
  const [errors, setErrors] = useState<ReturnType<typeof profileFieldErrors> | null>(null)
  const env = useProfileEnvDraft(selected ? snap.config.profiles.find((p) => p.id === selected) : undefined)
  // What the form held when it was loaded or last saved: the save bar shows while it differs.
  const [baseline, setBaseline] = useState<Profile>(form)

  const select = (id: string | null) => {
    const p = snap.config.profiles.find((x) => x.id === id)
    const next = p ? structuredClone(p) : emptyProfile()
    setSelected(p ? p.id : null)
    setForm(next)
    setBaseline(next)
    setIdEdited(false)
    setErrors(null)
    env.reset()
  }
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id))
  const allAgents = form.agentIds === undefined
  // The agents this profile offers as it is being edited, in the user's order.
  const orderedAgents = orderAgents(form.preferredAgents, resolveEffectiveAgents({ ...snap.config, profiles: [form] }, form.id || null))

  const save = async (): Promise<SaveOutcome> => {
    // Nothing is sent until the profile is valid: the id and name are the only required fields.
    const found = profileFieldErrors(form, selected ? [] : snap.config.profiles.map((p) => p.id))
    setErrors(found)
    const problem = found.id ?? found.name
    if (problem) return { ok: false, problem: t(problem) }
    const folders = form.folders?.map((f) => f.trim()).filter(Boolean)
    const profile: Profile = { ...form, folders: folders?.length ? folders : undefined }
    if (!profile.folders) delete profile.folders
    if (!profile.preferredAgents?.length) delete profile.preferredAgents
    if (!profile.symbol) delete profile.symbol
    if (!profile.defaultFolder?.trim()) delete profile.defaultFolder
    if (!profile.linkBrowser?.trim()) delete profile.linkBrowser
    else profile.linkBrowser = profile.linkBrowser.trim()
    // Off stays saved as off: a switch the user set is never filled from Workhub 1 again.
    if (profile.ownsOutside === undefined) delete profile.ownsOutside
    const folderOptions = prunedFolderOptions(profile.folderOptions, profile.folders)
    if (folderOptions) profile.folderOptions = folderOptions
    else delete profile.folderOptions
    const envNames = env.names()
    if (envNames.length) profile.envNames = envNames
    else delete profile.envNames
    // Only one profile owns everything outside the folders: taking it lets the others go.
    if (profile.ownsOutside) {
      for (const other of snap.config.profiles.filter((p) => p.id !== profile.id && p.ownsOutside)) {
        if (!(await run(() => window.hub.config.saveProfile({ ...other, ownsOutside: false })))) return { ok: false }
      }
    }
    if (!(await run(() => window.hub.config.saveProfile(profile)))) return { ok: false }
    setSelected(form.id)
    setBaseline(form)
    if (!(await env.commit(profile.id))) {
      toast(t('profileExtra.envSaved'), 'danger')
      return { ok: false, problem: t('profileExtra.envSaved') }
    }
    return { ok: true }
  }
  useUnsavedForm({ dirty: isDirty(baseline, form) || env.dirty, draft: { form, rows: env.rows }, save, discard: () => select(selected) })
  const name = form.name || form.id

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
      formTitle={selected ? name : t('settings.newProfile')}
      form={
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('settings.id')} help={t('help.id')} error={errors?.id && t(errors.id)}>
              <Input
                value={form.id}
                disabled={selected !== null}
                onChange={(e) => {
                  setIdEdited(true)
                  setForm({ ...form, id: e.target.value })
                  setErrors(null)
                }}
                placeholder="acme"
              />
            </Field>
            <Field label={t('settings.name')} error={errors?.name && t(errors.name)}>
              <Input
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value
                  setForm({ ...form, name, ...(selected === null && !idEdited ? { id: name.trim() ? slugId(name, '') : '' } : {}) })
                  setErrors(null)
                }}
                placeholder="Acme"
              />
            </Field>
          </div>
          <ProfileColorField
            value={form.color}
            automatic={automaticProfileColor(selected ? snap.config.profiles.findIndex((p) => p.id === selected) : snap.config.profiles.length)}
            onChange={(color) => setForm(({ color: _old, ...rest }) => (color ? { ...rest, color } : rest))}
          />
          <Field label={t('settings.folders')} hint={t('settings.foldersHint')} help={t('help.profile.folders')}>
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
          <DefaultFolderField form={form} onChange={(folder) => setForm(({ defaultFolder: _old, ...rest }) => (folder ? { ...rest, defaultFolder: folder } : rest))} />
          <ProfileExtraFields form={form} onChange={setForm} env={env} />
          <FieldGroup legend={t('settings.connections')} help={t('help.profile.connections')}>
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
          <FieldGroup legend={t('settings.accountsList')} help={t('help.profile.accounts')}>
            <p className="pt-1 text-sm text-subtle">{t('settings.accountsOwnSignIn')}</p>
            {snap.config.accounts.length === 0 && <p className="py-2 text-sm text-subtle">{t('settings.noAccounts')}</p>}
            {snap.config.accounts.map((a) => (
              <SwitchRow key={a.id} label={`${a.name} · ${snap.agents.find((x) => x.id === a.agentId)?.name ?? a.agentId}`}>
                <Switch checked={form.accountIds.includes(a.id)} onChange={(on) => setForm({ ...form, accountIds: toggle(form.accountIds, a.id, on) })} />
              </SwitchRow>
            ))}
          </FieldGroup>
          <FieldGroup legend={t('settings.agentsOffered')} help={t('help.profile.agentsOffered')}>
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
          <FieldGroup legend={t('settings.agentOrder')} help={t('help.profile.agentOrder')}>
            <p className="pt-1 text-sm text-subtle">{t('settings.agentOrderHint')}</p>
            <AgentOrderList agents={orderedAgents} onChange={(keys) => setForm({ ...form, preferredAgents: keys })} />
          </FieldGroup>
          <FieldGroup legend={t('settings.modules')} help={t('help.profile.modules')}>
            {OFFERED_MODULES.map((m) => (
              <SwitchRow key={m} label={t(MODULE_LABEL[m])}>
                <Switch checked={form.modules[m]} onChange={(on) => setForm({ ...form, modules: { ...form.modules, [m]: on } })} />
              </SwitchRow>
            ))}
          </FieldGroup>
          <FieldGroup legend={t('continuity.settings.legend')} help={t('help.profile.accountFailover')}>
            <Field label={t('continuity.settings.mode')} hint={t('continuity.settings.hint')}>
              <Select
                aria-label={t('continuity.settings.mode')}
                value={failoverMode(form)}
                onChange={(v) => setForm({ ...form, accountFailover: v as FailoverMode })}
                options={FAILOVER_MODES.map((m) => ({ value: m, label: t(`continuity.settings.${m}`) }))}
              />
            </Field>
          </FieldGroup>
          <FieldGroup legend={t('aiReview.settings.legend')} help={t('help.profile.aiReview')}>
            <AiReviewProfileFields form={form} agents={orderedAgents} onChange={(aiReview) => setForm({ ...form, aiReview })} />
          </FieldGroup>
          <FieldGroup legend={t('nav.slack')} help={t('help.profile.slack')}>
            <SlackArchiveField value={form.slackArchiveMinutes} onChange={(minutes) => setForm({ ...form, slackArchiveMinutes: minutes })} />
          </FieldGroup>
        </>
      }
      headerActions={
        selected && (
          <>
            {snap.config.activeProfileId === selected ? (
              <Badge tone="accent">{t('settings.active')}</Badge>
            ) : (
              <Button size="sm" onClick={() => void run(() => window.hub.config.setActiveProfile(selected))} data-testid="profile-make-active">
                {t('settings.makeActive')}
              </Button>
            )}
            <DeleteButton name={name} onDelete={() => void run(() => window.hub.config.deleteProfile(selected)).then((ok) => ok && select(null))} />
          </>
        )
      }
    />
  )
}
