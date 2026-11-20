import { ArrowUp, Check, Download, FileDiff, FileText, Image as ImageIcon, Square, TriangleAlert, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react'
import type { ToolView } from '@workhub/core'
import { Spinner } from '../../renderer/components/atoms'
import { Markdown } from '../../renderer/components/molecules/Markdown'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { QuestionCard } from '../../renderer/screens/sessions/QuestionCard'
import { answerText, openRequests, type AnswerPermission, type PermissionItem } from '../../renderer/screens/sessions/PermissionCard'
import { dropStale, itemMark, loadBacklog, loadEarlier, markPermission, pushUser, useSessions, type ChatItem, type SessionData } from '../../renderer/store'
import { useNow } from '../../renderer/lib/usage'
import { usePendingFocus } from '../../renderer/lib/pendingFocus'
import { REMOTE_FEATURES, type RemoteFile, type RemoteHistoryPage } from '../../shared/remote-api'
import { navigate, useClient, useClientStatus } from '../app-context'
import { filePreview, type FilePreview } from '../file-preview'
import { takeFirstPrompt } from '../first-prompt'
import { ACTION_BUTTON, basename, Body, Header, IconButton, InlineConfirm, Screen } from '../ui'
import { sessionTitle } from './HomeScreen'
import { SubagentLink } from './SubagentScreen'
import { subagentOfCall } from '../../renderer/lib/subagentView'
import { SessionActivity } from './SessionActivity'
import { PermissionBadge } from './PermissionBadge'
import { ReviewCard, reviewWaits, useRemoteReview } from './ReviewCard'

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i

function pathOf(view: ToolView | undefined): string | null {
  if (!view) return null
  return view.kind === 'edit' || view.kind === 'write' || view.kind === 'read' ? view.path : null
}

/** What a fetched file shows above its row: the image, the rendered Markdown, the text, or why there is nothing. */
export function FilePreviewBody({ file, preview, expanded }: { file: RemoteFile; preview: FilePreview | null; expanded: boolean }) {
  const { t } = useI18n()
  if (!preview) return null
  if (preview.kind === 'image') return <img src={`data:${file.mime};base64,${file.data}`} alt={file.name} className="max-h-72 w-full object-contain" />
  if (preview.kind === 'tooLong') {
    return (
      <div data-testid="file-preview-too-long" className="border-b border-border px-2.5 py-1.5 text-xs text-muted">
        {t('web.session.file.tooLong')}
      </div>
    )
  }
  const box = cn('border-b border-border px-3 py-2', !expanded && 'max-h-80 overflow-y-auto')
  if (preview.kind === 'markdown') {
    return (
      <div data-testid="file-preview-markdown" className={box}>
        <Markdown text={preview.text} />
      </div>
    )
  }
  return (
    <pre data-testid="file-preview-text" className={cn(box, 'overflow-x-auto font-mono text-xs text-fg')}>
      {preview.text}
    </pre>
  )
}

/** A file the agent touched: once fetched, an image, a Markdown document or any text shows here; anything else downloads. */
export function FileChip({ sessionId, path }: { sessionId: string; path: string }) {
  const { t } = useI18n()
  const client = useClient()
  const [file, setFile] = useState<RemoteFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
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
  const preview = useMemo(() => (file ? filePreview(file) : null), [file])
  const readable = preview?.kind === 'markdown' || preview?.kind === 'text'
  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-bg">
      {file && <FilePreviewBody file={file} preview={preview} expanded={expanded} />}
      <div className="flex min-h-11 items-center gap-1 px-2.5 text-xs">
        {isImage ? <ImageIcon className="size-3.5 shrink-0 text-info" aria-hidden /> : <FileText className="size-3.5 shrink-0 text-info" aria-hidden />}
        <span className="ml-1 min-w-0 flex-1 font-mono text-muted [overflow-wrap:anywhere]">{basename(path)}</span>
        {readable && (
          <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="flex min-h-11 shrink-0 items-center px-2 text-accent">
            {t(expanded ? 'web.session.file.collapse' : 'web.session.file.expand')}
          </button>
        )}
        {loading ? (
          <Spinner className="size-3.5" />
        ) : dataUrl ? (
          <a href={dataUrl} download={file!.name} className="flex min-h-11 shrink-0 items-center gap-1 px-2 text-accent">
            <Download className="size-3.5" aria-hidden />
            {t('web.session.file.download')}
          </a>
        ) : (
          <button type="button" onClick={() => void fetchFile()} className="flex min-h-11 shrink-0 items-center px-2 text-accent">
            {t('web.session.file.open')}
          </button>
        )}
      </div>
      {error && <div className="px-2.5 pb-1.5 text-xs text-danger">{error}</div>}
    </div>
  )
}

