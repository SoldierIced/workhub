import { AppWindowMac, Bot, Pencil } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, IconButton, Input, STATE_TONE, StateDot, TooltipProvider } from '../components/atoms'
import { ToastProvider, useToast } from '../components/molecules'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { useAppearance } from '../lib/appearance'
import { cn } from '../lib/cn'
import { errorText } from '../lib/errorText'
import { folderName } from '../lib/home'
import { usePlatform } from '../lib/platform'
import { closeSubagent } from '../lib/subagentView'
import { sessionTitle } from '../lib/windows'
import { pushUser, seedSession, setViewing, startStore, useSessions } from '../store'
import { SessionPane } from './SessionsScreen'
import { SubagentBody } from './sessions/SubagentView'

function WindowProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <Toasts>{children}</Toasts>
      </TooltipProvider>
    </I18nProvider>
  )
}

function Toasts({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return <ToastProvider label={t('common.notifications')}>{children}</ToastProvider>
}

/** The root of a session window (`#session?id=…`): one session, no navigation. */
export function SessionWindowRoot({ sessionId }: { sessionId: string }) {
  return (
    <WindowProviders>
      <SessionWindow sessionId={sessionId} />
    </WindowProviders>
  )
}

/** Title bar room: the macOS traffic lights on the left, the Windows/Linux controls on the right. */
function TitleBar({ children }: { children: ReactNode }) {
  const platform = usePlatform()
  return <header className={cn('drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border px-4', platform === 'mac' ? 'pl-20' : 'pr-36')}>{children}</header>
}

/** The session's name, renamed in place: double-click (or the pencil) edits, Enter saves, Escape cancels. */
function InlineName({ id, name, fallback }: { id: string; name: string | undefined; fallback: string }) {
  const { t } = useI18n()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const start = () => {
    setValue(name ?? '')
    setEditing(true)
  }
  const save = () => {
    setEditing(false)
    if ((value.trim() || undefined) === name) return
    void window.hub.sessions.rename(id, value.trim() || null).catch((e: unknown) => toast(t('session.renameFailed', { message: errorText(e) }), 'danger'))
  }
  if (editing) {
    return (
      <Input
        autoFocus
        aria-label={t('session.renameLabel')}
        value={value}
        maxLength={120}
        placeholder={fallback}
        data-testid="inline-session-name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="h-7 max-w-80 text-md"
      />
    )
  }
  return (
    <span className="group/name flex min-w-0 items-center gap-1">
      <h1 className="min-w-0 truncate text-md font-semibold" title={t('session.renameInline')} onDoubleClick={start}>
        {name || fallback}
      </h1>
      <IconButton size="sm" className="size-6 opacity-0 group-hover/name:opacity-100 focus-visible:opacity-100" label={t('session.rename')} icon={<Pencil className="size-3" />} onClick={start} />
    </span>
  )
}

function SessionWindow({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const theme = useAppearance()
  const sessions = useSessions()
  const data = sessions[sessionId]
  const [loaded, setLoaded] = useState(false)
  const seen = useRef(false)

  useEffect(() => {
    startStore()
    // The chat so far comes from the main window; the live events follow it (main orders the two).
    void window.hub.windows.snapshot(sessionId).then((snapshot) => {
      if (snapshot) seedSession(sessionId, snapshot)
    })
    setViewing(sessionId)
    const offPrompted = window.hub.automations.onPrompted((id, text) => id === sessionId && pushUser(id, text))
    const offMenu = window.hub.menu.onCommand((command) => {
      if (command.kind === 'closeSession') void window.hub.sessions.close(sessionId)
      if (command.kind === 'showMode') void window.hub.sessions.setMode(sessionId, command.mode).catch(() => undefined)
    })
    void window.hub.sessions.list().then(() => setLoaded(true))
    return () => {
      offPrompted()
      offMenu()
    }
  }, [sessionId])

  if (data) seen.current = true
  // Closed here or anywhere else: the window has nothing left to show (main closes it as well).
  useEffect(() => {
    if (loaded && !data) {
      const timer = setTimeout(() => window.close(), seen.current ? 0 : 1500)
      return () => clearTimeout(timer)
    }
  }, [loaded, data])

  const title = data ? sessionTitle(data.view) : ''
  useEffect(() => {
    document.title = data ? `${title} · ${folderName(data.view.cwd)}` : 'Workhub 2'
  }, [title, data])

  if (!data) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <TitleBar>{null}</TitleBar>
        <p className="m-auto text-sm text-muted">{loaded ? t('window.sessionGone') : null}</p>
      </div>
    )
  }
  const v = data.view
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="session-window">
      <TitleBar>
        <StateDot tone={STATE_TONE[v.state]} pulse={v.state === 'busy' || v.state === 'starting'} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <InlineName id={v.id} name={v.name} fallback={v.agentName} />
          <span className="truncate font-mono text-xs text-subtle" title={v.cwd}>
            {folderName(v.cwd)}
          </span>
          {v.name && <Badge className="shrink-0">{v.agentName}</Badge>}
        </div>
        <Button size="sm" variant="ghost" icon={<AppWindowMac className="size-3.5" aria-hidden />} title={t('window.moveToMainHint')} data-testid="move-to-main" onClick={() => window.hub.windows.dock(v.id)}>
          {t('window.moveToMain')}
        </Button>
      </TitleBar>
      <div className="flex min-h-0 flex-1 flex-col">
        <SessionPane data={data} visible theme={theme} />
      </div>
    </div>
  )
}

/** The root of a sub-agent window (`#subagent?session=…&id=…`): its conversation, read live. */
export function SubagentWindowRoot({ sessionId, subagentId }: { sessionId: string; subagentId: string }) {
  return (
    <WindowProviders>
      <SubagentWindow sessionId={sessionId} subagentId={subagentId} />
    </WindowProviders>
  )
}

function SubagentWindow({ sessionId, subagentId }: { sessionId: string; subagentId: string }) {
  useAppearance()
  const [stack, setStack] = useState([subagentId])
  const current = stack[stack.length - 1]!
  useEffect(() => closeSubagent, [])
  return (
    <div className="flex h-full flex-col bg-bg">
      <TitleBar>
        <Bot className="size-4 text-accent" aria-hidden />
      </TitleBar>
      {/* The conversation view is built for a dialog; here it is one that never closes but with the window. */}
      <RDialog.Root open modal={false} onOpenChange={(o) => !o && window.close()}>
        <RDialog.Content
          className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <SubagentBody
            key={`${current}:${stack.length}`}
            sessionId={sessionId}
            subagentId={current}
            depth={stack.length}
            onBack={() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
            onOpenNested={(id) => setStack((s) => [...s, id])}
            inWindow
          />
        </RDialog.Content>
      </RDialog.Root>
    </div>
  )
}
