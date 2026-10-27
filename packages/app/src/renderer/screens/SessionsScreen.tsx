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
import { MonitorPanel } from './sessions/MonitorPanel'
import { TerminalPane } from './sessions/TerminalPane'

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
    if (mode === v.mode || pending) return
    setPending(true)
    try {
      await window.hub.sessions.setMode(v.id, mode)
    } catch (e) {
      pushItem(v.id, 'error', e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <div role="radiogroup" aria-label={t('session.mode')} className="inline-flex h-7 items-center rounded-md border border-border bg-surface p-0.5">
      {v.modes.map((m) => {
        const Icon = MODE_ICON[m]
        const active = v.mode === m
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={pending}
            onClick={() => void pick(m)}
            data-testid={`mode-${m}`}
            className={cn(
              'inline-flex h-6 items-center gap-1.5 rounded px-2 text-sm transition-colors duration-150 disabled:opacity-60',
              active ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:text-text'
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
    void window.hub.sessions.setModel(v.id, id || null).catch((e: unknown) => pushItem(v.id, 'error', e instanceof Error ? e.message : String(e)))
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
    void window.hub.sessions.setAgentMode(v.id, id).catch((e: unknown) => pushItem(v.id, 'error', e instanceof Error ? e.message : String(e)))
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
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-surface-raised text-accent">
          <SquareTerminal className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-32 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-md font-semibold">{v.agentName}</h1>
            {v.accountName && (
              <Badge tone="accent" data-testid="session-account" icon={<UserRound className="size-3" aria-hidden />}>
                {v.accountName}
              </Badge>
            )}
          </div>
          <div className="truncate font-mono text-xs text-subtle" title={v.cwd}>
            {v.cwd}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
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
              <ChatPane data={data} />
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
