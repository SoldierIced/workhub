import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ArrowUp, Brain, ChevronRight, CircleAlert, FileText, Pencil, Plus, Search, ShieldAlert, Square, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { visibleMonitorFields, type MonitorField } from '@workhub/core'
import { Badge, Button, IconButton, Spinner, STATE_TONE, StateDot } from '../components/atoms'
import { EmptyState } from '../components/molecules'
import { BrandMark } from '../components/organisms'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { cn } from '../lib/cn'
import { attachOutput, markPermission, pushItem, pushTurnEnd, type ChatItem, type SessionData } from '../store'

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

function SessionPane({ data, visible, theme }: { data: SessionData; visible: boolean; theme: 'light' | 'dark' }) {
  const { t } = useI18n()
  const v = data.view
  const mode = v.permissionMode
  const live = v.state === 'ready' || v.state === 'busy' || v.state === 'starting'
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-surface-raised text-accent">
          <SquareTerminal className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-md font-semibold">{v.agentName}</h1>
            {v.label !== v.agentName && <span className="truncate text-sm text-muted">{v.label}</span>}
          </div>
          <div className="truncate font-mono text-xs text-subtle" title={v.cwd}>
            {v.cwd}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
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
          {v.currentModeId && v.permissionMode?.id === 'agent-managed' && <Badge>{t('session.agentMode', { mode: v.currentModeId })}</Badge>}
          {live && (
            <Button size="sm" variant="ghost" icon={<Square className="size-3" aria-hidden />} onClick={() => void window.hub.sessions.stop(v.id)}>
              {t('session.stop')}
            </Button>
          )}
        </div>
      </header>
      {v.state === 'starting' && v.adapter === 'acp' && (
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
        {v.adapter === 'terminal' ? <TerminalPane id={v.id} visible={visible} theme={theme} /> : <ChatPane data={data} />}
        {v.screens.includes('monitor') && <MonitorPanel data={data} />}
      </div>
    </>
  )
}

const TOOL_ICON: Record<string, LucideIcon> = { read: FileText, edit: Pencil, execute: SquareTerminal, search: Search, think: Brain }

function ChatBlock({ item, onAnswer }: { item: ChatItem; onAnswer: (requestId: string, optionId: string | null, label: string) => void }) {
  const { t } = useI18n()
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-xl rounded-br-sm bg-accent-soft px-3.5 py-2 whitespace-pre-wrap text-text">{item.text}</div>
        </div>
      )
    case 'agent':
      return (
        <div className="flex gap-3" data-testid="agent-message">
          <BrandMark className="mt-0.5 size-5" />
          <div className="min-w-0 flex-1 leading-relaxed whitespace-pre-wrap">{item.text}</div>
        </div>
      )
    case 'thought':
      return (
        <details className="group ml-8 text-sm text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none hover:text-text">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            <Brain className="size-3.5" aria-hidden />
            {t('chat.thinking')}
          </summary>
          <div className="mt-1.5 border-l-2 border-border pl-3 whitespace-pre-wrap italic">{item.text}</div>
        </details>
      )
    case 'tool': {
      const Icon = TOOL_ICON[item.toolKind ?? ''] ?? Wrench
      const done = item.status === 'completed'
      const failed = item.status === 'failed'
      return (
        <div className="ml-8 flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm">
          <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.title}</span>
          {item.status && (
            <Badge tone={failed ? 'danger' : done ? 'success' : 'info'} icon={!done && !failed ? <Spinner className="size-3 text-info" /> : undefined}>
              {item.status}
            </Badge>
          )}
        </div>
      )
    }
    case 'permission':
      return (
        <div role="group" aria-label={t('chat.permissionRequested')} className="ml-8 rounded-lg border border-warning/40 bg-warning-soft p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-warning">
            <ShieldAlert className="size-4" aria-hidden />
            {t('chat.permissionRequested')}
          </div>
          <div className="mt-1 font-mono text-xs text-text">{item.title}</div>
          {item.answer ? (
            <div className="mt-2 text-sm text-muted">{t('chat.answered', { answer: item.answer })}</div>
          ) : (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {item.options.map((o) => (
                <Button key={o.optionId} size="sm" variant={o.kind.startsWith('allow') ? 'primary' : 'secondary'} onClick={() => onAnswer(item.requestId, o.optionId, o.name)}>
                  {o.name}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => onAnswer(item.requestId, null, t('common.cancel'))}>
                {t('common.cancel')}
              </Button>
            </div>
          )}
        </div>
      )
    case 'error':
      return (
        <div role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="whitespace-pre-wrap">{item.text}</span>
        </div>
      )
    case 'turnEnd':
      return (
        <div className="flex items-center gap-3 text-2xs tracking-wide text-subtle uppercase" aria-label={t('chat.turnEnded', { reason: item.stopReason })}>
          <span className="h-px flex-1 bg-border" />
          {item.stopReason === 'end_turn' ? t('chat.turnDone') : t('chat.turnEnded', { reason: item.stopReason })}
          <span className="h-px flex-1 bg-border" />
        </div>
      )
    case 'exit':
      return <div className="text-center text-xs text-subtle">{t('chat.exited', { code: item.code ?? t('chat.signal') })}</div>
  }
}