/** A permission request or question: its buttons while open (pinned above the composer), the answer once given. */
function PermissionCard({ item, onAnswer }: { item: PermissionItem; onAnswer: AnswerPermission }) {
  const { t } = useI18n()
  if (item.questions?.length) return <QuestionCard questions={item.questions} answer={item.answer} onSubmit={(answers, label) => onAnswer(item.requestId, answers ? 'allow' : 'deny', label, answers ?? undefined)} />
  const allow = item.options.filter((o) => o.kind.startsWith('allow'))
  const reject = item.options.filter((o) => !o.kind.startsWith('allow'))
  return (
    <div role="group" aria-label={t('web.session.permissionTitle')} className="flex flex-col gap-2.5 rounded-2xl border border-warning/40 bg-warning-soft p-3.5" data-testid="permission-card">
      <div className="flex items-center gap-2 text-sm font-semibold text-warning">
        <TriangleAlert className="size-4" aria-hidden />
        {t('web.session.permissionTitle')}
      </div>
      <div className="text-chat-sm font-medium [overflow-wrap:anywhere]">{item.title}</div>
      {item.detail && <code className="block max-h-32 overflow-auto rounded-lg bg-bg px-3 py-2 text-xs whitespace-pre">{item.detail}</code>}
      {item.answer !== undefined ? (
        <div className="text-sm text-muted">{answerText(item.answer, t)}</div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            {allow[0] && (
              <button type="button" onClick={() => onAnswer(item.requestId, allow[0]!.optionId, allow[0]!.name)} className="min-h-11 rounded-xl bg-accent px-2 py-1 text-sm font-semibold text-accent-fg">
                {allow[0].name}
              </button>
            )}
            {reject[0] && (
              <button type="button" onClick={() => onAnswer(item.requestId, reject[0]!.optionId, reject[0]!.name)} className="min-h-11 rounded-xl border border-border-strong px-2 py-1 text-sm font-medium">
                {reject[0].name}
              </button>
            )}
          </div>
          {[...allow.slice(1), ...reject.slice(1)].map((o) => (
            <button key={o.optionId} type="button" onClick={() => onAnswer(item.requestId, o.optionId, o.name)} className="min-h-11 rounded-lg px-2 py-1 text-sm text-muted">
              {o.name}
            </button>
          ))}
        </div>
      )}
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
      // A Task call: the sub-agent it started, by the id its result names or the monitor's list.
      const subagent = item.result?.agentId ?? subagentOfCall(session.monitor.subagents, item.toolCallId)?.id
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
          {subagent && <SubagentLink sessionId={session.view.id} id={subagent} />}
        </div>
      )
    }
    case 'permission':
      if (item.answer !== undefined) return <PermissionCard item={item} onAnswer={onAnswer} />
      return (
        <div className="flex items-center gap-2 text-sm text-danger" data-testid="permission-marker">
          <TriangleAlert className="size-4" aria-hidden />
          <span className="font-semibold">{item.questions?.length ? t('chat.questionAsked') : t('web.session.permissionTitle')}</span>
          <span className="text-muted">· {t('chat.answerPinned')}</span>
        </div>
      )
    case 'turnEnd':
      return <div className="my-1 text-center text-xs text-subtle">{item.stopReason === 'end_turn' ? t('web.session.turnEnded') : t('web.session.stopped', { reason: item.stopReason })}</div>
    case 'exit':
      return <div className="my-1 text-center text-xs text-subtle">{t('web.session.exited')}</div>
    case 'notice':
      return (
        <div className={cn('rounded-lg border px-3 py-2 text-chat-xs', item.failed || item.noticeKind === 'warning' ? 'border-warning/40 bg-warning-soft' : 'border-border bg-surface text-muted')}>
          <div className="font-medium">{item.title}</div>
          {item.text && <div className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</div>}
        </div>
      )
    case 'compaction':
      return <div className="my-1 text-center text-xs text-subtle">{t('web.session.compaction')}</div>
    case 'replayStart':
      // The divider between earlier messages and this one: with none loaded there is nothing earlier to mark.
      if (item.count === 0) return null
      return <div className="my-1 text-center text-xs text-subtle">{t('web.session.earlier')}</div>
  }
}

