import { CircleAlert, MessagesSquare, Plus, ShieldAlert, Square, SquareTerminal, Terminal as TerminalIcon, UserRound, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { effectiveAgentKey } from '@workhub/core'
import { terminalChannel, type SessionMode } from '@shared/api'
import { Badge, Button, Select, Spinner, STATE_TONE, StateDot } from '../components/atoms'
import { EmptyState } from '../components/molecules'
import { BrandMark } from '../components/organisms'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { cn } from '../lib/cn'
import { sessionModelPicker, sessionModePicker } from '../lib/agent-pickers'
import { rememberMode, rememberModel } from '../lib/prefs'
import { pushItem, type SessionData } from '../store'
import { AiReviewAside, AiReviewButton } from './sessions/AiReviewPanel'
import { ChatPane } from './sessions/ChatPane'
import { ContinueMenu } from './sessions/ContinueMenu'
import { MonitorPanel } from './sessions/MonitorPanel'
import { PendingSwitchBar } from './sessions/PendingSwitchBar'
import { TerminalPane } from './sessions/TerminalPane'
import { errorText } from '../lib/errorText'

export interface SessionsScreenProps {
  sessions: SessionData[]
  selectedId: string | null
  /** Whether the Sessions screen is on screen (panes stay mounted so terminals keep their state). */
  visible: boolean
  theme: 'light' | 'dark'
  onNewSession: () => void
}

export function SessionsScreen({ sessions, selectedId, visible, theme, onNewSession }: SessionsScreenProps) {
  const { t } = useI18n()
  const current = sessions.find((s) => s.view.id === selectedId)
  return (
    <div className="flex h-full min-h-0 flex-col">
      {sessions.map((s) => (
        <div key={s.view.id} className={cn('flex min-h-0 flex-1 flex-col', s.view.id !== current?.view.id && 'hidden')}>
          <SessionPane data={s} visible={visible && s.view.id === current?.view.id} theme={theme} />
        </div>
      ))}
      {!current && (
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState
            icon={<BrandMark className="size-8" />}
            title={sessions.length ? t('sessions.pick') : t('sessions.emptyTitle')}
            description={t('sessions.emptyDescription')}
            action={
              <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={onNewSession}>
                {t('toolbar.newSession')}
              </Button>
            }
          />
        </div>
      )}
    </div>
  )
}

const MODE_ICON: Record<SessionMode, LucideIcon> = { app: MessagesSquare, console: SquareTerminal, shell: TerminalIcon }
const MODE_LABEL: Record<SessionMode, MessageKey> = { app: 'session.modeApp', console: 'session.modeConsole', shell: 'session.modeShell' }

/** Workhub 1's App / Terminal / Shell switch. */
function ModeSwitch({ data }: { data: SessionData }) {
  const { t } = useI18n()
  const v = data.view
  const [pending, setPending] = useState(false)
  const pick = async (mode: SessionMode) => {
    // Picking the view that runs while a switch waits drops the switch.
    if ((mode === v.mode && !v.pendingMode) || pending) return
    setPending(true)
    try {
      await window.hub.sessions.setMode(v.id, mode)
    } catch (e) {
      pushItem(v.id, 'error', errorText(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <div role="radiogroup" aria-label={t('session.mode')} className="inline-flex h-7 items-center rounded-md border border-border bg-surface p-0.5">
      {v.modes.map((m) => {
        const Icon = MODE_ICON[m]
        const active = v.mode === m
        const waiting = v.pendingMode === m
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={pending}
            onClick={() => void pick(m)}
            data-testid={`mode-${m}`}
            data-pending={waiting || undefined}
            title={waiting ? t('session.switchPending', { mode: t(MODE_LABEL[m]) }) : undefined}
            className={cn(
              'inline-flex h-6 items-center gap-1.5 rounded px-2 text-sm transition-colors duration-150 disabled:opacity-60',
              active ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:text-text',
              waiting && 'text-accent ring-1 ring-accent/50'
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {t(MODE_LABEL[m])}
          </button>
        )
      })}
    </div>
  )
}

function ModelPicker({ data }: { data: SessionData }) {
  const { t } = useI18n()
  const v = data.view
  const picker = sessionModelPicker(v)
  const change = (id: string) => {
    rememberModel(effectiveAgentKey(v.agentId, v.accountId), id || null)
    void window.hub.sessions.setModel(v.id, id || null).catch((e: unknown) => pushItem(v.id, 'error', errorText(e)))
  }
  return (
    <span data-testid="model-picker" title={v.modelIgnored ? t('agentControls.modelIgnored') : undefined}>
      <Select
        aria-label={t('session.model')}
        value={picker.value}
        onChange={change}
        disabled={picker.disabled}
        options={[...(picker.allowDefault ? [{ value: '', label: t('session.modelDefault') }] : []), ...picker.options]}
        className="h-7 w-44! text-sm"
      />
    </span>
  )
}

/** The session's agent (Kiro, OpenCode) or permission preset (Codex, Gemini), switched live over ACP. */
function ModePicker({ data }: { data: SessionData }) {
  const { t } = useI18n()
  const v = data.view
  const picker = sessionModePicker(v)
  const change = (id: string) => {
    if (!id) return
    rememberMode(effectiveAgentKey(v.agentId, v.accountId), id)
    void window.hub.sessions.setAgentMode(v.id, id).catch((e: unknown) => pushItem(v.id, 'error', errorText(e)))
  }
  const label = t(picker.kind === 'agent' ? 'agentControls.agent' : 'agentControls.permission')
  return (
    <span
      data-testid="mode-picker"
      className="inline-flex items-center gap-1 text-xs text-muted"
      title={v.modeIgnored ? t('agentControls.modeIgnored') : t(picker.kind === 'agent' ? 'agentControls.agentHint' : 'agentControls.permissionHint')}
    >
      {picker.kind === 'agent' && <UserRound className="size-3.5" aria-hidden />}
      <Select aria-label={label} value={picker.value} onChange={change} disabled={picker.disabled} options={picker.options} placeholder={label} className="h-7 w-40! text-sm" />
    </span>
  )
}

function SessionPane({ data, visible, theme }: { data: SessionData; visible: boolean; theme: 'light' | 'dark' }) {
  const { t } = useI18n()
  const v = data.view
  const mode = v.permissionMode
  const live = v.state === 'ready' || v.state === 'busy' || v.state === 'starting'
  // A shell, once opened, stays mounted so its scrollback survives switching back and forth.
  const [shellOpened, setShellOpened] = useState(false)
  useEffect(() => {
    if (v.shellRunning) setShellOpened(true)
  }, [v.shellRunning])
  const hasApp = v.modes.includes('app')
  const hasConsole = v.modes.includes('console')
  return (
    <>
      {/* Wraps: on a narrow pane the controls move to a second row instead of squeezing the name and folder to nothing. */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3" data-testid="session-header">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-raised text-accent">
          <SquareTerminal className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-48 flex-1 basis-56" data-testid="session-identity">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate text-md font-semibold" title={v.agentName}>
              {v.agentName}
            </h1>
            {v.accountName && (
              <Badge tone="accent" data-testid="session-account" className="min-w-0 shrink" title={v.accountName} icon={<UserRound className="size-3 shrink-0" aria-hidden />}>
                <span className="truncate">{v.accountName}</span>
              </Badge>
            )}
          </div>
          <div className="truncate font-mono text-xs text-subtle" title={v.cwd}>
            {v.cwd}
          </div>
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
          {v.modes.length > 1 && <ModeSwitch data={data} />}
          {sessionModePicker(v).visible && <ModePicker data={data} />}
          {sessionModelPicker(v).visible && <ModelPicker data={data} />}
          <Badge tone={STATE_TONE[v.state]} data-testid="session-state" icon={<StateDot tone={STATE_TONE[v.state]} pulse={v.state === 'busy' || v.state === 'starting'} />}>
            {t(`state.${v.state}`)}
          </Badge>
          <Badge
            tone={mode?.unattended ? 'warning' : 'neutral'}
            data-testid="permission-mode"
            title={mode ? t('session.permissionSource', { source: mode.source }) : undefined}
            icon={mode?.unattended ? <ShieldAlert className="size-3" aria-hidden /> : undefined}
          >
            {t('session.permissionMode', { mode: mode ? mode.label : v.state === 'starting' ? t('session.pending') : t('session.unknown') })}
          </Badge>
          {v.currentModeId && v.permissionMode?.id === 'agent-managed' && !sessionModePicker(v).visible && <Badge>{t('session.agentMode', { mode: v.currentModeId })}</Badge>}
          {live && <AiReviewButton view={v} />}
          {live && !v.readOnly && v.modes.includes('app') && <ContinueMenu view={v} />}
          {live && (
            <Button size="sm" variant="ghost" icon={<Square className="size-3" aria-hidden />} onClick={() => void window.hub.sessions.stop(v.id)}>
              {t('session.stop')}
            </Button>
          )}
        </div>
      </header>
      {v.state === 'starting' && v.adapter === 'acp' && v.mode === 'app' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-soft px-5 py-2 text-sm text-warning">
          <Spinner className="size-3.5 text-warning" />
          {t('session.startingHint')}
        </div>
      )}
      <PendingSwitchBar view={v} />
      {v.error && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border bg-danger-soft px-5 py-2 text-sm text-danger">
          <CircleAlert className="size-4" aria-hidden />
          {v.error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {hasApp && (
            <div className={cn('flex min-h-0 flex-1', v.mode !== 'app' && 'hidden')}>
              <ChatPane data={data} active={visible && v.mode === 'app'} />
            </div>
          )}
          {hasConsole && (
            <div className={cn('flex min-h-0 flex-1', v.mode !== 'console' && 'hidden')}>
              <TerminalPane channel={terminalChannel(v.id, 'console')} visible={visible && v.mode === 'console'} theme={theme} label={t('session.modeConsole')} />
            </div>
          )}
          {shellOpened && (
            <div className={cn('flex min-h-0 flex-1', v.mode !== 'shell' && 'hidden')}>
              <TerminalPane channel={terminalChannel(v.id, 'shell')} visible={visible && v.mode === 'shell'} theme={theme} label={t('session.modeShell')} />
            </div>
          )}
        </div>
        {v.screens.includes('monitor') ? <MonitorPanel data={data} /> : <AiReviewAside view={v} />}
      </div>
    </>
  )
}