function ChatPane({ data }: { data: SessionData }) {
  const { t } = useI18n()
  const v = data.view
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Braces matter: scrollIntoView returns a Promise in recent Chromium, which React would take as a cleanup.
    void bottom.current?.scrollIntoView({ block: 'end' })
  }, [data.items])

  const send = async () => {
    const value = text.trim()
    if (!value || v.state !== 'ready') return
    setText('')
    pushItem(v.id, 'user', value)
    try {
      pushTurnEnd(v.id, await window.hub.sessions.prompt(v.id, value))
    } catch (e) {
      pushItem(v.id, 'error', e instanceof Error ? e.message : String(e))
    }
  }

  const answer = (requestId: string, optionId: string | null, label: string) => {
    window.hub.sessions.respondPermission(v.id, requestId, optionId)
    markPermission(v.id, requestId, label)
  }

  // Workhub 1 keys: Return sends, Shift-Return adds a line, Esc interrupts.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape' && v.state === 'busy') {
      e.preventDefault()
      void window.hub.sessions.cancel(v.id)
    }
  }

  const placeholder: MessageKey =
    v.state === 'starting' ? 'chat.placeholderStarting' : v.state === 'ready' ? 'chat.placeholder' : v.state === 'busy' ? 'chat.placeholderBusy' : 'chat.placeholderClosed'

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite" aria-label={t('chat.log')} role="log">
        <div className="mx-auto flex max-w-3xl flex-col gap-3.5 px-6 py-5">
          {data.items.length === 0 && <p className="py-10 text-center text-sm text-subtle">{t('chat.empty')}</p>}
          {data.items.map((i) => (
            <ChatBlock key={i.id} item={i} onAnswer={answer} />
          ))}
          <div ref={bottom} />
        </div>
      </div>
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto max-w-3xl rounded-xl border border-border bg-surface shadow-md transition-colors focus-within:border-accent/60">
          <textarea
            aria-label={t('chat.prompt')}
            rows={2}
            value={text}
            disabled={v.state !== 'ready'}
            placeholder={t(placeholder)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            className="block max-h-48 min-h-14 w-full resize-none bg-transparent px-4 pt-3 text-base text-text placeholder:text-subtle focus:outline-none disabled:opacity-60"
          />
          <div className="flex items-center gap-2 px-3 pb-2.5">
            <span className="text-xs text-subtle">{t('chat.keys')}</span>
            <div className="ml-auto flex items-center gap-1.5">
              {v.state === 'busy' && (
                <Button size="sm" variant="secondary" icon={<Square className="size-3" aria-hidden />} onClick={() => void window.hub.sessions.cancel(v.id)}>
                  {t('chat.interrupt')}
                </Button>
              )}
              <IconButton
                label={t('chat.send')}
                icon={<ArrowUp className="size-4" />}
                disabled={v.state !== 'ready' || !text.trim()}
                onClick={() => void send()}
                className="bg-accent text-accent-fg hover:bg-accent-strong hover:text-accent-fg"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** xterm colors from the active theme's tokens. */
function terminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return { background: v('--wh-bg'), foreground: v('--wh-text'), cursor: v('--wh-accent'), selectionBackground: v('--wh-accent-soft') }
}