/** One session's chat: messages, tool calls, permissions and questions, and the prompt box. */
export function SessionScreen({ id }: { id: string }) {
  const { t, tn } = useI18n()
  const status = useClientStatus()
  const sessions = useSessions()
  const session = sessions[id]
  const [text, setText] = useState('')
  const [closing, setClosing] = useState(false)
  const scroller = useRef<HTMLElement>(null)
  const stuck = useRef(true)
  const touching = useRef(false)
  const client = useClient()
  const online = status.state === 'online'
  const exists = Boolean(session)
  // The index of the oldest stored message shown; null until the last page arrived.
  const [start, setStart] = useState<number | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const earlierInFlight = useRef(false)
  // The scroll height before an earlier page went in above, to keep the reader where they were.
  const anchor = useRef<number | null>(null)
  // Whether the last page arrived: earlier pages are only asked for after it, from the end of the chat.
  const loaded = useRef(false)

  // The device only receives live events: the conversation so far comes from the desktop a page at a
  // time, on open and whenever the link comes back (offline, the last page cached on this phone).
  useEffect(() => {
    if (!exists) return
    let alive = true
    const asked = itemMark()
    ;(client.transport.invoke('remote:history', id) as Promise<RemoteHistoryPage | null>).then(
      (page) => {
        if (!alive || !page) return
        // Back at the end only when nothing was read yet: a reload after a reconnect leaves the reader where they are.
        if (!loaded.current) stuck.current = true
        loaded.current = true
        // An empty page: nothing stored, so what the chat showed before the question goes (the empty state shows); a message sent since stays.
        if (page.messages.length > 0) loadBacklog(id, page.messages)
        else dropStale(id, asked)
        setStart(page.start)
      },
      () => {}
    )
    return () => {
      alive = false
    }
  }, [client, id, exists, online])

  const loadMore = async () => {
    const el = scroller.current
    if (!el || !loaded.current || start === null || start <= 0 || earlierInFlight.current || !online) return
    earlierInFlight.current = true
    setLoadingEarlier(true)
    try {
      const page = (await client.transport.invoke('remote:history', id, start)) as RemoteHistoryPage
      anchor.current = el.scrollHeight
      loadEarlier(id, page.messages)
      setStart(page.start)
    } catch {
      // Offline or refused: the button stays, to try again.
    } finally {
      earlierInFlight.current = false
      setLoadingEarlier(false)
    }
  }
  const now = useNow(15_000)
  const onTop = useRef(loadMore)
  onTop.current = loadMore

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
    if (!el || anchor.current === null) return
    el.scrollTop += el.scrollHeight - anchor.current
    anchor.current = null
  }, [items[0]?.id])
  useLayoutEffect(() => {
    const el = scroller.current
    // Not while a finger is on the chat: a reply streaming in would pull it back to the end.
    if (el && stuck.current && !touching.current) el.scrollTop = el.scrollHeight
  }, [items.length, items[items.length - 1]])

  // Open requests stay pinned above the composer until answered; answering one moves the focus on.
  const pending = openRequests(items)
  const pendingBox = useRef<HTMLElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const focusAfterAnswer = usePendingFocus(pending, pendingBox, composer)
  // A review loop waiting for the person shows its decisions here too; read again as the session's state moves.
  const review = useRemoteReview(id, session?.view.state)

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
    focusAfterAnswer(requestId)
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
          <>
            {client.supports(REMOTE_FEATURES.changes) && (
              <IconButton aria-label={t('web.changes.open')} onClick={() => navigate({ screen: 'changes', sessionId: id })} data-testid="open-changes">
                <FileDiff className="size-5" aria-hidden />
              </IconButton>
            )}
            <IconButton aria-label={t('web.session.closeSession')} onClick={() => setClosing(true)}>
              <X className="size-5" aria-hidden />
            </IconButton>
          </>
        }
      />
      <div className="px-4 pt-2">
        <PermissionBadge view={v} />
      </div>
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
      <Body className="px-4 py-4">
        <ScrollCapture target={scroller} stuck={stuck} touching={touching} onTop={onTop} />
        <div className="flex flex-col gap-3">
          {start !== null && start > 0 && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingEarlier || !online}
              className={cn(ACTION_BUTTON, 'mx-auto rounded-full text-muted')}
            >
              {loadingEarlier && <Spinner className="size-3.5" />}
              {loadingEarlier ? t('web.session.loadingEarlier') : t('web.session.loadEarlier')}
            </button>
          )}
          {items.length === 0 && !busy && start !== null && (
            <p data-testid="chat-empty" className="px-4 py-10 text-center text-sm text-muted">
              {t('web.session.empty')}
            </p>
          )}
          {items.map((item) => (
            <Item key={item.id} item={item} session={session} onAnswer={answer} />
          ))}
          {busy && items[items.length - 1]?.kind !== 'tool' && (
            <div className="flex items-center gap-2 text-xs text-subtle">
              <Spinner className="size-3.5" />
              {v.state === 'starting' ? t('web.new.starting') : t('web.session.thought')}
            </div>
          )}
        </div>
      </Body>
      {/* Sub-agents, background tasks and pinned requests share one scrolling area, so the chat keeps most of the screen. */}
      <div data-testid="chat-dock" className="flex max-h-[45dvh] shrink-0 flex-col overflow-y-auto">
      <SessionActivity sessionId={id} state={v.state} monitor={session.monitor} now={now} />
      {reviewWaits(review.state) && review.state && <ReviewCard sessionId={id} state={review.state} onDone={review.reload} className="mx-4 my-2 shrink-0" />}
      {(pending.length > 0 || v.consoleAsking) && (
        <section ref={pendingBox} data-testid="pending-requests" aria-label={t('web.session.pendingRequests')} className="flex shrink-0 flex-col gap-2.5 border-t border-warning/30 bg-sidebar px-4 py-3">
          {pending.length > 0 && (
            <p role="status" className="text-xs font-medium text-warning" data-testid="pending-count">
              {tn('chat.pendingCount', pending.length)}
            </p>
          )}
          {v.consoleAsking && (
            <div className="flex items-center gap-2 rounded-2xl border border-warning/40 bg-warning-soft p-3.5 text-sm">
              <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
              {t('web.session.consoleAsking')}
            </div>
          )}
          {pending.map((item) => (
            <div key={item.id} data-request-id={item.requestId}>
              <PermissionCard item={item} onAnswer={answer} />
            </div>
          ))}
        </section>
      )}
      </div>
      <form onSubmit={submit} aria-label={t('web.session.send')} className="safe-bottom flex shrink-0 items-end gap-2 border-t border-border bg-sidebar px-3 pt-2.5 pb-2.5">
        <textarea
          ref={composer}
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

