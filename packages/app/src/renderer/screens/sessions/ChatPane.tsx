import { ArrowRightLeft, ArrowUp, Brain, ChevronRight, CircleAlert, Clock, History, Info, ShieldAlert, Square, TriangleAlert, Webhook, X, type LucideIcon } from 'lucide-react'
import { Fragment, memo, useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { gatePrompt, sessionIdentity, setCeiling, setSessionCeiling, type SubagentSummary } from '@workhub/core'
import { Button, IconButton } from '../../components/atoms'
import { Markdown } from '../../components/molecules'
import { BrandMark, ToolCallCard } from '../../components/organisms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { onComposerDraft, takeComposerDraft } from '../../lib/drafts'
import { hasImageFiles, imageFilesOf, MAX_PROMPT_IMAGES, pickImageFiles, readImageFiles } from '../../lib/images'
import { acceptsInput, restoreComposer } from '../../lib/prompt-queue'
import { isEditable, shouldFocusComposer } from '../../lib/composer-focus'
import { interruptSession, onRecoveredPrompts, removeQueuedPrompt, submitPrompt, useQueuedPrompts } from '../../promptQueue'
import { markPermission, openChatImage, pushItem, type ChatItem, type SessionData } from '../../store'
import { followLog, isAtBottom, lastPromptId, type FollowMark } from '../../lib/chatScroll'
import { refreshConfig } from '../../configStore'
import { sessionBudget } from '../../lib/agent-usage'
import { useAccountLabel, useAccountUsage, useNow, useSessionCeilings, useUsageSettings } from '../../lib/usage'
import { BudgetNotice } from './BudgetNotice'
import { SessionControls } from './SessionControls'
import type { ContinuityOptions } from '@shared/continuity-api'
import { dismissOffer, originText, useContinuityActions, useContinuityOffer } from '../../lib/continuity'
import { ContinuityNotice } from './ContinuityNotice'
import { openSubagent, subagentOfCall } from '../../lib/subagentView'
import { errorText } from '../../lib/errorText'

/** The Claude adapter's English compaction notice, shown in the reader's language. */
const COMPACTED_TEXT = 'The conversation was compacted.'
const NOTICE_ICON: Record<'hook' | 'info' | 'warning', LucideIcon> = { hook: Webhook, info: Info, warning: TriangleAlert }

/** When a message was sent: day, month and hour:minute (plus the year outside the current one); nothing when unknown. */
function SentAt({ at, align }: { at?: number; align: 'left' | 'right' }) {
  const { formatDate } = useI18n()
  if (at === undefined) return null
  const sameYear = new Date(at).getFullYear() === new Date().getFullYear()
  const shown = formatDate(at, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' })
  const full = formatDate(at, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <time dateTime={new Date(at).toISOString()} title={full} data-testid="chat-sent-at" className={cn('block text-2xs text-subtle tabular-nums', align === 'right' && 'text-right')}>
      {shown}
    </time>
  )
}

function Disclosure({ icon: Icon, title, tone, children, testId }: { icon: LucideIcon; title: string; tone?: 'danger' | 'warning'; children: ReactNode; testId?: string }) {
  return (
    <details className={cn('group ml-8 text-sm', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-muted')} data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none hover:text-text">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{title}</span>
      </summary>
      <div className="mt-1.5 border-l-2 border-border pl-3 text-muted">{children}</div>
    </details>
  )
}

interface ChatBlockProps {
  item: ChatItem
  onAnswer: (requestId: string, optionId: string | null, label: string) => void
  sessionId: string
  cwd: string
  subagents?: SubagentSummary[]
}

/**
 * A message is rendered again only when it changes (items are replaced, never mutated): a long chat
 * would otherwise parse all its Markdown again on every render of the pane (a clock tick, a sidebar
 * click that refreshes the config).
 */
const ChatBlock = memo(function ChatBlock({ item, onAnswer, sessionId, cwd, subagents }: ChatBlockProps) {
  const { t, tn } = useI18n()
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1.5">
          {Array.isArray(item.images) && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {item.images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  title={t('chat.imageOpen')}
                  aria-label={t('chat.imageOpenLabel', { n: i + 1 })}
                  data-testid="chat-pasted-image"
                  className="max-w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => void openChatImage(sessionId, item, i)}
                >
                  <img src={src} alt={t('chat.imageAlt', { n: i + 1 })} className="max-h-64 max-w-full rounded-md border border-border object-contain" />
                </button>
              ))}
            </div>
          )}
          {typeof item.images === 'number' && <span className="text-xs text-subtle">{tn('chat.images', item.images)}</span>}
          {item.text && <div className="max-w-[80%] rounded-xl rounded-br-sm bg-accent-soft px-3.5 py-2 whitespace-pre-wrap text-text">{item.text}</div>}
          <SentAt at={item.at} align="right" />
        </div>
      )
    case 'agent':
      return (
        <div className="flex gap-3" data-testid="agent-message">
          <BrandMark className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <Markdown text={item.text} className="leading-relaxed" />
            <SentAt at={item.at} align="left" />
          </div>
        </div>
      )
    case 'thought':
      return (
        <Disclosure icon={Brain} title={t('chat.thinking')}>
          <div className="whitespace-pre-wrap italic">{item.text}</div>
        </Disclosure>
      )
    case 'notice':
      return (
        <Disclosure icon={NOTICE_ICON[item.noticeKind]} title={item.title} tone={item.failed ? 'danger' : item.noticeKind === 'warning' ? 'warning' : undefined} testId="notice">
          <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text === COMPACTED_TEXT ? t('chat.noticeCompacted') : item.text || t('chat.noticeEmpty')}</pre>
        </Disclosure>
      )
    case 'tool': {
      const agent = item.view?.kind === 'task' ? subagentOfCall(subagents, item.toolCallId) : undefined
      const agentId = item.result?.agentId ?? agent?.id
      return (
        <ToolCallCard
          title={item.title}
          detail={item.detail}
          status={item.status}
          toolKind={item.toolKind}
          view={item.view}
          result={item.result}
          cwd={cwd}
          onReveal={(path) => void window.hub.sessions.revealFile(sessionId, path)}
          onViewFile={(path) => void window.hub.files.openWindow(path, cwd)}
          onOpenAgent={agentId && subagents?.some((s) => s.id === agentId) ? () => openSubagent(sessionId, agentId) : undefined}
        />
      )
    }
    case 'permission':
      return (
        <div role="group" aria-label={t('chat.permissionRequested')} className="ml-8 rounded-lg border border-warning/40 bg-warning-soft p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-warning">
            <ShieldAlert className="size-4" aria-hidden />
            {t('chat.permissionRequested')}
          </div>
          <div className="mt-1 text-sm text-text">{item.title}</div>
          {item.detail && <pre className="mt-1 max-h-32 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">{item.detail}</pre>}
          {item.answer ? (
            <div className="mt-2 text-sm text-muted">{item.answer === '—' ? t('chat.permissionWithdrawn') : t('chat.answered', { answer: item.answer })}</div>
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
        <div>
          <div role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="whitespace-pre-wrap">{item.text}</span>
          </div>
          <SentAt at={item.at} align="left" />
        </div>
      )
    case 'replayStart':
      return (
        <div className="flex items-center gap-3 text-2xs tracking-wide text-subtle uppercase">
          <span className="h-px flex-1 bg-border" />
          <History className="size-3" aria-hidden />
          {tn('chat.resumedHere', item.count)}
          <span className="h-px flex-1 bg-border" />
        </div>
      )
    case 'turnEnd':
      return (
        <div className="flex items-center gap-3 text-2xs tracking-wide text-subtle uppercase" aria-label={turnEndLabel(t, item.stopReason)}>
          <span className="h-px flex-1 bg-border" />
          {turnEndLabel(t, item.stopReason)}
          <span className="h-px flex-1 bg-border" />
        </div>
      )
    case 'exit':
      return <div className="text-center text-xs text-subtle">{t('chat.exited', { code: item.code ?? t('chat.signal') })}</div>
  }
})

