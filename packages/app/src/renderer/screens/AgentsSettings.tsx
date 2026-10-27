import { Pencil, Plus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  FAILOVER_MODES,
  failoverMode,
  orderAgents,
  resolveEffectiveAgents,
  withAgentDefaultMode,
  type AgentAccount,
  type AgentDefinition,
  type FailoverMode,
  type Result,
  type WorkhubConfig
} from '@workhub/core'
import type { AgentOptionsView, ConfigSnapshot } from '@shared/api'
import { Badge, Button, Select, StateDot, Tooltip } from '../components/atoms'
import { AgentOrderList } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { agentDirectory, defaultSignInFolder, installHintKey, type AgentDirectoryEntry, type AgentEngine, type LoginState, type SignInEntry } from '../lib/agents'
import { formatCountdown } from '../lib/agent-usage'
import { useNow } from '../lib/usage'
import { useWindowLabel } from '../components/molecules/UsageWindowRow'
import { useAccountUsage } from '../lib/usage'
import { SettingsGroup } from './settings/SettingsLayout'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

const ENGINE_LABEL: Record<AgentEngine, MessageKey> = { sdk: 'agents.engine.sdk', acp: 'agents.engine.acp', terminal: 'agents.engine.terminal' }
const ENGINE_HINT: Record<AgentEngine, MessageKey> = { sdk: 'agents.engine.sdkHint', acp: 'agents.engine.acpHint', terminal: 'agents.engine.terminalHint' }

/** A badge with an explanation on hover and focus. */
function TipBadge({ tone, tip, children, testId }: { tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tip: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <Tooltip content={<span className="block max-w-72 leading-snug">{tip}</span>}>
      <Badge tone={tone} tabIndex={0} className="cursor-help" data-testid={testId}>
        {children}
      </Badge>
    </Tooltip>
  )
}

/** What the usage read says about a sign-in, as a dot with its explanation. */
function Login({ login }: { login: LoginState }) {
  const { t } = useI18n()
  if (login.state === 'unknown') return null
  const ok = login.state === 'ok'
  return (
    <span className="inline-flex items-center gap-1 text-xs text-subtle" title={ok ? t('agents.login.okHint') : login.error}>
      <StateDot tone={ok ? 'success' : 'danger'} />
      {t(ok ? 'agents.login.ok' : 'agents.login.error')}
    </span>
  )
}

/** Whether new sessions of an agent can start in a mode (the chat engines; a terminal has none). */
const takesModes = (agent: AgentDefinition) => agent.adapter !== 'terminal' && agent.capabilities.appMode

