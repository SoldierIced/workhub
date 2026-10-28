import { Cpu, Shield, ShieldAlert, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { effectiveAgentKey } from '@workhub/core'
import type { SessionView } from '@shared/api'
import { Select } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { sessionModelPicker, sessionModePicker } from '../../lib/agent-pickers'
import { rememberMode, rememberModel } from '../../lib/prefs'
import { sessionModelName, sessionPermissionName } from '../../lib/sessionHeader'
import { pushItem } from '../../store'

/** What a control shows when the agent does not let the session switch it: the same look, no chevron. */
function StaticControl({ icon, label, title, testId, className }: { icon: ReactNode; label: string; title: string; testId: string; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted', className)} title={title} data-testid={testId}>
      {icon}
      <span className="truncate">{label}</span>
    </span>
  )
}

function ModelControl({ view: v, reported }: { view: SessionView; reported: string | undefined }) {
  const { t } = useI18n()
  const picker = sessionModelPicker(v)
  const shown = sessionModelName(v, reported, t)
  const title = `${t('session.model')}: ${shown}${v.modelIgnored ? `\n${t('agentControls.modelIgnored')}` : ''}`
  const icon = <Cpu className="size-3.5 shrink-0" aria-hidden />
  if (!picker.visible) return <StaticControl icon={icon} label={shown} title={title} testId="model-picker" />
  const change = (id: string) => {
    rememberModel(effectiveAgentKey(v.agentId, v.accountId), id || null)
    void window.hub.sessions.setModel(v.id, id || null).catch((e: unknown) => pushItem(v.id, 'error', errorText(e)))
  }
  const options = [...(picker.allowDefault ? [{ value: '', label: t('session.modelDefault') }] : []), ...picker.options]
  return (
    <span className="inline-flex min-w-0 max-w-full" data-testid="model-picker">
      <Select aria-label={t('session.model')} value={picker.value} onChange={change} disabled={picker.disabled} options={options} inline={{ icon, display: shown, title }} className="max-w-52" />
    </span>
  )
}

/** The permission mode, or the agent (Kiro, OpenCode) when it owns the modes. Tinted while tools run unattended. */
function ModeControl({ view: v }: { view: SessionView }) {
  const { t } = useI18n()
  const picker = sessionModePicker(v)
  const shown = sessionPermissionName(v, t)
  const unattended = v.permissionMode?.unattended === true
  const label = t(picker.kind === 'agent' ? 'agentControls.agent' : 'agentControls.permission')
  const hint = v.modeIgnored ? t('agentControls.modeIgnored') : t(picker.kind === 'agent' ? 'agentControls.agentHint' : 'agentControls.permissionHint')
  const source = v.permissionMode ? `\n${t('session.permissionSource', { source: v.permissionMode.source })}` : ''
  const title = `${t('session.permissionMode', { mode: shown })}${source}\n${hint}`
  const Icon = unattended ? ShieldAlert : picker.kind === 'agent' ? UserRound : Shield
  const icon = <Icon className="size-3.5 shrink-0" aria-hidden />
  const tint = unattended ? 'text-warning hover:text-warning' : undefined
  if (!picker.visible) return <StaticControl icon={icon} label={shown} title={title} testId="mode-picker" className={tint} />
  const change = (id: string) => {
    if (!id) return
    rememberMode(effectiveAgentKey(v.agentId, v.accountId), id)
    void window.hub.sessions.setAgentMode(v.id, id).catch((e: unknown) => pushItem(v.id, 'error', errorText(e)))
  }
  return (
    <span className="inline-flex min-w-0 max-w-full" data-testid="mode-picker" data-unattended={unattended || undefined}>
      <Select aria-label={label} value={picker.value} onChange={change} disabled={picker.disabled} options={picker.options} placeholder={shown} inline={{ icon, display: shown, title }} className={cn('max-w-52', tint)} />
    </span>
  )
}

/**
 * The model and permission mode of the session, as small borderless menus under the composer's
 * input (Workhub 1's session controls). Wraps on a narrow pane; never overlaps the input row.
 */
export function SessionControls({ view, reportedModel }: { view: SessionView; reportedModel?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 px-2 pb-2" data-testid="composer-controls">
      <ModelControl view={view} reported={reportedModel} />
      <ModeControl view={view} />
    </div>
  )
}