/**
 * The structured chat of a session: Markdown replies, tools, permissions, hook notices, pasted
 * images. `active`: its chat is the one on screen, so the composer takes the focus.
 */
export function ChatPane({ data, active = false }: { data: SessionData; active?: boolean }) {
  const { t, tn } = useI18n()
  const v = data.view
  const [text, setText] = useState(() => takeComposerDraft(v.id) ?? '')
  const [images, setImages] = useState<string[]>([])
  const queued = useQueuedPrompts(v.id)
  const bottom = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const open = acceptsInput(v.state)
  const midTurn = v.capabilities.midTurnInput === true
  // Workhub 1's Console.focus(): picking a session puts the cursor in its composer.
  const focusState = useRef({ active: false, enabled: false })
  useEffect(() => {
    const next = { active, enabled: open }
    const typingElsewhere = isEditable(document.activeElement) && document.activeElement !== composer.current
    if (shouldFocusComposer(focusState.current, next, typingElsewhere)) {
      const frame = requestAnimationFrame(() => composer.current?.focus())
      focusState.current = next
      return () => cancelAnimationFrame(frame)
    }
    focusState.current = next
  }, [active, open])
  // A draft written for this session after its chat mounted (Investigate with Claude).
  useEffect(
    () =>
      onComposerDraft((id) => {
        const draft = id === v.id ? takeComposerDraft(id) : undefined
        if (draft !== undefined) setText(draft)
      }),
    [v.id]
  )
  // Interrupting with messages queued: they come back into the composer instead of going out after the turn.
  const [restored, setRestored] = useState(0)
  const draft = useRef({ text, images })
  draft.current = { text, images }
  useEffect(
    () =>
      onRecoveredPrompts((id, prompts) => {
        if (id !== v.id) return
        const next = restoreComposer(draft.current, prompts, MAX_PROMPT_IMAGES)
        draft.current = next
        setText(next.text)
        setImages(next.images)
        setRestored((n) => n + prompts.length)
      }),
    [v.id]
  )
  const interrupt = () => void interruptSession(v.id).catch(() => undefined)
  // The log follows new output only while the reader is at its bottom; scrolling up to read stops
  // it until they scroll back down or send (or queue) a prompt themselves.
  const log = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const followMark = useRef<FollowMark>({ lastPromptId: lastPromptId(data.items), queued: queued.length })
  useEffect(() => {
    const { follow, mark } = followLog(followMark.current, data.items, queued.length, atBottom.current)
    followMark.current = mark
    if (!follow) return
    atBottom.current = true
    // Braces matter: scrollIntoView returns a Promise in recent Chromium, which React would take as a cleanup.
    void bottom.current?.scrollIntoView({ block: 'end' })
  }, [data.items, queued])
  // The log keeps its last line in view when it gets shorter (a narrower window wraps the composer's
  // hint, a notice or attached images appear above it), unless the user had scrolled up to read.
  useEffect(() => {
    const el = log.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const onLogScroll = () => {
    const el = log.current
    // A hidden log (another session on screen) measures zero: that is not the reader scrolling.
    if (el && el.clientHeight > 0) atBottom.current = isAtBottom(el)
  }

  const acceptsImages = v.capabilities.imageInput

  // Usage budget of the session's account (Settings → Usage): past a ceiling, a prompt needs "Send anyway".
  const reads = useAccountUsage()
  const usageSettings = useUsageSettings()
  const now = useNow()
  const accountLabel = useAccountLabel()
  const ownCeilings = useSessionCeilings()[sessionIdentity(v)]
  const gate = sessionBudget(v, reads, usageSettings.budget, usageSettings.accountsOf, now, ownCeilings)
  const [needsConfirm, setNeedsConfirm] = useState(false)
  useEffect(() => {
    if (gate.status.action !== 'block') setNeedsConfirm(false)
  }, [gate.status.action])

  // Continuing elsewhere when the account ran out: the agent's limit (an offer from main) or the gate's ceiling.
  const offer = useContinuityOffer(v.id)
  const { failover, handoff } = useContinuityActions()
  const [continuity, setContinuity] = useState<ContinuityOptions | null>(null)
  const [ceilingDismissed, setCeilingDismissed] = useState(false)
  const [moving, setMoving] = useState(false)
  const blocked = gate.status.action === 'block'
  useEffect(() => {
    setCeilingDismissed(false)
    if (!blocked) return setContinuity(null)
    let alive = true
    void window.hub.continuity.options(v.id).then((o) => alive && setContinuity(o), () => undefined)
    return () => {
      alive = false
    }
  }, [blocked, v.id, v.state])
  const act = async (fn: () => Promise<boolean>) => {
    setMoving(true)
    try {
      await fn()
    } finally {
      setMoving(false)
    }
  }

  const clearCeiling = async () => {
    if (!gate.status.window) return
    // A ceiling set on this session is cleared on the session; the account's one in Settings.
    if (gate.fromSession) return window.hub.usage.setSessionBudget(sessionIdentity(v), setSessionCeiling(ownCeilings, gate.status.window, null))
    const r = await window.hub.config.saveOptions({ usageBudget: setCeiling(usageSettings.budget, gate.key, gate.status.window, null) })
    if (r.ok) await refreshConfig()
  }

  const send = async (override = false) => {
    const value = text.trim()
    if ((!value && images.length === 0) || !open) return
    // The one-shot escape: "Send anyway" passes this prompt only; nothing stored changes.
    if (gatePrompt(gate.status, 'user', override).kind === 'confirm') {
      // Automatic failover: the held prompt goes to the same conversation in the next account.
      const target = continuity?.mode === 'automatic' ? continuity.failover[0] : undefined
      if (target) {
        setText('')
        setImages([])
        void act(() => failover(v, { targetKey: target.key, reason: 'ceiling', ...(gate.status.window ? { window: gate.status.window } : {}), prompt: value }))
        return
      }
      setNeedsConfirm(true)
      return
    }
    setNeedsConfirm(false)
    setRestored(0)
    // While the agent works the message waits for the turn's end (or joins the turn, on Claude).
    if (submitPrompt(v.id, v.state, midTurn, value, images) === 'refused') return
    setText('')
    setImages([])
  }

  const answer = useCallback(
    (requestId: string, optionId: string | null, label: string) => {
      window.hub.sessions.respondPermission(v.id, requestId, optionId)
      markPermission(v.id, requestId, label)
    },
    [v.id]
  )

  // Workhub 1 keys: Return sends, Shift-Return adds a line, Esc interrupts.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape' && v.state === 'busy') {
      e.preventDefault()
      interrupt()
    }
  }

  // Pasted or dropped images: checked before reading (type, size, count), then shown as thumbnails.
  const attach = (data: DataTransfer): boolean => {
    if (!hasImageFiles(data) && !imageFilesOf(data).length) return false
    if (!acceptsImages) {
      pushItem(v.id, 'error', t('chat.imagesUnsupported'))
      return true
    }
    const { accepted, rejected } = pickImageFiles(imageFilesOf(data), images.length)
    if (rejected.some((r) => r.reason !== 'count')) pushItem(v.id, 'error', t('chat.imageRejected'))
    if (rejected.some((r) => r.reason === 'count')) pushItem(v.id, 'error', t('chat.imageTooMany', { n: MAX_PROMPT_IMAGES }))
    if (accepted.length)
      readImageFiles(accepted).then(
        (urls) => setImages((prev) => [...prev, ...urls].slice(0, MAX_PROMPT_IMAGES)),
        () => pushItem(v.id, 'error', t('chat.imageRejected'))
      )
    return true
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (attach(e.clipboardData)) e.preventDefault()
  }
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (hasImageFiles(e.dataTransfer)) e.preventDefault()
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (open && attach(e.dataTransfer)) e.preventDefault()
  }

  // Where the session came from, right after its replayed history (or on top when there is none).
  const replayAt = data.items.findIndex((i) => i.kind === 'replayStart')
  const originLine = v.origin ? (
    <div className="flex items-center gap-2 rounded-md bg-info-soft px-3 py-2 text-sm text-info" data-testid="session-origin">
      <ArrowRightLeft className="size-4 shrink-0" aria-hidden />
      <span>{originText(v.origin, v, t)}</span>
    </div>
  ) : null

  const ceilingOffer = blocked && !offer && !ceilingDismissed && continuity && continuity.mode !== 'off' ? continuity : null

  const placeholder: MessageKey =
    v.state === 'starting'
      ? 'chat.placeholderStarting'
      : v.state === 'ready'
        ? 'chat.placeholder'
        : v.state === 'busy'
          ? midTurn
            ? 'chat.placeholderInject'
            : 'chat.placeholderQueue'
          : 'chat.placeholderClosed'
  const canSend = open && (text.trim().length > 0 || images.length > 0)

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div ref={log} onScroll={onLogScroll} className="min-h-0 flex-1 overflow-y-auto text-[length:var(--wh-chat-font-size,13px)]" aria-live="polite" aria-label={t('chat.log')} role="log">
        <div className="flex w-full flex-col gap-3.5 px-6 py-5">
          {data.items.length === 0 && !v.origin && <p className="py-10 text-center text-sm text-subtle">{t('chat.empty')}</p>}
          {replayAt < 0 && originLine}
          {data.items.map((i, n) => (
            <Fragment key={i.id}>
              <ChatBlock item={i} onAnswer={answer} sessionId={v.id} cwd={v.cwd} subagents={data.monitor.subagents} />
              {n === replayAt && originLine}
            </Fragment>
          ))}
          {queued.length > 0 && (
            <ul className="flex flex-col items-end gap-1.5" aria-label={t('chat.queuedList')} data-testid="queued-prompts">
              {queued.map((q) => (
                <li key={q.id} className="flex max-w-[80%] flex-col items-end gap-1">
                  {q.images.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5 opacity-70">
                      {q.images.map((src, i) => (
                        <img key={i} src={src} alt={t('chat.imageAlt', { n: i + 1 })} className="size-12 rounded-md border border-border object-cover" />
                      ))}
                    </div>
                  )}
                  <div className="flex items-start gap-1.5">
                    <div className="rounded-xl rounded-br-sm border border-dashed border-border px-3.5 py-2 whitespace-pre-wrap text-muted">
                      {q.text || <span className="text-subtle">{tn('chat.images', q.images.length)}</span>}
                    </div>
                    <IconButton size="sm" label={t('chat.removeQueued')} icon={<X className="size-3" />} onClick={() => removeQueuedPrompt(v.id, q.id)} className="mt-1" />
                  </div>
                  <span className="flex items-center gap-1 text-2xs text-subtle">
                    <Clock className="size-3" aria-hidden />
                    {t('chat.queued')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="shrink-0 px-6 pb-5">
        <div className="w-full rounded-xl border border-border bg-surface shadow-md transition-colors focus-within:border-accent/60" onDragOver={onDragOver} onDrop={onDrop}>
          <BudgetNotice
            status={gate.status}
            account={accountLabel(usageSettings.accountsOf(v.agentId), reads.find((r) => r.key === gate.key)?.name ?? v.accountName ?? '')}
            now={now}
            needsConfirm={needsConfirm}
            canSend={canSend}
            onSendAnyway={() => void send(true)}
            onClear={() => void clearCeiling()}
          />
          {offer ? (
            <ContinuityNotice
              reason={offer.reason}
              account={offer.accountLabel}
              window={offer.window}
              resetsAt={offer.resetsAt}
              now={now}
              target={offer.target}
              handoff={offer.handoff}
              busy={moving}
              onContinue={(target) => void act(() => failover(v, { targetKey: target.key, reason: offer.reason, ...(offer.window ? { window: offer.window } : {}) }))}
              onHandoff={(target) => void act(() => handoff(v, target.key, target.label))}
              onWait={() => dismissOffer(v.id)}
            />
          ) : (
            ceilingOffer && (
              <ContinuityNotice
                reason="ceiling"
                account={v.accountName ?? v.label}
                window={gate.status.window}
                now={now}
                target={ceilingOffer.failover[0]}
                handoff={ceilingOffer.handoff[0]}
                busy={moving}
                onContinue={(target) => void act(() => failover(v, { targetKey: target.key, reason: 'ceiling', ...(gate.status.window ? { window: gate.status.window } : {}) }))}
                onHandoff={(target) => void act(() => handoff(v, target.key, target.label))}
                onWait={() => setCeilingDismissed(true)}
              />
            )
          )}
          {restored > 0 && (
            <div role="status" className="flex items-center gap-2 px-4 pt-2.5 text-xs text-muted" data-testid="queue-restored">
              <Info className="size-3.5 shrink-0" aria-hidden />
              <span className="flex-1">{tn('chat.queueRestored', restored)}</span>
              <IconButton size="sm" label={t('common.close')} icon={<X className="size-3" />} onClick={() => setRestored(0)} />
            </div>
          )}
          {images.length > 0 && (
            <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label={t('chat.attached')}>
              {images.map((src, i) => (
                <li key={i} className="relative">
                  <img src={src} alt={t('chat.imageAlt', { n: i + 1 })} className="size-14 rounded-md border border-border object-cover" />
                  <IconButton
                    size="sm"
                    label={t('chat.removeImage', { n: i + 1 })}
                    icon={<X className="size-3" />}
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -top-1.5 -right-1.5 size-5 rounded-full border border-border bg-surface-raised"
                  />
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={composer}
            aria-label={t('chat.prompt')}
            rows={2}
            value={text}
            disabled={!open}
            placeholder={t(placeholder)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="block max-h-48 min-h-14 w-full resize-none bg-transparent px-4 pt-3 text-base text-text placeholder:text-subtle focus:outline-none disabled:opacity-60"
          />
          <div className="flex items-center gap-2 px-3 pb-1.5">
            <span className="min-w-0 truncate text-xs text-subtle" title={acceptsImages ? t('chat.keysImages') : t('chat.keys')}>
              {acceptsImages ? t('chat.keysImages') : t('chat.keys')}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {v.state === 'busy' && (
                <Button size="sm" variant="secondary" icon={<Square className="size-3" aria-hidden />} onClick={interrupt}>
                  {t('chat.interrupt')}
                </Button>
              )}
              <IconButton
                label={t('chat.send')}
                icon={<ArrowUp className="size-4" />}
                disabled={!canSend}
                onClick={() => void send()}
                className="bg-accent text-accent-fg hover:bg-accent-strong hover:text-accent-fg"
              />
            </div>
          </div>
          <SessionControls view={v} reportedModel={data.monitor.model} />
        </div>
      </div>
    </div>
  )
}

const STOP_REASON_KEYS: Record<string, MessageKey> = {
  cancelled: 'chat.stop.cancelled',
  max_tokens: 'chat.stop.maxTokens',
  max_turn_requests: 'chat.stop.maxTurnRequests',
  refusal: 'chat.stop.refusal'
}

/** A turn end divider's text: "Done", a readable reason, or the agent's own reason when it is unknown. */
export function turnEndLabel(t: (key: MessageKey, params?: Record<string, string | number>) => string, stopReason: string): string {
  if (stopReason === 'end_turn') return t('chat.turnDone')
  const key = STOP_REASON_KEYS[stopReason]
  return key ? t(key) : t('chat.turnEnded', { reason: stopReason })
}
