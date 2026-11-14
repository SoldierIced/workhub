import { ChevronDown, ChevronRight, FolderOpen, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  accountAgentId,
  appOptions,
  CLAUDE_MODEL_SUGGESTIONS,
  setCeiling,
  usageAccountKey,
  type AgentAccount,
  type AgentDefinition,
  type UsageBudgetOptions,
  type WorkhubConfig
} from '@workhub/core'
import type { AccountUsage, AgentOptionsView, ConfigSnapshot } from '@shared/api'
import { Avatar, Badge, Button, Input, Select, Switch } from '../../components/atoms'
import { Card, Field, OptionOrCustom, SwitchRow, useToast } from '../../components/molecules'
import { useWindowLabel } from '../../components/molecules/UsageWindowRow'
import { DeleteButton, useUnsavedChanges, useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import type { Locale, MessageKey } from '../../i18n/translate'
import {
  accountIdFromName,
  accountOfferings,
  adoptSignIn,
  initialOffers,
  mostSpentWindow,
  offerChanges,
  signInOffered,
  storedOffers,
  withAccountInProfile,
  type Offering,
  type Offers
} from '../../lib/accountDefaults'
import { budgetWindows } from '../../lib/agent-usage'
import { agentGlyph, defaultSignInFolder, installHintKey, signInEntries, type LoginState, type SignInEntry } from '../../lib/agents'
import { accountFieldErrors } from '../../lib/configIssues'
import { modelOptions } from '../../lib/optionOrCustom'
import { isDirty, type SaveOutcome } from '../../lib/unsavedChanges'
import { useAccountUsage } from '../../lib/usage'
import { usageCeilingLabel } from '../../lib/usage-window'
import { SignInDetail } from '../AgentsSettings'
import { AgentToolsGroup } from './AgentToolsGroup'
import { EnvFields, useAccountEnvDraft } from '../ProfileExtraSettings'
import { AGENTS_ROW_IDS } from './agents-index'
import { ROW_HIGHLIGHT_MS } from './focusRow'
import type { Run } from './run'
import { saveProfilePatch, type SectionProps } from './shared'

/** What the section has open: an account's form (`id` null: a new one) or an agent's own sign-in. */
type Editing = { kind: 'account'; id: string | null; agentId: string } | { kind: 'signIn'; agentId: string } | null

/** The options that turn each agent's usage reading on (by the agent that owns the accounts). */
const READING: Record<string, { option: 'claudePlanUsage' | 'codexUsage' | 'kiroUsage'; label: MessageKey; hint: MessageKey; id: string }> = {
  claude: { option: 'claudePlanUsage', label: 'settingsAgents.reading.claude', hint: 'settingsAgents.reading.claudeHint', id: AGENTS_ROW_IDS.readingClaude },
  codex: { option: 'codexUsage', label: 'settingsAgents.reading.codex', hint: 'settingsAgents.reading.codexHint', id: AGENTS_ROW_IDS.readingCodex },
  kiro: { option: 'kiroUsage', label: 'settingsAgents.reading.kiro', hint: 'settingsAgents.reading.kiroHint', id: AGENTS_ROW_IDS.readingKiro }
}

/** Agents that take accounts of their own: not a terminal, not one that uses another agent's accounts. */
const takesAccounts = (agent: AgentDefinition, agents: readonly AgentDefinition[]) => agent.adapter !== 'terminal' && !(agent.accountsOf && agents.some((b) => b.id === agent.accountsOf))

/** "1st", "2nd"… in English; "1.º", "2.º"… in Spanish. */
export function ordinal(n: number, locale: Locale): string {
  if (locale === 'es') return `${n}.º`
  const suffix: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th' }
  return `${n}${suffix[new Intl.PluralRules('en', { type: 'ordinal' }).select(n)] ?? 'th'}`
}

/** "offered in Acme web (1st), Side project (2nd)", or that no profile offers it. */
export function offeringText(offerings: readonly Offering[], t: (key: MessageKey, params?: Record<string, string | number>) => string, locale: Locale): string {
  if (!offerings.length) return t('settingsAgents.notOffered')
  return t('settingsAgents.offeredIn', { list: offerings.map((o) => t('settingsAgents.offeredItem', { profile: o.profileName, position: ordinal(o.position, locale) })).join(', ') })
}

function loginOf(read: AccountUsage | undefined): LoginState {
  if (!read) return { state: 'unknown' }
  if (read.windows.length) return { state: 'ok' }
  return read.error ? { state: 'error', error: read.error } : { state: 'unknown' }
}

/**
 * Settings → Agents: one card per agent installed on this computer, each with its own sign-in and
 * its accounts (what each one is, where it is offered, its usage), the form to add or edit one,
 * and the agent's usage reading switch; then the agents Workhub did not find. Which agents a
 * profile offers, their order and the failover are set in the profile.
 */
export function AccountsSection({ snap, run, initialId, profileId }: SectionProps & { initialId?: string; profileId?: string | null }) {
  const { t } = useI18n()
  const unsaved = useUnsavedChanges()
  const root = useRef<HTMLDivElement>(null)
  const agents = snap.agents
  const config = snap.config
  const initialAccount = config.accounts.find((x) => x.id === initialId)
  const [editing, setEditing] = useState<Editing>(initialAccount ? { kind: 'account', id: initialAccount.id, agentId: initialAccount.agentId } : null)
  const reads = useAccountUsage()
  const [availability, setAvailability] = useState<Record<string, boolean> | null>(null)
  const [searching, setSearching] = useState(false)
  const search = () => {
    setSearching(true)
    return window.hub.agents.availability().then(
      (a) => {
        setAvailability(a)
        setSearching(false)
      },
      () => setSearching(false)
    )
  }
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
  // A search result points at a row by its id: scroll to it and highlight it for a moment.
  useEffect(() => {
    if (!initialId || !root.current) return
    const row = root.current.querySelector<HTMLElement>(`[data-setting-id="${CSS.escape(initialId)}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    row.classList.add('ring-2', 'ring-accent', 'rounded-md')
    const timer = window.setTimeout(() => row.classList.remove('ring-2', 'ring-accent', 'rounded-md'), ROW_HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [initialId])

  const options = appOptions(config)
  const editable = !snap.loadError
  const signIns = signInEntries(agents, reads, availability)
  const workingProfile = profileId ?? config.activeProfileId ?? config.profiles[0]?.id ?? null
  const open = (next: Editing) => unsaved.requestLeave(() => setEditing(next))
  const close = () => setEditing(null)
  const saveBudget = (next: UsageBudgetOptions) => run(() => window.hub.config.saveOptions({ usageBudget: next }))
  const toggleReading = (option: 'claudePlanUsage' | 'codexUsage' | 'kiroUsage', on: boolean) =>
    void run(() => window.hub.config.saveOptions({ [option]: on })).then((ok) => ok && void window.hub.usage.get(true))

  // The agents that own their accounts, each with the engines that share them (Claude Code over ACP).
  const families = agents.filter((a) => !(a.accountsOf && agents.some((b) => b.id === a.accountsOf)))
  const missing = families.filter((a) => availability !== null && availability[a.id] === false)
  const shown = families.filter((a) => !missing.includes(a))

  return (
    <div ref={root} className="flex flex-col gap-6" data-testid="agents-section">
      <div className="flex flex-col gap-4" data-setting-id={AGENTS_ROW_IDS.agents} data-settings-group="accounts">
        {shown.map((agent) => {
          const owner = accountAgentId(agent)
          const reading = READING[owner]
          return (
            <section key={agent.id} className="flex flex-col gap-2" data-testid="agents-card" data-agent={agent.id}>
              <AgentCard
                snap={snap}
                run={run}
                agent={agent}
                variants={agents.filter((a) => a.accountsOf === agent.id)}
                signIn={signIns.find((s) => s.agent.id === agent.id)}
                installed={availability ? availability[agent.id] : undefined}
                reads={reads}
                budget={options.usageBudget}
                editing={editing}
                workingProfile={workingProfile}
                onOpen={open}
                onClose={close}
                onSaveBudget={saveBudget}
              />
              {reading && (
                <div className="px-4" data-setting-id={reading.id} data-settings-row>
                  <SwitchRow label={t(reading.label)} hint={t(reading.hint)}>
                    <Switch aria-label={`${t(reading.label)} · ${agent.name}`} checked={options[reading.option]} disabled={!editable} onChange={(on) => toggleReading(reading.option, on)} />
                  </SwitchRow>
                </div>
              )}
            </section>
          )
        })}
      </div>
      {missing.length > 0 && (
        <section className="flex flex-col gap-2" data-setting-id={AGENTS_ROW_IDS.missing} data-testid="agents-missing">
          <div className="flex items-start gap-3 px-1">
            <div className="min-w-0 flex-1">
              <h2 className="text-md font-semibold">{t('settingsAgents.missing.title')}</h2>
              <p className="text-xs text-subtle">{t('settingsAgents.missing.hint')}</p>
            </div>
            <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} disabled={searching} onClick={() => void search()} data-testid="agents-search-again">
              {t(searching ? 'settingsAgents.missing.searching' : 'settingsAgents.missing.search')}
            </Button>
          </div>
          <Card className="divide-y divide-border px-4">
            {missing.map((agent) => (
              <div key={agent.id} className="flex flex-col gap-0.5 py-2.5" data-agent={agent.id}>
                <span className="text-base font-medium">{agent.name}</span>
                <span className="text-xs text-subtle">{t(installHintKey(agent.id), { command: agent.command })}</span>
              </div>
            ))}
          </Card>
        </section>
      )}
      <AgentToolsGroup snap={snap} run={run} />
    </div>
  )
}

/** One agent: its header (installed, Add account), its own sign-in and its accounts, each one opening its form in place. */
function AgentCard(props: {
  snap: ConfigSnapshot
  run: Run
  agent: AgentDefinition
  variants: AgentDefinition[]
  signIn: SignInEntry | undefined
  installed: boolean | undefined
  reads: AccountUsage[]
  budget: UsageBudgetOptions
  editing: Editing
  workingProfile: string | null
  onOpen: (next: Editing) => void
  onClose: () => void
  onSaveBudget: (next: UsageBudgetOptions) => Promise<boolean>
}) {
  const { t, locale } = useI18n()
  const windowLabel = useWindowLabel()
  const { snap, agent, editing } = props
  const owner = accountAgentId(agent)
  const accounts = snap.config.accounts.filter((a) => a.agentId === owner)
  const withAccounts = takesAccounts(agent, snap.agents)
  const onePerComputer = owner === 'kiro'
  const addLabel = onePerComputer ? t('settingsAgents.addVariant') : t('settingsAgents.addAccount')
  const readOf = (accountId: string | null) => props.reads.find((r) => r.key === usageAccountKey(owner, accountId))
  const usageText = (accountId: string | null): string | null => {
    const read = readOf(accountId)
    const top = read ? mostSpentWindow(read.windows, props.budget.ceilings[usageAccountKey(owner, accountId)]) : undefined
    if (!top) return null
    const window = windowLabel(top.window)
    return top.ceiling !== undefined ? t('settingsAgents.usageCap', { window, percent: top.percent, cap: top.ceiling }) : t('settingsAgents.usage', { window, percent: top.percent })
  }
  const adding = editing?.kind === 'account' && editing.id === null && editing.agentId === owner ? editing : null

  return (
    <Card className="flex flex-col px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <h2 className="text-md font-semibold">{agent.name}</h2>
        <span className="text-xs text-subtle" data-testid="agents-card-state">
          {props.installed === undefined ? t('settingsAgents.checking') : t(props.installed ? 'settingsAgents.installed' : 'settingsAgents.notInstalled')}
          {onePerComputer && ` · ${t('settingsAgents.onePerComputer')}`}
        </span>
        {withAccounts && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            icon={<Plus className="size-3.5" aria-hidden />}
            disabled={Boolean(snap.loadError)}
            onClick={() => props.onOpen({ kind: 'account', id: null, agentId: owner })}
            aria-label={`${addLabel} · ${agent.name}`}
            data-testid="agents-add"
          >
            {addLabel}
          </Button>
        )}
      </div>
      {props.variants.length > 0 && <p className="pb-2 text-xs text-subtle">{t('settingsAgents.sharesWith', { agents: props.variants.map((v) => v.name).join(', ') })}</p>}
      {agent.adapter === 'terminal' && <p className="pb-1 text-sm text-subtle">{t('settingsAgents.terminal')}</p>}
      {adding && (
        <AccountForm
          key={`new:${owner}`}
          snap={snap}
          run={props.run}
          account={null}
          agentId={owner}
          workingProfile={props.workingProfile}
          budget={props.budget}
          read={undefined}
          onClose={props.onClose}
        />
      )}
      <ul className="flex flex-col divide-y divide-border border-t border-border">
        {props.signIn && (
          <li data-testid="agents-sign-in" data-agent={agent.id}>
            <Row
              name={t('settingsAgents.signIn.name')}
              summary={[
                t('settingsAgents.signIn.summary'),
                props.signIn.plan,
                defaultSignInFolder(agent) && t('settingsAgents.folder', { folder: defaultSignInFolder(agent)! }),
                offeringText(accountOfferings(snap.config, owner, null), t, locale)
              ]}
              usage={usageText(null)}
              expanded={editing?.kind === 'signIn' && editing.agentId === agent.id}
              onToggle={() => props.onOpen(editing?.kind === 'signIn' && editing.agentId === agent.id ? null : { kind: 'signIn', agentId: agent.id })}
            />
            {editing?.kind === 'signIn' && editing.agentId === agent.id && (
              <div className="flex flex-col gap-3 pb-3">
                <SignInDetail entry={props.signIn} snap={snap} run={props.run} onAddAccount={() => props.onOpen({ kind: 'account', id: null, agentId: owner })} />
                <BudgetFields
                  budgetKey={usageAccountKey(owner, null)}
                  agentId={owner}
                  read={readOf(null)}
                  value={props.budget.ceilings[usageAccountKey(owner, null)] ?? {}}
                  disabled={Boolean(snap.loadError)}
                  onChange={(window, n) => void props.onSaveBudget(setCeiling(props.budget, usageAccountKey(owner, null), window, n))}
                />
              </div>
            )}
          </li>
        )}
        {accounts.map((account) => {
          const open = editing?.kind === 'account' && editing.id === account.id
          const read = readOf(account.id)
          const folder = agent.accountConfigEnv ? account.configDir || defaultSignInFolder(agent) : undefined
          return (
            <li key={account.id} data-testid="agents-account" data-account={account.id}>
              <Row
                name={account.name || account.id}
                summary={[read?.windows.find((w) => w.plan)?.plan, folder && t('settingsAgents.folder', { folder }), offeringText(accountOfferings(snap.config, owner, account.id), t, locale)]}
                usage={usageText(account.id)}
                expanded={open}
                onToggle={() => props.onOpen(open ? null : { kind: 'account', id: account.id, agentId: owner })}
              />
              {open && (
                <AccountForm snap={snap} run={props.run} account={account} agentId={owner} workingProfile={props.workingProfile} budget={props.budget} read={read} onClose={props.onClose} />
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** One sign-in of an agent: initial, name, what it is and where it is offered, its usage, and Edit. */
function Row({ name, summary, usage, expanded, onToggle }: { name: string; summary: (string | false | undefined | null)[]; usage: string | null; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Avatar name={name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-medium">{name}</div>
        <div className="truncate text-xs text-subtle" data-testid="agents-row-summary">
          {summary.filter(Boolean).join(' · ')}
        </div>
      </div>
      {usage && (
        <span className="shrink-0 text-xs text-muted tabular-nums" data-testid="agents-row-usage">
          {usage}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={expanded}
        aria-label={t('settingsAgents.editLabel', { name })}
        icon={expanded ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        onClick={onToggle}
      >
        {t('settingsAgents.edit')}
      </Button>
    </div>
  )
}

/** "Stop sending automatic work past the…": one percentage per window of the account's plan. */
function BudgetFields({
  budgetKey,
  agentId,
  read,
  value,
  disabled,
  onChange
}: {
  budgetKey: string
  agentId: string
  read: AccountUsage | undefined
  value: Readonly<Record<string, number>>
  disabled: boolean
  onChange: (window: string, ceiling: number | null) => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-1.5" data-testid="agents-budget" data-budget-key={budgetKey}>
      <span className="text-sm font-medium text-muted">{t('settingsAgents.form.budget')}</span>
      <div className="flex flex-wrap gap-3">
        {budgetWindows(read?.windows ?? [], value, agentId).map((window) => (
          <CeilingInput key={window} label={usageCeilingLabel(window, t)} value={value[window]} disabled={disabled} onCommit={(n) => onChange(window, n)} />
        ))}
      </div>
      <p className="text-xs text-subtle">{t('settingsAgents.form.budgetHint')}</p>
    </div>
  )
}

/** A percentage written when it loses focus or on Enter; empty clears it. */
function CeilingInput({ label, value, disabled, onCommit }: { label: string; value: number | undefined; disabled: boolean; onCommit: (n: number | null) => void }) {
  const { t } = useI18n()
  const shown = value === undefined ? '' : String(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = (raw: string) => {
    const trimmed = raw.trim()
    const n = trimmed === '' ? null : Math.min(100, Math.max(1, Math.round(Number(trimmed))))
    if (n !== null && !Number.isFinite(n)) return setText(shown)
    if (n !== (value ?? null)) onCommit(n)
  }
  return (
    <label className="flex w-40 flex-col gap-1 text-xs text-subtle">
      {label}
      <Input
        type="number"
        min={1}
        max={100}
        inputMode="numeric"
        aria-label={label}
        value={text}
        placeholder={t('settingsAgents.form.budgetNone')}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
      />
    </label>
  )
}

interface Draft {
  form: AgentAccount
  offers: Offers
  ceilings: Record<string, number>
}

/** The profiles that offer an agent's own sign-in today and would lose it if the draft's profiles get this account. */
export function signInLosses(config: WorkhubConfig, agentId: string, offers: Offers): string[] {
  return config.profiles.filter((p) => offers[p.id] && signInOffered(config, p.id, agentId)).map((p) => p.name || p.id)
}

/**
 * The form of one account (`account` null: a new one of `agentId`): name, agent, sign-in folder,
 * the profiles that offer it, and under "More options" the session defaults, the usage ceilings,
 * the environment and the command. Saved by its own button or the save bar.
 */
export function AccountForm({
  snap,
  run,
  account,
  agentId,
  preset,
  workingProfile,
  budget,
  read,
  onClose
}: {
  snap: ConfigSnapshot
  run: Run
  account: AgentAccount | null
  agentId: string
  preset?: Partial<AgentAccount>
  /** The profile a new account is offered in by default. */
  workingProfile: string | null
  budget: UsageBudgetOptions
  read: AccountUsage | undefined
  onClose: () => void
}) {
  const { t, tn } = useI18n()
  const toast = useToast()
  const config = snap.config
  const isNew = account === null
  const takenIds = config.accounts.map((a) => a.id)
  const [saved, setSaved] = useState<AgentAccount | null>(account)
  const [baseline, setBaseline] = useState<Draft>(() => ({
    form: account ? { ...account } : { id: '', agentId, name: '' },
    offers: storedOffers(config, account?.id ?? null),
    ceilings: account ? { ...(budget.ceilings[usageAccountKey(account.agentId, account.id)] ?? {}) } : {}
  }))
  const [draft, setDraft] = useState<Draft>(() => {
    const name = preset?.name ?? ''
    const form: AgentAccount = account ? { ...account } : { id: name ? accountIdFromName(name, takenIds) : '', agentId, name, ...preset }
    return { form, offers: initialOffers(config, account?.id ?? null, workingProfile), ceilings: { ...baseline.ceilings } }
  })
  // What the form opened with: the save bar shows once the user changes something.
  const [opened] = useState<Draft>(draft)
  const { form } = draft
  const setForm = (patch: Partial<AgentAccount>) => setDraft((d) => ({ ...d, form: { ...d.form, ...patch } }))
  const [idEdited, setIdEdited] = useState(false)
  const [more, setMore] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const env = useAccountEnvDraft(saved ?? undefined)
  const [errors, setErrors] = useState<ReturnType<typeof accountFieldErrors> | null>(null)
  const agents = snap.agents
  const agent = agents.find((a) => a.id === form.agentId)
  const configurable = agent !== undefined && agent.adapter !== 'terminal'

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
    // Compared with what is stored, not with the form's first state: a new account starts
    // checked in the working profile, and that check is written too.
    for (const change of offerChanges(baseline.offers, draft.offers)) {
      if (!(await saveProfilePatch(run, change.profileId, (p) => withAccountInProfile(p, next.id, change.on)))) return { ok: false }
    }
    if (isDirty(baseline.ceilings, draft.ceilings)) {
      const key = usageAccountKey(next.agentId, next.id)
      let nextBudget = budget
      for (const window of new Set([...Object.keys(baseline.ceilings), ...Object.keys(draft.ceilings)])) nextBudget = setCeiling(nextBudget, key, window, draft.ceilings[window] ?? null)
      if (!(await run(() => window.hub.config.saveOptions({ usageBudget: nextBudget })))) return { ok: false }
    }
    setBaseline({ ...draft, form: next })
    if (!(await env.commit(next.id))) {
      toast(t('profileExtra.envSaved'), 'danger')
      return { ok: false, problem: t('profileExtra.envSaved') }
    }
    return { ok: true }
  }
  const dirty = isNew || isDirty(baseline, draft) || env.dirty
  useUnsavedForm({
    dirty: isDirty(saved ? baseline : opened, draft) || env.dirty,
    draft: { draft, rows: env.rows },
    save,
    discard: () => {
      setDraft(baseline)
      setErrors(null)
      env.reset()
    }
  })
  const saveNow = async () => {
    if ((await save()).ok) onClose()
  }
  const pickConfigDir = async () => {
    const picked = await window.hub.pickFolder()
    if (picked) setForm({ configDir: picked })
  }
  const accountAgents = agents.filter((a) => takesAccounts(a, agents))
  const losses = isNew && agent?.accountConfigEnv ? signInLosses(config, form.agentId, draft.offers) : []
  // One click: the computer's own login becomes an account on its default folder, offered (in the
  // same places) by every profile that offered the bare login, so adding this account takes nothing away.
  const adopt = async (configDir: string) => {
    const name = t('settingsAgents.adopt.name')
    const id = accountIdFromName(name, takenIds) || 'personal'
    if (!(await run(() => window.hub.config.saveAccount({ id, agentId: form.agentId, name, configDir })))) return
    const engines = agents.filter((a) => accountAgentId(a) === form.agentId).map((a) => a.id)
    for (const p of config.profiles.filter((x) => signInOffered(config, x.id, form.agentId))) {
      if (!(await saveProfilePatch(run, p.id, (x) => adoptSignIn(x, engines, id)))) return
    }
  }
  const login = loginOf(read)
  const folder = agent ? defaultSignInFolder(agent) : undefined
  const envCount = env.rows.filter((r) => r.name.trim()).length

  return (
    <div className="mb-3 flex flex-col gap-4 rounded-md border border-accent/40 p-3" data-testid="accounts-editor">
      {isNew && <h3 className="text-base font-semibold">{t(agent?.accountConfigEnv ? 'settingsAgents.form.newTitle' : 'settingsAgents.form.newVariantTitle', { agent: agent?.name ?? form.agentId })}</h3>}
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('settingsAgents.form.name')} hint={t('settingsAgents.form.nameHint', { example: `${agent?.name ?? form.agentId} · ${form.name || t('settingsAgents.form.namePlaceholder')}` })} error={errors?.name && t(errors.name)}>
          <Input
            value={form.name}
            autoFocus={isNew}
            onChange={(e) => {
              const name = e.target.value
              setForm({ name, ...(isNew && !idEdited ? { id: accountIdFromName(name, takenIds) } : {}) })
              setErrors(null)
            }}
            placeholder={t('settingsAgents.form.namePlaceholder')}
            data-testid="account-name"
          />
        </Field>
        {isNew ? (
          <Field label={t('settingsAgents.form.agent')}>
            <Select value={form.agentId} onChange={(v) => setForm({ agentId: v })} options={accountAgents.map((a) => ({ value: a.id, label: a.name }))} aria-label={t('settingsAgents.form.agent')} />
          </Field>
        ) : (
          <div />
        )}
        {agent?.accountConfigEnv ? (
          <Field label={t('settingsAgents.form.folder')} hint={t('settingsAgents.form.folderHint', { command: agent.command, env: agent.accountConfigEnv, folder: folder ?? '' })} className="col-span-2">
            <div className="flex gap-2">
              <Input value={form.configDir ?? ''} onChange={(e) => setForm({ configDir: e.target.value })} placeholder={`~/.${agent.id}-work`} spellCheck={false} className="min-w-0 flex-1" data-testid="account-config-dir" />
              <Button icon={<FolderOpen className="size-3.5" aria-hidden />} onClick={() => void pickConfigDir()} data-testid="account-config-dir-pick">
                {t('settingsAgents.form.folderPick')}
              </Button>
            </div>
          </Field>
        ) : (
          <p className="col-span-2 text-sm text-subtle">{t('settingsAgents.form.folderNone')}</p>
        )}
        {agent?.accountConfigEnv && (
          <div className="col-span-2 flex flex-col gap-1" data-testid="account-sign-in">
            <span className="text-sm font-medium text-muted">{t('settingsAgents.form.signIn')}</span>
            <span className="text-sm">
              {login.state === 'ok'
                ? read?.windows.find((w) => w.plan)?.plan
                  ? t('settingsAgents.form.signedInPlan', { plan: read.windows.find((w) => w.plan)!.plan! })
                  : t('settingsAgents.form.signedIn')
                : login.state === 'error'
                  ? t('settingsAgents.form.signInError', { error: login.error })
                  : t('settingsAgents.form.notSignedIn')}
            </span>
            <p className="text-xs text-subtle">{t('settingsAgents.form.signInHint', { command: agent.command, env: agent.accountConfigEnv })}</p>
          </div>
        )}
        <div className="col-span-2 flex flex-col gap-1" data-testid="account-offer">
          <span className="text-sm font-medium text-muted">{t('settingsAgents.form.offer')}</span>
          {config.profiles.length === 0 ? (
            <p className="text-sm text-subtle">{t('settingsAgents.form.noProfiles')}</p>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {config.profiles.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <Switch aria-label={t('settingsAgents.form.offerLabel', { profile: p.name || p.id })} checked={draft.offers[p.id] ?? false} onChange={(on) => setDraft((d) => ({ ...d, offers: { ...d.offers, [p.id]: on } }))} />
                  {p.name || p.id}
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-subtle">{t(isNew ? 'settingsAgents.form.offerNew' : 'settingsAgents.form.offerEdit')}</p>
        </div>
        {losses.length > 0 && folder && (
          <div className="col-span-2 flex flex-col items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning" data-testid="account-adopt">
            <span>{t('settingsAgents.adopt.note', { agent: agent?.name ?? form.agentId, profiles: losses.join(', '), folder })}</span>
            <Button size="sm" disabled={Boolean(snap.loadError)} onClick={() => void adopt(folder)} data-testid="account-adopt-create">
              {t('settingsAgents.adopt.action', { name: t('settingsAgents.adopt.name'), folder })}
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <button type="button" className="flex items-center gap-1 self-start text-sm font-medium text-muted hover:text-text" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          {t('settingsAgents.form.more')}
          <span className="font-normal text-subtle">· {t('settingsAgents.form.moreHint')}</span>
        </button>
        {more && (
          <div className="flex flex-col gap-4">
            {isNew && (
              <Field label={t('settingsAgents.form.id')} hint={t('settingsAgents.form.idHint')} error={errors?.id && t(errors.id)}>
                <Input
                  value={form.id}
                  onChange={(e) => {
                    setIdEdited(true)
                    setForm({ id: e.target.value })
                    setErrors(null)
                  }}
                  placeholder="claude-work"
                  spellCheck={false}
                />
              </Field>
            )}
            {configurable && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-muted">{t('settingsAgents.form.modelMode')}</span>
                <div className="grid grid-cols-2 gap-3">
                  <OptionOrCustom
                    value={form.defaultModel ?? ''}
                    onChange={(defaultModel) => setForm({ defaultModel })}
                    options={models}
                    emptyLabel={options?.defaultModelId ? t('settingsAgents.form.agentDefaultNamed', { name: options.defaultModelId }) : t('settingsAgents.form.agentDefault')}
                    aria-label={t('settingsAgents.form.model')}
                    data-testid="account-default-model"
                  />
                  <OptionOrCustom
                    value={form.defaultMode ?? ''}
                    onChange={(defaultMode) => setForm({ defaultMode })}
                    options={modes}
                    emptyLabel={options?.defaultModeId ? t('settingsAgents.form.agentDefaultNamed', { name: options.defaultModeId }) : t('settingsAgents.form.agentDefault')}
                    aria-label={t('settingsAgents.form.mode')}
                    data-testid="account-default-mode"
                  />
                </div>
              </div>
            )}
            <BudgetFields
              budgetKey={usageAccountKey(form.agentId, form.id || null)}
              agentId={form.agentId}
              read={read}
              value={draft.ceilings}
              disabled={Boolean(snap.loadError)}
              onChange={(window, n) =>
                setDraft((d) => {
                  const ceilings = { ...d.ceilings }
                  if (n === null) delete ceilings[window]
                  else ceilings[window] = n
                  return { ...d, ceilings }
                })
              }
            />
            <div className="flex flex-col gap-1" data-testid="account-env">
              <button type="button" className="flex items-center gap-1 self-start text-sm font-medium text-muted hover:text-text" aria-expanded={envOpen} onClick={() => setEnvOpen(!envOpen)}>
                {envOpen ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                {t('settingsAgents.form.env')}
                <span className="font-normal text-subtle">· {envCount ? tn('settingsAgents.form.envCount', envCount) : t('settingsAgents.form.envNone')}</span>
              </button>
              {envOpen && (
                <div className="flex flex-col gap-3 pl-5">
                  <EnvFields env={env} />
                  <p className="text-xs text-subtle">{t('settings.envStoredNote')}</p>
                  {configurable && (
                    <Field label={t('settingsAgents.form.command')} hint={t('settingsAgents.form.commandHint', { command: agent.command })}>
                      <Input value={form.command ?? ''} onChange={(e) => setForm({ command: e.target.value })} placeholder={agent.command} spellCheck={false} data-testid="account-command" />
                    </Field>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        {saved && !isNew && (
          <span className="mr-auto">
            <DeleteButton name={form.name || form.id} onDelete={() => void run(() => window.hub.config.deleteAccount(saved.id)).then((ok) => ok && onClose())} />
          </span>
        )}
        <Button onClick={onClose} data-testid="accounts-editor-cancel">
          {t(dirty ? 'common.cancel' : 'settingsAgents.form.close')}
        </Button>
        <Button variant="primary" disabled={!dirty || Boolean(snap.loadError)} onClick={() => void saveNow()} data-testid="accounts-editor-save">
          {t('settingsAgents.form.save')}
        </Button>
      </div>
    </div>
  )
}