/** The modes an agent offers (Claude's permission modes, an ACP agent's reported modes, Kiro's agents); null while loading. */
function useAgentModes(agentKey: string, enabled: boolean): AgentOptionsView | null {
  const [options, setOptions] = useState<AgentOptionsView | null>(null)
  useEffect(() => {
    setOptions(null)
    if (!enabled) return
    let live = true
    void window.hub.agents.options(agentKey).then(
      (o) => live && setOptions(o),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [agentKey, enabled])
  return options
}

/**
 * A default mode picker. `''` is the fallback: the agent's own default (agent level) or the
 * agent's setting (account level, `inherit`). A saved mode the agent no longer lists stays shown.
 */
function ModeSelect({
  options,
  value,
  onChange,
  inherit,
  label,
  disabled,
  className
}: {
  options: AgentOptionsView | null
  value: string
  onChange: (mode: string) => void
  inherit?: string
  label: string
  disabled?: boolean
  className?: string
}) {
  const { t } = useI18n()
  const modes = options?.modes ?? []
  const own = options?.defaultModeId
  const fallback =
    inherit !== undefined
      ? inherit
        ? t('agents.defaultMode.inheritNamed', { mode: modes.find((m) => m.id === inherit)?.name ?? inherit })
        : t('agents.defaultMode.inherit')
      : own
        ? t('agents.defaultMode.agentDefaultNamed', { mode: modes.find((m) => m.id === own)?.name ?? own })
        : t('agents.defaultMode.agentDefault')
  const list = [{ value: '', label: fallback }, ...modes.map((m) => ({ value: m.id, label: m.name }))]
  if (value && !modes.some((m) => m.id === value)) list.push({ value, label: value })
  return <Select aria-label={label} value={value} onChange={onChange} options={list} disabled={disabled || options === null} className={className} />
}

interface ModeEditing {
  /** The agent's default mode (Settings), `''` for none. */
  agentMode: string
  onAgentMode: (agentId: string, mode: string) => void
  onAccountMode: (account: AgentAccount, mode: string) => void
  editable: boolean
}

function AgentRow({ entry, onEdit, onAdd, modes: editing }: { entry: AgentDirectoryEntry; onEdit: (accountId: string) => void; onAdd: (agentId: string) => void; modes: ModeEditing }) {
  const { t } = useI18n()
  const { agent, engine } = entry
  const canHaveAccounts = !entry.sharesAccountsOf && agent.adapter !== 'terminal'
  const ownSignInKey: MessageKey = agent.id === 'kiro' ? 'agents.ownSignIn.kiro' : agent.accountConfigEnv ? 'agents.ownSignIn.folder' : 'agents.ownSignIn.generic'
  const withModes = takesModes(agent)
  const options = useAgentModes(agent.id, withModes)
  const modeLabel = t(options?.modeSemantics === 'persona' ? 'agents.defaultMode.agent' : 'agents.defaultMode.permission')
  return (
    <div className="flex flex-col gap-1.5 py-3" data-testid="agents-row" data-agent={agent.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-medium">{agent.name}</span>
        <TipBadge tone="neutral" tip={t(ENGINE_HINT[engine])} testId="agents-engine">
          {t(ENGINE_LABEL[engine])}
        </TipBadge>
        {entry.installed !== undefined && (
          <TipBadge
            tone={entry.installed ? 'success' : 'warning'}
            tip={entry.installed ? t('agents.installedHint', { command: agent.command || t('agents.loginShell') }) : t(installHintKey(agent.id), { command: agent.command })}
          >
            {t(entry.installed ? 'agents.installed' : 'agents.notInstalled')}
          </TipBadge>
        )}
        {canHaveAccounts && (
          <Button size="sm" variant="ghost" className="ml-auto" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => onAdd(agent.id)}>
            {t('agents.addAccount')}
          </Button>
        )}
      </div>
      {withModes && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="agents-default-mode">
          <span className="text-muted">{modeLabel}</span>
          <ModeSelect
            options={options}
            value={editing.agentMode}
            onChange={(mode) => editing.onAgentMode(agent.id, mode)}
            label={`${modeLabel} · ${agent.name}`}
            disabled={!editing.editable}
            className="h-7 w-56! text-sm"
          />
          <span className="min-w-0 basis-full text-xs text-subtle">{options && options.modes.length === 0 ? t('agents.defaultMode.unknown') : t('agents.defaultMode.hint')}</span>
        </div>
      )}
      {entry.sharesAccountsOf ? (
        <p className="text-sm text-subtle">{t('agents.sharesAccounts', { agent: entry.sharesAccountsOf.name })}</p>
      ) : agent.adapter === 'terminal' ? (
        <p className="text-sm text-subtle">{t('agents.terminalNote')}</p>
      ) : entry.accounts.length === 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-subtle">
          {t(ownSignInKey)}
          <Login login={entry.defaultLogin} />
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {entry.accounts.map(({ account, login }) => (
            <li key={account.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm" data-testid="agents-account">
              <span className="font-medium">{account.name || account.id}</span>
              {account.configDir && (
                <code className="truncate text-xs text-subtle" title={t('agents.configDirHint')}>
                  {account.configDir}
                </code>
              )}
              {account.defaultModel && <span className="text-xs text-subtle">{t('agents.defaultModel', { model: account.defaultModel })}</span>}
              <Login login={login} />
              <span className="ml-auto flex items-center gap-1">
                {withModes && (
                  <ModeSelect
                    options={options}
                    value={account.defaultMode ?? ''}
                    inherit={editing.agentMode}
                    onChange={(mode) => editing.onAccountMode(account, mode)}
                    label={t('agents.defaultMode.account', { account: account.name || account.id })}
                    disabled={!editing.editable}
                    className="h-7 w-48! text-sm"
                  />
                )}
                <Button size="sm" variant="ghost" icon={<Pencil className="size-3" aria-hidden />} onClick={() => onEdit(account.id)}>
                  {t('agents.edit')}
                </Button>
              </span>
            </li>
          ))}
          {entry.defaultLogin.state !== 'unknown' && (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm" title={t('agents.defaultSignInHint')}>
              <span className="text-muted">{t('agents.defaultSignIn')}</span>
              <Login login={entry.defaultLogin} />
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Saves an agent's default mode, or an account's (empty clears it). */
export function useModeEditing(snap: ConfigSnapshot, run: Run): Omit<ModeEditing, 'agentMode'> & { agentModes: Record<string, string> } {
  const agentModes = snap.config.options?.agentDefaultModes ?? {}
  return {
    agentModes,
    editable: !snap.loadError,
    onAgentMode: (agentId, mode) => void run(() => window.hub.config.saveOptions({ agentDefaultModes: withAgentDefaultMode(agentModes, agentId, mode || null) })),
    onAccountMode: (account, mode) => {
      const next: AgentAccount = { ...account }
      if (mode) next.defaultMode = mode
      else delete next.defaultMode
      void run(() => window.hub.config.saveAccount(next))
    }
  }
}

/** One labelled line of the sign-in detail. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * The detail of an agent's own sign-in in the accounts list: what it is, whether it is signed in,
 * its plan and usage (Kiro's credits), the default mode of sessions without an account, and a way
 * to add an account.
 */
export function SignInDetail({ entry, snap, run, onAddAccount }: { entry: SignInEntry; snap: ConfigSnapshot; run: Run; onAddAccount: (agentId: string) => void }) {
  const { t, formatDate, formatNumber } = useI18n()
  const now = useNow()
  const windowLabel = useWindowLabel()
  const { agent } = entry
  const withModes = takesModes(agent)
  const options = useAgentModes(agent.id, withModes)
  const editing = useModeEditing(snap, run)
  const modeLabel = t(options?.modeSemantics === 'persona' ? 'agents.defaultMode.agent' : 'agents.defaultMode.permission')
  const about =
    entry.kind === 'onePerComputer' ? t('agents.signIn.onePerComputer') : entry.kind === 'folder' ? t('agents.signIn.folder', { folder: defaultSignInFolder(agent) ?? '' }) : t('agents.signIn.generic')
  return (
    <div className="flex flex-col gap-3" data-testid="sign-in-detail" data-agent={agent.id}>
      <p className="text-sm text-subtle">{about}</p>
      <div className="divide-y divide-border rounded-md border border-border px-3">
        <Row label={t('agents.signIn.state')}>
          {entry.installed === false ? (
            <span className="inline-flex items-center gap-1 text-xs text-warning">
              <StateDot tone="warning" />
              {t('agents.signIn.notInstalled')}
            </span>
          ) : entry.login.state === 'unknown' ? (
            <span className="text-xs text-subtle">
              {t('agents.signIn.notRead')}
              <span className="block">{t('agents.signIn.notReadHint')}</span>
            </span>
          ) : (
            <span className="flex flex-col gap-0.5">
              <Login login={entry.login} />
              {entry.login.state === 'error' && <span className="text-xs break-words text-subtle">{entry.login.error}</span>}
            </span>
          )}
        </Row>
        {entry.plan && (
          <Row label={t('agents.signIn.plan')}>
            <span data-testid="sign-in-plan">{entry.plan}</span>
          </Row>
        )}
        {entry.windows.length > 0 && (
          <Row label={t('agents.signIn.usage')}>
            <ul className="flex flex-col gap-1" data-testid="sign-in-usage">
              {entry.windows.map((w) => (
                <li key={w.window} className="text-sm tabular-nums">
                  {t('agents.signIn.window', { window: windowLabel(w.window), percent: Math.round(w.percent) })}
                  {w.used !== undefined && w.limit !== undefined && (
                    <span className="block text-xs text-subtle">
                      {t('agentUsage.credits', {
                        used: formatNumber(Math.round(w.used * 100) / 100),
                        limit: formatNumber(w.limit),
                        left: formatNumber(Math.round(Math.max(0, w.limit - w.used) * 100) / 100)
                      })}
                    </span>
                  )}
                  {w.resetsAt !== undefined && (
                    <span className="block text-xs text-subtle">
                      {t('agentUsage.resetsAt', {
                        when: formatDate(w.resetsAt, { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
                        time: formatCountdown(w.resetsAt, now)
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Row>
        )}
        {withModes && (
          <Row label={modeLabel}>
            <ModeSelect
              options={options}
              value={editing.agentModes[agent.id] ?? ''}
              onChange={(mode) => editing.onAgentMode(agent.id, mode)}
              label={`${modeLabel} · ${agent.name}`}
              disabled={!editing.editable}
              className="h-7 w-56! text-sm"
            />
            <span className="mt-1 block text-xs text-subtle">{options && options.modes.length === 0 ? t('agents.defaultMode.unknown') : t('agents.defaultMode.hint')}</span>
          </Row>
        )}
      </div>
      <div>
        <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => onAddAccount(agent.id)}>
          {t('agents.signIn.addAccount', { agent: agent.name })}
        </Button>
      </div>
    </div>
  )
}

/**
 * Settings → Agents, above the account form: every agent Workhub knows with how it runs, whether
 * it is installed and its sign-ins; then the active profile's agent order and account failover.
 */
export function AgentsOverview({ snap, run, onEditAccount, onAddAccount }: { snap: ConfigSnapshot; run: Run; onEditAccount: (accountId: string) => void; onAddAccount: (agentId: string) => void }) {
  const { t } = useI18n()
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
  const entries = agentDirectory(snap.agents, snap.config.accounts, reads, availability)
  const profile = snap.config.profiles.find((p) => p.id === snap.config.activeProfileId)
  const editable = !snap.loadError
  const ordered = profile ? orderAgents(profile.preferredAgents, resolveEffectiveAgents(snap.config, profile.id)) : []
  const { agentModes, ...editing } = useModeEditing(snap, run)
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t('agents.installedTitle')} help={t('agents.installedHelp')} footnote={t('agents.installedNote')}>
        {entries.map((e) => (
          <AgentRow key={e.agent.id} entry={e} onEdit={onEditAccount} onAdd={onAddAccount} modes={{ ...editing, agentMode: agentModes[e.agent.id] ?? '' }} />
        ))}
      </SettingsGroup>
      <SettingsGroup title={profile ? t('agents.orderTitle', { profile: profile.name || profile.id }) : t('settings.agentOrder')} help={t('agents.orderHelp')}>
        {!profile ? (
          <p className="py-3 text-sm text-subtle">{t('agents.noProfile')}</p>
        ) : (
          <>
            <div className="py-2">
              <p className="text-sm text-subtle">{t('settings.agentOrderHint')}</p>
              <AgentOrderList agents={ordered} onChange={(keys) => editable && void run(() => window.hub.config.saveProfile({ ...profile, preferredAgents: keys }))} />
            </div>
            <div className="flex items-center justify-between gap-6 py-3">
              <div className="min-w-0">
                <span className="text-base">{t('continuity.settings.mode')}</span>
                <p className="text-xs text-subtle">{t('continuity.settings.hint')}</p>
              </div>
              <div className="w-56 shrink-0">
                <Select
                  aria-label={t('continuity.settings.mode')}
                  value={failoverMode(profile)}
                  disabled={!editable}
                  onChange={(v) => void run(() => window.hub.config.saveProfile({ ...profile, accountFailover: v as FailoverMode }))}
                  options={FAILOVER_MODES.map((m) => ({ value: m, label: t(`continuity.settings.${m}`) }))}
                />
              </div>
            </div>
          </>
        )}
      </SettingsGroup>
    </div>
  )
}
