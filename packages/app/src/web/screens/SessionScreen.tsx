import { ArrowUp, Check, Download, FileText, Image as ImageIcon, Square, TriangleAlert, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import type { ToolView } from '@workhub/core'
import { Spinner } from '../../renderer/components/atoms'
import { Markdown } from '../../renderer/components/molecules/Markdown'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { QuestionCard } from '../../renderer/screens/sessions/QuestionCard'
import { markPermission, pushUser, useSessions, type ChatItem, type SessionData } from '../../renderer/store'
import type { RemoteFile } from '../../shared/remote-api'
import { navigate, useClient, useClientStatus } from '../app-context'
import { takeFirstPrompt } from '../first-prompt'
import { basename, Body, Header, InlineConfirm, Screen } from '../ui'
import { sessionTitle } from './HomeScreen'

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i

function pathOf(view: ToolView | undefined): string | null {
  if (!view) return null
  return view.kind === 'edit' || view.kind === 'write' || view.kind === 'read' ? view.path : null
}

/** A file the agent touched: an image shows inline once fetched; anything else downloads. */
function FileChip({ sessionId, path }: { sessionId: string; path: string }) {
  const { t } = useI18n()
  const client = useClient()
  const [file, setFile] = useState<RemoteFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isImage = IMAGE.test(path)
  const fetchFile = async () => {
    setLoading(true)
    setError(null)
    try {
      setFile((await client.transport.invoke('remote:file', sessionId, path)) as RemoteFile)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(/too large/.test(message) ? t('web.session.file.tooLarge') : t('web.session.file.failed', { error: message }))
    } finally {
      setLoading(false)
    }
  }
  const dataUrl = file ? `data:${file.mime};base64,${file.data}` : null
  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-bg">
      {dataUrl && isImage && <img src={dataUrl} alt={file!.name} className="max-h-72 w-full object-contain" />}
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
        {isImage ? <ImageIcon className="size-3.5 shrink-0 text-info" aria-hidden /> : <FileText className="size-3.5 shrink-0 text-info" aria-hidden />}
        <span className="min-w-0 flex-1 truncate font-mono text-muted">{basename(path)}</span>
        {loading ? (
          <Spinner className="size-3.5" />
        ) : dataUrl ? (
          <a href={dataUrl} download={file!.name} className="flex items-center gap-1 text-accent">
            <Download className="size-3.5" aria-hidden />
            {t('web.session.file.download')}
          </a>
        ) : (
          <button type="button" onClick={() => void fetchFile()} className="text-accent">
            {t('web.session.file.open')}
          </button>
        )}
      </div>
      {error && <div className="px-2.5 pb-1.5 text-2xs text-danger">{error}</div>}
    </div>
  )
}

