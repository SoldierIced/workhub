import { Pencil, Plus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { FAILOVER_MODES, failoverMode, orderAgents, resolveEffectiveAgents, type FailoverMode, type Result, type WorkhubConfig } from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import { Badge, Button, Select, StateDot, Tooltip } from '../components/atoms'
import { AgentOrderList } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { agentDirectory, installHintKey, type AgentDirectoryEntry, type AgentEngine, type LoginState } from '../lib/agents'
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

function AgentRow({ entry, onEdit, onAdd }: { entry: AgentDirectoryEntry; onEdit: (accountId: string) => void; onAdd: (agentId: string) => void }) {
  const { t } = useI18n()
  const { agent, engine } = entry
  const canHaveAccounts = !entry.sharesAccountsOf && agent.adapter !== 'terminal'
  const ownSignInKey: MessageKey = agent.id === 'kiro' ? 'agents.ownSignIn.kiro' : agent.accountConfigEnv ? 'agents.ownSignIn.folder' : 'agents.ownSignIn.generic'
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
              <Button size="sm" variant="ghost" className="ml-auto" icon={<Pencil className="size-3" aria-hidden />} onClick={() => onEdit(account.id)}>
                {t('agents.edit')}
              </Button>
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
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t('agents.installedTitle')} help={t('agents.installedHelp')} footnote={t('agents.installedNote')}>
        {entries.map((e) => (
          <AgentRow key={e.agent.id} entry={e} onEdit={onEditAccount} onAdd={onAddAccount} />
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