/** How close to the top of the chat an earlier page starts loading. */
const LOAD_EARLIER_PX = 300

/**
 * Finds the chat's scroll element, remembers whether the person is reading the end of it and
 * whether a finger is on it, and asks for an earlier page near the top.
 */
function ScrollCapture({
  target,
  stuck,
  touching,
  onTop
}: {
  target: RefObject<HTMLElement | null>
  stuck: RefObject<boolean>
  touching: RefObject<boolean>
  onTop: RefObject<() => Promise<void>>
}) {
  const probe = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = probe.current?.parentElement
    if (!el) return
    target.current = el
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      if (el.scrollTop < LOAD_EARLIER_PX) void onTop.current?.()
    }
    const onTouchStart = () => {
      touching.current = true
    }
    const onTouchEnd = () => {
      touching.current = false
      onScroll()
    }
    // Content that grows after it is drawn (an image loading, a reply streaming, the keyboard
    // shrinking the chat) keeps the reader at the end when they were there.
    const keepAtEnd = () => {
      if (stuck.current && !touching.current) el.scrollTop = el.scrollHeight
    }
    const resize = new ResizeObserver(keepAtEnd)
    resize.observe(el)
    if (el.lastElementChild) resize.observe(el.lastElementChild)
    el.scrollTop = el.scrollHeight
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      resize.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [target, stuck, touching, onTop])
  return <span ref={probe} hidden />
}