function Item({ item, session, onAnswer }: { item: ChatItem; session: SessionData; onAnswer: (requestId: string, optionId: string | null, label: string, answers?: Record<string, string>) => void }) {
  const { t } = useI18n()
  switch (item.kind) {
    case 'user':
      return <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-surface-raised px-3.5 py-2.5 text-chat whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</div>
    case 'agent':
      return (
        <div className="max-w-[94%] rounded-2xl rounded-tl-sm border border-border bg-surface px-3.5 py-2.5 text-chat">
          <Markdown text={item.text} />
        </div>
      )
    case 'thought':
      return <div className="max-w-[94%] px-1 text-chat-xs text-subtle italic line-clamp-3">{item.text}</div>
    case 'error':
      return <div className="rounded-lg bg-danger-soft px-3 py-2 text-chat-sm text-danger [overflow-wrap:anywhere]">{item.text}</div>
    case 'tool': {
      const path = pathOf(item.view)
      const failed = item.status === 'failed' || item.result?.isError
      const running = item.status === 'pending' || item.status === 'in_progress'
      return (
        <div className="max-w-[94%] text-chat-xs text-muted">
          <div className="flex items-start gap-2">
            {running ? <Spinner className="mt-0.5 size-3.5" /> : failed ? <X className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden /> : <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {item.title}
              {failed && <span className="ml-1 text-danger">{t('web.session.toolFailed')}</span>}
            </span>
          </div>
          {path && <FileChip sessionId={session.view.id} path={path} />}
        </div>
      )
    }
    case 'permission': {
      if (item.questions) return <QuestionCard questions={item.questions} answer={item.answer} onSubmit={(answers, label) => onAnswer(item.requestId, answers ? 'allow' : 'deny', label, answers ?? undefined)} />
      const allow = item.options.filter((o) => o.kind.startsWith('allow'))
      const reject = item.options.filter((o) => !o.kind.startsWith('allow'))
      return (
        <div role="group" aria-label={t('web.session.permissionTitle')} className="flex flex-col gap-2.5 rounded-2xl border border-danger/40 bg-danger-soft p-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-danger">
            <TriangleAlert className="size-4" aria-hidden />
            {t('web.session.permissionTitle')}
          </div>
          <div className="text-chat-sm font-medium [overflow-wrap:anywhere]">{item.title}</div>
          {item.detail && <code className="block overflow-x-auto rounded-lg bg-bg px-3 py-2 text-xs whitespace-pre">{item.detail}</code>}
          {item.answer !== undefined ? (
            <div className="text-sm text-muted">{item.answer === '—' ? t('chat.permissionWithdrawn') : t('chat.answered', { answer: item.answer })}</div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                {allow[0] && (
                  <button type="button" onClick={() => onAnswer(item.requestId, allow[0]!.optionId, allow[0]!.name)} className="h-11 rounded-xl bg-accent text-sm font-semibold text-accent-fg">
                    {allow[0].name}
                  </button>
                )}
                {reject[0] && (
                  <button type="button" onClick={() => onAnswer(item.requestId, reject[0]!.optionId, reject[0]!.name)} className="h-11 rounded-xl border border-border-strong text-sm font-medium">
                    {reject[0].name}
                  </button>
                )}
              </div>
              {[...allow.slice(1), ...reject.slice(1)].map((o) => (
                <button key={o.optionId} type="button" onClick={() => onAnswer(item.requestId, o.optionId, o.name)} className="h-9 rounded-lg text-sm text-muted">
                  {o.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    }
    case 'turnEnd':
      return <div className="my-1 text-center text-2xs text-subtle">{item.stopReason === 'end_turn' ? t('web.session.turnEnded') : t('web.session.stopped', { reason: item.stopReason })}</div>
    case 'exit':
      return <div className="my-1 text-center text-2xs text-subtle">{t('web.session.exited')}</div>
    case 'notice':
      return (
        <div className={cn('rounded-lg border px-3 py-2 text-chat-xs', item.failed || item.noticeKind === 'warning' ? 'border-warning/40 bg-warning-soft' : 'border-border bg-surface text-muted')}>
          <div className="font-medium">{item.title}</div>
          {item.text && <div className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</div>}
        </div>
      )
    case 'compaction':
      return <div className="my-1 text-center text-2xs text-subtle">{t('web.session.compaction')}</div>
    case 'replayStart':
      return <div className="my-1 text-center text-2xs text-subtle">{t('web.session.earlier')}</div>
  }
}

/** One session's chat: messages, tool calls, permissions and questions, and the prompt box. */
export function SessionScreen({ id }: { id: string }) {
  const { t } = useI18n()
  const status = useClientStatus()
  const sessions = useSessions()
  const session = sessions[id]
  const [text, setText] = useState('')
  const [closing, setClosing] = useState(false)
  const scroller = useRef<HTMLElement>(null)
  const stuck = useRef(true)

  // The first message typed on the New session screen goes out as soon as the agent is ready.
  useEffect(() => {
    if (!session || session.view.state !== 'ready') return
    const first = takeFirstPrompt(id)
    if (first) send(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, session?.view.state])

  const items = session?.items ?? []
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [items.length, items[items.length - 1]])

  const send = (value: string) => {
    pushUser(id, value)
    void window.hub.sessions.prompt(id, value).catch(() => {})
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = text.trim()
    if (!value || !session) return
    setText('')
    send(value)
  }
  const answer = (requestId: string, optionId: string | null, label: string, answers?: Record<string, string>) => {
    window.hub.sessions.respondPermission(id, requestId, optionId, answers)
    markPermission(id, requestId, label)
  }

  if (!session) {
    return (
      <Screen>
        <Header title={t('web.home.title')} back={{ screen: 'home' }} />
        <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-muted">{t('web.session.missing')}</div>
      </Screen>
    )
  }
  const v = session.view
  const busy = v.state === 'busy' || v.state === 'starting'
  const online = status.state === 'online'

  return (
    <Screen>
      <Header
        title={sessionTitle(session)}
        subtitle={
          <span className="font-mono">
            {basename(v.cwd)} · {v.agentName}
            {v.currentModelId ? ` · ${v.models?.find((m) => m.id === v.currentModelId)?.name ?? v.currentModelId}` : ''}
          </span>
        }
        back={{ screen: 'home' }}
        right={
          <button type="button" aria-label={t('web.session.closeSession')} onClick={() => setClosing(true)} className="flex size-10 items-center justify-center rounded-lg text-muted active:bg-surface-hover">
            <X className="size-5" aria-hidden />
          </button>
        }
      />
      {closing && (
        <div className="px-4 pt-2">
          <InlineConfirm
            question={t('web.home.closeConfirm')}
            yes={t('web.home.closeYes')}
            danger
            onNo={() => setClosing(false)}
            onYes={() => {
              setClosing(false)
              void window.hub.sessions.close(id).then(() => navigate({ screen: 'home' }, true))
            }}
          />
        </div>
      )}
      <Body className="flex flex-col gap-3 px-4 py-4">
        <ScrollCapture target={scroller} stuck={stuck} />
        {items.map((item) => (
          <Item key={item.id} item={item} session={session} onAnswer={answer} />
        ))}
        {busy && items[items.length - 1]?.kind !== 'tool' && (
          <div className="flex items-center gap-2 text-xs text-subtle">
            <Spinner className="size-3.5" />
            {v.state === 'starting' ? t('web.new.starting') : t('web.session.thought')}
          </div>
        )}
      </Body>
      <form onSubmit={submit} aria-label={t('web.session.send')} className="safe-bottom flex shrink-0 items-end gap-2 border-t border-border bg-sidebar px-3 pt-2.5 pb-2.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('web.session.placeholder')}
          rows={1}
          disabled={!online}
          enterKeyHint="send"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit(e)
            }
          }}
          className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-border-strong bg-bg px-3.5 py-2.5 text-md text-text"
        />
        {busy ? (
          <button type="button" aria-label={t('web.session.stop')} onClick={() => void window.hub.sessions.cancel(id)} className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border-strong bg-surface text-text">
            <Square className="size-4" aria-hidden />
          </button>
        ) : (
          <button type="submit" aria-label={t('web.session.send')} disabled={!online || !text.trim()} className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg disabled:opacity-45">
            <ArrowUp className="size-5" aria-hidden />
          </button>
        )}
      </form>
    </Screen>
  )
}

/** Finds the chat's scroll element and remembers whether the person is reading the end of it. */
function ScrollCapture({ target, stuck }: { target: RefObject<HTMLElement | null>; stuck: RefObject<boolean> }) {
  const probe = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = probe.current?.parentElement
    if (!el) return
    target.current = el
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [target, stuck])
  return <span ref={probe} hidden />
}