function TerminalPane({ id, visible, theme }: { id: string; visible: boolean; theme: 'light' | 'dark' }) {
  const host = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon | null>(null)
  const term = useRef<Terminal | null>(null)

  useEffect(() => {
    const t = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace', fontSize: 13, cursorBlink: true, theme: terminalTheme() })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    fit.current = f
    term.current = t
    const detach = attachOutput(id, (d) => t.write(d))
    t.onData((d) => window.hub.sessions.write(id, d))
    t.onResize(({ cols, rows }) => window.hub.sessions.resize(id, cols, rows))
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) f.fit()
    })
    ro.observe(host.current!)
    return () => {
      ro.disconnect()
      detach()
      t.dispose()
      term.current = null
    }
  }, [id])

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme()
  }, [theme])

  useEffect(() => {
    if (visible) fit.current?.fit()
  }, [visible])

  return <div className="xterm-host min-w-0 flex-1" ref={host} />
}

const FIELD_LABEL: Record<MonitorField, MessageKey> = {
  title: 'monitor.title',
  model: 'monitor.model',
  tokens: 'monitor.tokens',
  cost: 'monitor.cost',
  credits: 'monitor.credits',
  context: 'monitor.context',
  toolCalls: 'monitor.toolCalls',
  subagents: 'monitor.subagents',
  activeTime: 'monitor.activeTime',
  planUsage: 'monitor.planUsage',
  mcpServers: 'monitor.mcpServers'
}

function MonitorPanel({ data }: { data: SessionData }) {
  const { t, tn, formatNumber } = useI18n()
  const m = data.monitor
  const fields = visibleMonitorFields(data.view.capabilities, m)
  const n = (x: number | undefined) => (x === undefined ? '–' : formatNumber(x))
  const value = (f: MonitorField) => {
    switch (f) {
      case 'title':
        return m.title
      case 'model':
        return m.model
      case 'tokens':
        return t('monitor.tokensValue', { total: n(m.tokens?.total), input: n(m.tokens?.input), output: n(m.tokens?.output) })
      case 'cost':
        return m.cost ? formatNumber(m.cost.amount, { style: 'currency', currency: m.cost.currency, maximumFractionDigits: 4 }) : ''
      case 'credits':
        return t('monitor.creditsValue', { total: (m.credits ?? 0).toFixed(3), last: (m.lastTurnCredits ?? 0).toFixed(3) })
      case 'context':
        return m.context?.percent !== undefined ? `${m.context.percent.toFixed(1)}%` : `${n(m.context?.used)} / ${n(m.context?.size)}`
      case 'toolCalls':
        return String(m.toolCalls?.length ?? 0)
      case 'subagents':
        return m.subagents?.map((s) => s.name ?? s.id).join(', ')
      case 'activeTime':
        return `${((m.activeTimeMs ?? 0) / 1000).toFixed(1)} s`
      case 'planUsage':
        return m.planUsage?.map((p) => `${p.window}: ${p.percent}%`).join(', ')
      case 'mcpServers':
        return null
    }
  }
  const servers = m.mcpServers ?? []
  return (
    <aside aria-label={t('monitor.label')} className="w-72 shrink-0 overflow-y-auto border-l border-border bg-sidebar px-4 py-4">
      <h2 className="text-xs font-semibold tracking-wide text-subtle uppercase">{t('monitor.heading')}</h2>
      {fields.length === 0 && <p className="mt-2 text-sm text-subtle">{t('monitor.empty')}</p>}
      <dl className="mt-3 flex flex-col gap-3">
        {fields
          .filter((f) => f !== 'mcpServers')
          .map((f) => (
            <div key={f}>
              <dt className="text-xs text-muted">{t(FIELD_LABEL[f])}</dt>
              <dd className="mt-0.5 text-base break-words tabular-nums">{value(f)}</dd>
            </div>
          ))}
      </dl>
      {fields.includes('mcpServers') && (
        <details className="group mt-4 border-t border-border pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted select-none hover:text-text">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            {t('monitor.mcpServers')}
            <span className="ml-auto text-xs text-subtle tabular-nums">{servers.length}</span>
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {servers.map((s) => (
              <li key={s.name} className="flex items-center gap-2 text-sm">
                <StateDot tone={s.state === 'running' ? 'success' : s.state === 'needs-auth' ? 'warning' : s.state === 'failed' ? 'danger' : 'neutral'} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="text-xs text-subtle">{s.toolCount ? tn('monitor.tools', s.toolCount) : s.state}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  )
}
