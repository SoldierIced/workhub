import { ArrowDown, ArrowRightLeft, ArrowUp, Brain, ChevronRight, FoldVertical, CircleAlert, Clock, History, ImagePlus, Info, LoaderCircle, Pause, Play, Square, TriangleAlert, Volume2, Webhook, X, type LucideIcon } from 'lucide-react'
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { appOptions, filterSlashCommands, gatePrompt, insertMention, isApiWindow, mentionTrigger, PROMPT_NOT_RECEIVED, rankFiles, sessionIdentity, setApiCeiling, setCeiling, setSessionCeiling, slashQuery, type SlashCommandInfo, type SubagentSummary } from '@workhub/core'
import { Button, IconButton } from '../../components/atoms'
import { CopyButton, Markdown, type MarkdownActions } from '../../components/molecules'
import { useToast } from '../../components/molecules/Toast'
import { BrandMark, ToolCallCard } from '../../components/organisms'
import { ChatFind } from './ChatFind'
import { CloseSessionDialog } from '../../components/organisms/CloseSessionDialog'
import { isWorking } from '../../components/organisms/SessionList'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { onAnswerFocus, pendingFocusTarget, usePendingFocus } from '../../lib/pendingFocus'
import { historyKey, promptHistory, type PromptHistoryState } from '../../lib/promptHistory'
import { clearStoredDraft, flushStoredDrafts, loadStoredDraft, onComposerDraft, saveStoredDraft, takeComposerDraft } from '../../lib/drafts'
import { hasImageFiles, imageFilesOf, insertImageMarkers, MAX_IMAGE_FILE_MB, pickImageFiles, PROMPT_IMAGE_TYPES, readImageFiles, removeImageMarker } from '../../lib/images'
import { acceptsInput, restoreComposer } from '../../lib/prompt-queue'
import { isEditable, shouldFocusComposer } from '../../lib/composer-focus'
import { interruptSession, onRecoveredPrompts, removeQueuedPrompt, submitPrompt, useQueuedPrompts } from '../../promptQueue'
import { markPermission, openChatImage, pushItem, pushNotice, type ChatItem, type SessionData } from '../../store'
import { runWorkhubCommand, sessionSlashCommands } from '../../lib/chatCommands'
import { requestSessionClose } from '../../lib/closeSession'
import { SlashCommandMenu, slashOptionId } from './SlashCommandMenu'
import { FileMentionMenu, mentionOptionId } from './FileMentionMenu'
import { followLog, isAtBottom, lastPromptId, type FollowMark } from '../../lib/chatScroll'
import { onRevealChatItem, revealEarlier, revealItemStart, showJumpToLatest, windowAfterScroll, windowStart } from '../../lib/chatWindow'
import { currentConfig, refreshConfig, useConfig } from '../../configStore'
import { isLongMessage } from '../../lib/longMessage'
import { fallbackNoticeKeys, listen, listenId, stopListening, toggleListen, useListenPhase, type ListenOutcome } from '../../lib/listen'
import { sessionBudget } from '../../lib/agent-usage'
import { useAccountLabel, useAccountUsage, useApiSpend, useNow, useSessionCeilings, useUsageSettings } from '../../lib/usage'
import { BudgetNotice } from './BudgetNotice'
import { IdleContextNotice } from './IdleContextNotice'
import { BackgroundTasksNotice } from './BackgroundTasksNotice'
import { waitingTasks } from '../../lib/backgroundTasks'
import { idleContext, lastActivityAt } from '../../lib/idle-context'
import { SessionControls } from './SessionControls'
import { openRequests, PermissionCard, PermissionMarker } from './PermissionCard'
import type { ContinuityOptions } from '@shared/continuity-api'
import { dismissOffer, originText, useContinuityActions, useContinuityOffer } from '../../lib/continuity'
import { ContinuityNotice } from './ContinuityNotice'
import { openSubagent, subagentOfCall } from '../../lib/subagentView'
import { errorText } from '../../lib/errorText'
import { terminalChannel } from '@shared/api'
import { FileChecker } from '../../lib/chatLinks'

/** The Claude adapter's English compaction and `/clear` notices, shown in the reader's language. */
const COMPACTED_TEXT = 'The conversation was compacted.'
const CLEARED_TEXT = 'The conversation was cleared.'
const NOTICE_ICON: Record<'hook' | 'info' | 'warning', LucideIcon> = { hook: Webhook, info: Info, warning: TriangleAlert }
/** The input grows with its text up to this height (`max-h-48`), then scrolls. */
const MAX_COMPOSER_HEIGHT = 192

/** The number a pasted image goes by in the prompt's text (`[Image 2]`), on its thumbnail. */
function ImageNumber({ n }: { n: number }) {
  return (
    <span aria-hidden className="absolute bottom-1 left-1 rounded-sm bg-black/65 px-1 text-2xs font-medium text-white tabular-nums">
      {n}
    </span>
  )
}

/** A key, drawn as a key cap. */
function KeyCap({ children }: { children: string }) {
  return <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border bg-surface-raised px-1 font-sans text-2xs text-muted">{children}</kbd>
}

/** What a key does, next to its cap: `↵ send`. */
function KeyHint({ keys, children }: { keys: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <KeyCap>{keys}</KeyCap>
      {children}
    </span>
  )
}

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

/**
 * Where the agent compacted the conversation, drawn across the chat like the resume divider so it
 * is seen: a spinner while it summarizes, then what was summarized (with the summary to open), or
 * why it failed.
 */
function CompactionDivider({ item }: { item: Extract<ChatItem, { kind: 'compaction' }> }) {
  const { t, locale } = useI18n()
  const failed = item.phase === 'failed'
  const facts = [
    item.trigger === 'auto' ? t('chat.compaction.auto') : item.trigger === 'manual' ? t('chat.compaction.manual') : null,
    item.preTokens !== undefined ? t('chat.compaction.tokens', { tokens: new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(item.preTokens) }) : null
  ].filter(Boolean)
  const label = item.phase === 'running' ? t('chat.compaction.running') : failed ? (item.error ? t('chat.compaction.failedWhy', { error: item.error }) : t('chat.compaction.failed')) : t('chat.compaction.done')
  return (
    <div className="flex flex-col gap-1.5" data-testid="chat-compaction" role="status">
      <div className={cn('flex items-center gap-3 text-xs font-medium', failed ? 'text-danger' : item.phase === 'running' ? 'text-info' : 'text-muted')}>
        <span className={cn('h-px flex-1', failed ? 'bg-danger/40' : 'bg-border')} />
        {item.phase === 'running' ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : failed ? <CircleAlert className="size-3.5" aria-hidden /> : <FoldVertical className="size-3.5" aria-hidden />}
        <span className="min-w-0 text-center [overflow-wrap:anywhere]">{[label, ...facts].join(' · ')}</span>
        <span className={cn('h-px flex-1', failed ? 'bg-danger/40' : 'bg-border')} />
      </div>
      {item.summary && (
        <details className="group mx-auto w-full max-w-3xl text-sm text-muted">
          <summary className="flex cursor-pointer list-none items-center justify-center gap-1 text-xs select-none hover:text-text">
            <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
            {t('chat.compaction.summary')}
          </summary>
          <div className="mt-1.5 max-h-96 overflow-auto rounded-md border border-border bg-surface px-3 py-2">
            <Markdown text={item.summary} />
          </div>
        </details>
      )}
    </div>
  )
}

/** Taller than this (px) a user message is collapsed to `max-h-80` (320px); the slack avoids hiding just a line or two. */
const TALL_MESSAGE_PX = 400

/** A user message; a very long one (a pasted log) is shown collapsed with Show more / Show less. */
function UserText({ text }: { text: string }) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  // A first guess from the text, then the real rendered height decides: one wrapped line with no
  // breaks (a pasted JSON) can be as tall as many short lines.
  const [long, setLong] = useState(() => isLongMessage(text))
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setLong(el.scrollHeight > TALL_MESSAGE_PX)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])
  const collapsed = long && !expanded
  return (
    <div className="flex max-w-[80%] min-w-0 flex-col items-end gap-1">
      <div
        ref={box}
        className={cn(
          'max-w-full min-w-0 rounded-xl rounded-br-sm bg-accent-soft px-3.5 py-2 whitespace-pre-wrap text-text [overflow-wrap:anywhere]',
          // Collapsed: the first lines, fading out at the bottom.
          collapsed && 'max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]'
        )}
        data-testid="user-message"
      >
        {text}
      </div>
      {long && (
        <button type="button" aria-expanded={expanded} className="text-xs text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setExpanded(!expanded)}>
          {expanded ? t('chat.showLess') : t('chat.showMore')}
        </button>
      )}
    </div>
  )
}

/**
 * Listen to an agent message: short ones are read as they are, long ones summarized first by a
 * cheap model (Settings → General → Voice). Click again to cancel the summary, pause or resume;
 * the stop button shows while it plays or is paused.
 */
function ListenButton({ sessionId, itemId, text }: { sessionId: string; itemId: number; text: string }) {
  const { t, locale } = useI18n()
  const toast = useToast()
  const snap = useConfig()
  const phase = useListenPhase(listenId(sessionId, itemId))
  const start = () => {
    const options = appOptions(snap?.config ?? { options: undefined })
    void listen({ sessionId, itemId, markdown: text, voice: { voice: options.speechVoice, wpm: options.speechRate, lang: locale } }).then((outcome: ListenOutcome) => {
      // The app still read the message: a caveat, not an error.
      if (outcome.kind === 'fallback') toast(fallbackNoticeKeys(outcome).map((key) => t(key)).join(' '), 'warning')
      else if (outcome.kind === 'silent') toast(t('chat.listenSilent'), 'danger')
    })
  }
  const label = phase === 'summarizing' ? t('chat.listenCancel') : phase === 'playing' ? t('chat.listenPause') : phase === 'paused' ? t('chat.listenResume') : t('chat.listen')
  const icon =
    phase === 'summarizing' ? (
      <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
    ) : phase === 'playing' ? (
      <Pause className="size-3.5" aria-hidden />
    ) : phase === 'paused' ? (
      <Play className="size-3.5" aria-hidden />
    ) : (
      <Volume2 className="size-3.5" aria-hidden />
    )
  return (
    <>
      <IconButton size="sm" className={cn('size-6', phase !== 'idle' && 'text-accent')} label={label} icon={icon} aria-busy={phase === 'summarizing' || undefined} onClick={() => toggleListen(phase, start)} data-testid="listen-button" />
      {(phase === 'playing' || phase === 'paused') && <IconButton size="sm" className="size-6" label={t('chat.listenStop')} icon={<Square className="size-3" aria-hidden />} onClick={stopListening} data-testid="listen-stop" />}
    </>
  )
}

interface ChatBlockProps {
  item: ChatItem
  onAnswer: (requestId: string, optionId: string | null, label: string, answers?: Record<string, string>) => void
  sessionId: string
  cwd: string
  /** The session has a Shell view: shell blocks in replies get a run button. */
  hasShell: boolean
  subagents?: SubagentSummary[]
}

/** Which paths in replies are files, shared by every chat. */
const fileChecker = new FileChecker((paths, cwd) => window.hub.files.areFiles(paths, cwd))

/** Shows the session's Shell view and types the command there, line by line, then Enter. */
async function runInShell(sessionId: string, command: string): Promise<void> {
  await window.hub.sessions.setMode(sessionId, 'shell')
  window.hub.sessions.write(terminalChannel(sessionId, 'shell'), `${command.replace(/\r?\n/g, '\r')}\r`)
}

/**
 * A message is rendered again only when it changes (items are replaced, never mutated): a long chat
 * would otherwise parse all its Markdown again on every render of the pane (a clock tick, a sidebar
 * click that refreshes the config).
 */
const ChatBlock = memo(function ChatBlock({ item, onAnswer, sessionId, cwd, hasShell, subagents }: ChatBlockProps) {
  const replyActions = useMemo<MarkdownActions>(
    () => ({
      openFile: (path) => void window.hub.files.openWindow(path, cwd),
      isFile: { known: (path) => fileChecker.peek(path, cwd), check: (path) => fileChecker.isFile(path, cwd) },
      ...(hasShell ? { runCommand: (command: string) => void runInShell(sessionId, command).catch((e: unknown) => pushItem(sessionId, 'error', errorText(e))) } : {})
    }),
    [sessionId, cwd, hasShell]
  )
  const { t, tn } = useI18n()
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex min-w-0 flex-col items-end gap-1.5">
          {Array.isArray(item.images) && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {item.images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  title={t('chat.imageOpen')}
                  aria-label={t('chat.imageOpenLabel', { n: i + 1 })}
                  data-testid="chat-pasted-image"
                  className="relative max-w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => void openChatImage(sessionId, item, i)}
                >
                  <img src={src} alt={t('chat.imageAlt', { n: i + 1 })} className="max-h-64 max-w-full rounded-md border border-border object-contain" />
                  <ImageNumber n={i + 1} />
                </button>
              ))}
            </div>
          )}
          {typeof item.images === 'number' && <span className="text-xs text-subtle">{tn('chat.images', item.images)}</span>}
          {item.text && <UserText text={item.text} />}
          <div className="flex items-center gap-1">
            <SentAt at={item.at} align="right" />
            {item.text && <CopyButton text={() => item.text} />}
          </div>
        </div>
      )
    case 'agent':
      return (
        <div className="flex gap-3" data-testid="agent-message">
          <BrandMark className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <Markdown text={item.text} className="leading-relaxed" actions={replyActions} />
            <div className="flex items-center gap-1">
              <SentAt at={item.at} align="left" />
              <CopyButton text={() => item.text} />
              <ListenButton sessionId={sessionId} itemId={item.id} text={item.text} />
            </div>
          </div>
        </div>
      )
    case 'thought':
      return (
        <Disclosure icon={Brain} title={t('chat.thinking')}>
          <div className="whitespace-pre-wrap italic [overflow-wrap:anywhere]">{item.text}</div>
        </Disclosure>
      )
    case 'compaction':
      return <CompactionDivider item={item} />
    case 'notice':
      return (
        <Disclosure icon={NOTICE_ICON[item.noticeKind]} title={item.title} tone={item.failed ? 'danger' : item.noticeKind === 'warning' ? 'warning' : undefined} testId="notice">
          <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text === COMPACTED_TEXT ? t('chat.noticeCompacted') : item.text === CLEARED_TEXT ? t('chat.noticeCleared') : item.text || t('chat.noticeEmpty')}</pre>
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
      return item.answer === undefined ? <PermissionMarker item={item} /> : <PermissionCard item={item} onAnswer={onAnswer} />
    case 'error':
      return (
        <div>
          <div role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text === PROMPT_NOT_RECEIVED ? t('chat.promptNotReceived') : item.text}</span>
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
    case 'truncated':
      return (
        <div className="flex items-center gap-3 text-2xs tracking-wide text-subtle uppercase">
          <span className="h-px flex-1 bg-border" />
          <History className="size-3" aria-hidden />
          {t('chat.truncated')}
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
      return (
        <div className="flex flex-col items-center gap-1 text-xs text-subtle">
          {t('chat.exited', { code: item.code ?? t('chat.signal') })}
          {item.stderr && (
            <pre className="max-w-full overflow-x-auto rounded bg-surface-raised px-3 py-2 text-left font-mono text-2xs whitespace-pre-wrap text-muted" aria-label={t('chat.exitedStderr')}>
              {item.stderr.join('\n')}
            </pre>
          )}
        </div>
      )
  }
})

/**
 * The structured chat of a session: Markdown replies, tools, permissions, hook notices, pasted
 * images. `active`: its chat is the one on screen, so the composer takes the focus.
 */
export function ChatPane({ data, active = false }: { data: SessionData; active?: boolean }) {
  const { t, tn } = useI18n()
  const v = data.view
  const [text, setText] = useState(() => takeComposerDraft(v.id) ?? loadStoredDraft(v.id))
  const [images, setImages] = useState<string[]>([])
  // The text survives the pane unmounting (detach, dock): kept while typing, read back on mount.
  useEffect(() => {
    saveStoredDraft(v.id, text)
  }, [v.id, text])
  useEffect(() => flushStoredDrafts, [])
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
      onRecoveredPrompts((id, prompts, reason) => {
        if (id !== v.id) return
        const next = restoreComposer(draft.current, prompts)
        draft.current = next
        setText(next.text)
        setImages(next.images)
        // A message the agent never took says so in the chat itself.
        if (reason === 'interrupted') setRestored((n) => n + prompts.length)
      }),
    [v.id]
  )
  const interrupt = () => void interruptSession(v.id).catch(() => undefined)
  // The log follows new output only while the reader is at its bottom; scrolling up to read stops
  // it until they scroll back down or send (or queue) a prompt themselves.
  const log = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  // The same, for what it shows ("Jump to latest").
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  // Only the newest part of a long chat is rendered (see chatWindow.ts): `startId` is its first item,
  // undefined while it follows the chat.
  const [startId, setStartId] = useState<number | undefined>(undefined)
  const start = windowStart(data.items, startId)
  const shown = useMemo(() => data.items.slice(start), [data.items, start])
  const startNow = useRef({ items: data.items, start })
  startNow.current = { items: data.items, start }
  const followMark = useRef<FollowMark>({ lastPromptId: lastPromptId(data.items), queued: queued.length })
  useEffect(() => {
    const { follow, mark } = followLog(followMark.current, data.items, queued.length, atBottom.current)
    followMark.current = mark
    if (!follow) return
    atBottom.current = true
    setAwayFromBottom(false)
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
    if (!el || el.clientHeight === 0) return
    const here = isAtBottom(el)
    atBottom.current = here
    setAwayFromBottom(!here)
    const { items, start: first } = startNow.current
    setStartId((id) => windowAfterScroll(id, items[first]?.id, here))
  }
  // "Show earlier messages" keeps what was on screen where it was: the distance from the bottom is
  // kept across the render that adds the chunk above.
  const keepFromBottom = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = log.current
    if (!el || keepFromBottom.current === null) return
    el.scrollTop = el.scrollHeight - keepFromBottom.current
    keepFromBottom.current = null
  }, [start])
  const showEarlier = () => {
    const id = revealEarlier(data.items, start)
    const el = log.current
    if (id === undefined || !el) return
    keepFromBottom.current = el.scrollHeight - el.scrollTop
    setStartId(id)
  }
  const jumpToLatest = () => {
    atBottom.current = true
    setAwayFromBottom(false)
    setStartId(undefined)
    void bottom.current?.scrollIntoView({ block: 'end' })
  }
  // Find in the conversation and export reveal an item that may be above the window (revealChatItem).
  const [revealing, setRevealing] = useState<number | null>(null)
  useEffect(
    () =>
      onRevealChatItem((id, itemId) => {
        if (id !== v.id) return false
        const { items, start: first } = startNow.current
        const next = revealItemStart(items, first, itemId)
        if (next === null) return false
        atBottom.current = false
        setStartId(next)
        setRevealing(itemId)
        return true
      }),
    [v.id]
  )
  useLayoutEffect(() => {
    if (revealing === null) return
    setRevealing(null)
    const el = log.current?.querySelector(`[data-chat-item="${revealing}"]`)
    void (el?.firstElementChild ?? el)?.scrollIntoView({ block: 'center' })
  }, [revealing])

  const acceptsImages = v.capabilities.imageInput
  const imageLabel = t('chat.imageMarkerLabel')
  const fileInput = useRef<HTMLInputElement>(null)

  // The input is one line to begin with and grows with its text, up to MAX_COMPOSER_HEIGHT; it is
  // measured again when its width changes (a wrap moves lines) and when its session comes on screen.
  const grow = useCallback(() => {
    const el = composer.current
    if (!el || el.clientWidth === 0) return
    el.style.height = 'auto'
    const next = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`
    if (el.style.height !== next) el.style.height = next
  }, [])
  useLayoutEffect(grow, [grow, text, active])
  useEffect(() => {
    const el = composer.current
    if (!el) return
    const observer = new ResizeObserver(grow)
    observer.observe(el)
    return () => observer.disconnect()
  }, [grow])

  // The whole box is the target: a click on its padding or its bottom bar (not on a control) puts the cursor in the input.
  const focusFromBox = (e: MouseEvent<HTMLDivElement>) => {
    if (!open || !(e.target instanceof Element)) return
    if (e.target.closest('button, a, input, select, textarea, img, [role="button"], [role="combobox"], [role="listbox"], [role="option"]')) return
    if (window.getSelection()?.toString()) return
    composer.current?.focus()
  }

  // Usage budget of the session's account (Settings → Usage): past a ceiling, a prompt needs "Send anyway".
  const reads = useAccountUsage()
  const usageSettings = useUsageSettings()
  const now = useNow()
  const accountLabel = useAccountLabel()
  const ownCeilings = useSessionCeilings()[sessionIdentity(v)]
  const apiSpend = useApiSpend()
  const gate = sessionBudget(v, reads, usageSettings.budget, usageSettings.accountsOf, now, ownCeilings, apiSpend)
  const [needsConfirm, setNeedsConfirm] = useState(false)
  useEffect(() => {
    if (gate.status.action !== 'block') setNeedsConfirm(false)
  }, [gate.status.action])

  // Idle past the prompt cache's lifetime: the next message resends the whole context. Dismissed until the conversation moves again.
  const lastAt = useMemo(() => lastActivityAt(data.items), [data.items])
  const [idleDismissedAt, setIdleDismissedAt] = useState<number | undefined>(undefined)
  const idle = v.state === 'busy' || v.state === 'starting' || idleDismissedAt === lastAt ? undefined : idleContext(lastAt, now, data.monitor.context)

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
    const budget = usageSettings.budget
    const next = isApiWindow(gate.status.window)
      ? { ...budget, apiCeilings: setApiCeiling(budget.apiCeilings, usageSettings.accountsOf(v.agentId), gate.status.window === 'api-daily' ? 'daily' : 'weekly', null) }
      : setCeiling(budget, gate.key, gate.status.window, null)
    const r = await window.hub.config.saveOptions({ usageBudget: next })
    if (r.ok) await refreshConfig()
  }

  // The `/` menu: Workhub's commands, then the agent's. Esc closes it for the draft it was open on.
  const allCommands = useMemo(() => sessionSlashCommands(v, t), [v, t])
  const [menuSelected, setMenuSelected] = useState(0)
  const [menuDismissedFor, setMenuDismissedFor] = useState<string | null>(null)
  // `/exit`: the close button's path (the dialog for a working session or a worktree, else closing at once), here in the chat so every window has it.
  const [closing, setClosing] = useState(false)
  const exit = (id: string) =>
    requestSessionClose(v, isWorking(data), {
      profiles: async () => (currentConfig() ?? (await refreshConfig())).config.profiles,
      ask: () => setClosing(true),
      close: () => window.hub.sessions.close(id),
      fail: (e) => {
        throw e
      }
    })
  const query = slashQuery(text)
  const menu = useMemo(() => (query === null || menuDismissedFor === text ? [] : filterSlashCommands(allCommands, query)), [allCommands, query, menuDismissedFor, text])
  const menuIndex = Math.min(menuSelected, Math.max(0, menu.length - 1))
  useEffect(() => setMenuSelected(0), [query])
  const pickCommand = (command: SlashCommandInfo) => {
    setText(`/${command.name} `)
    composer.current?.focus()
  }

  // The `@` menu: the session's files that match the word the caret is in. It never opens with the
  // `/` menu; Esc closes it for the draft and caret it was open on.
  const [caret, setCaret] = useState(0)
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const [mentionSelected, setMentionSelected] = useState(0)
  const [mentionDismissedFor, setMentionDismissedFor] = useState<string | null>(null)
  const trigger = menu.length === 0 ? mentionTrigger(text, caret) : null
  const mentionOpen = trigger !== null
  const mentionWord = trigger?.query ?? null
  const mentionMenu = useMemo(
    () => (mentionWord === null || mentionDismissedFor === `${caret}:${text}` ? [] : rankFiles(mentionFiles, mentionWord)),
    [mentionFiles, mentionWord, mentionDismissedFor, caret, text]
  )
  const mentionIndex = Math.min(mentionSelected, Math.max(0, mentionMenu.length - 1))
  useEffect(() => setMentionSelected(0), [mentionWord])
  // The main process lists the folder (cached for a few seconds), by session id, when a mention starts.
  useEffect(() => {
    if (!mentionOpen) return
    let live = true
    window.hub.sessions.files(v.id).then(
      (r) => live && setMentionFiles(r.files),
      () => live && setMentionFiles([])
    )
    return () => {
      live = false
    }
  }, [mentionOpen, v.id])
  const pickMention = (path: string) => {
    if (!trigger) return
    const next = insertMention(text, caret, trigger, path)
    setText(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => {
      composer.current?.focus()
      composer.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  const send = async (override = false) => {
    const value = text.trim()
    if ((!value && images.length === 0) || !open) return
    // Workhub's own commands (`/rename`) run here and never reach the agent; any other `/text` goes as typed.
    if (
      images.length === 0 &&
      runWorkhubCommand(
        v,
        value,
        {
          rename: (id, name) => window.hub.sessions.rename(id, name),
          setModel: (id, model) => window.hub.sessions.setModel(id, model),
          login: (id) => window.hub.sessions.typeInConsole(id, '/login'),
          remoteControl: (id) => window.hub.sessions.typeInConsole(id, '/remote-control'),
          terminal: (id, line) => window.hub.sessions.typeInConsole(id, line),
          exit,
          report: (kind, message) => (kind === 'error' ? pushItem(v.id, 'error', message) : pushNotice(v.id, message, value))
        },
        t
      )
    ) {
      setText('')
      return
    }
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
    clearStoredDraft(v.id)
    setText('')
    setImages([])
  }

  // Open requests stay above the composer, whatever the log scrolled to, until answered.
  const pending = useMemo(() => openRequests(data.items), [data.items])
  const pendingBox = useRef<HTMLElement>(null)
  const focusAfterAnswer = usePendingFocus(pending, pendingBox, composer)
  // Answer Pending Request (⇧⌘A): the oldest open request takes the focus; 1-9 then pick its buttons.
  const pendingNow = useRef(pending)
  pendingNow.current = pending
  useEffect(
    () =>
      onAnswerFocus((id) => {
        const first = pendingNow.current[0]
        if (id === v.id && first) pendingFocusTarget(pendingBox.current, first.requestId, null)?.focus()
      }),
    [v.id]
  )
  const answer = useCallback(
    (requestId: string, optionId: string | null, label: string, answers?: Record<string, string>) => {
      focusAfterAnswer(requestId)
      window.hub.sessions.respondPermission(v.id, requestId, optionId, answers)
      markPermission(v.id, requestId, label)
    },
    [v.id, focusAfterAnswer]
  )

  // ↑ and ↓ recall the session's earlier prompts (read when pressed, not on every streamed flush); Esc puts the draft back.
  const history = useRef<PromptHistoryState>(null)
  const recall = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const key = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'Escape' ? 'escape' : null
    const el = e.currentTarget
    if (!key || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing || el.selectionStart !== el.selectionEnd) return false
    const next = historyKey(history.current, key, promptHistory(data.items), text, el.selectionStart)
    if (!next) return false
    e.preventDefault()
    history.current = next.state
    // A recalled `/command` does not open the slash menu: ↑ and ↓ keep walking the history.
    if (next.state) setMenuDismissedFor(next.text)
    setText(next.text)
    requestAnimationFrame(() => el.setSelectionRange(next.text.length, next.text.length))
    return true
  }

  // Workhub 1 keys: Return sends, Shift-Return adds a line, Esc interrupts.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMenu.length > 0 && !e.nativeEvent.isComposing) {
      const pick = mentionMenu[mentionIndex]!
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionSelected((mentionIndex + (e.key === 'ArrowDown' ? 1 : mentionMenu.length - 1)) % mentionMenu.length)
        return
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) {
        e.preventDefault()
        pickMention(pick)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionDismissedFor(`${caret}:${text}`)
        return
      }
    }
    if (menu.length > 0 && !e.nativeEvent.isComposing) {
      const pick = menu[menuIndex]!
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setMenuSelected((menuIndex + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length)
        return
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        pickCommand(pick)
        return
      }
      // Enter picks the entry; on a command typed in full it sends it.
      if (e.key === 'Enter' && !e.shiftKey && text !== `/${pick.name}`) {
        e.preventDefault()
        pickCommand(pick)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuDismissedFor(text)
        return
      }
    }
    if (menu.length === 0 && mentionMenu.length === 0 && recall(e)) return
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      history.current = null
      void send()
    } else if (e.key === 'Escape' && v.state === 'busy') {
      e.preventDefault()
      interrupt()
    }
  }

  // Pasted, dropped or picked images: checked before reading (type, size, count), then shown as
  // numbered thumbnails and named in the text where the caret is (`[Image 2]`), so the prompt can
  // say which image it talks about.
  const attachFiles = (files: readonly File[]) => {
    if (!acceptsImages) {
      pushItem(v.id, 'error', t('chat.imagesUnsupported'))
      return
    }
    const { accepted, rejected } = pickImageFiles(files)
    if (rejected.length) pushItem(v.id, 'error', t('chat.imageRejected', { size: MAX_IMAGE_FILE_MB }))
    if (!accepted.length) return
    const from = images.length
    const el = composer.current
    const caret = el && document.activeElement === el ? el.selectionStart : text.length
    readImageFiles(accepted).then(
      (urls) => {
        setImages((prev) => [...prev, ...urls])
        let after = caret
        setText((current) => {
          const next = insertImageMarkers(current, caret, imageLabel, from, urls.length)
          after = next.caret
          return next.text
        })
        requestAnimationFrame(() => {
          el?.focus()
          el?.setSelectionRange(after, after)
        })
      },
      () => pushItem(v.id, 'error', t('chat.imageRejected', { size: MAX_IMAGE_FILE_MB }))
    )
  }
  const attach = (data: DataTransfer): boolean => {
    if (!hasImageFiles(data) && !imageFilesOf(data).length) return false
    attachFiles(imageFilesOf(data))
    return true
  }
  const pickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    attachFiles([...(e.target.files ?? [])])
    e.target.value = ''
  }
  const removeImage = (i: number) => {
    setImages((prev) => prev.filter((_, j) => j !== i))
    setText((current) => removeImageMarker(current, imageLabel, i + 1))
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
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ChatFind sessionId={v.id} items={data.items} active={active} log={log} />
        <div ref={log} data-chat-log={v.id} onScroll={onLogScroll} className="min-h-0 flex-1 overflow-y-auto text-[length:var(--wh-chat-font-size,13px)]" aria-live="polite" aria-label={t('chat.log')} role="log">
          <div className="flex w-full min-w-0 flex-col gap-3.5 px-6 py-5">
            {data.items.length === 0 && !v.origin && <p className="py-10 text-center text-sm text-subtle">{t('chat.empty')}</p>}
            {start > 0 && (
              <div className="flex justify-center">
                <Button size="sm" variant="secondary" onClick={showEarlier} data-testid="chat-show-earlier">
                  {t('chat.showEarlier')}
                </Button>
              </div>
            )}
            {replayAt < 0 && originLine}
            {shown.map((i, n) => (
              <Fragment key={i.id}>
                {/* `contents`: the wrapper only names the item (revealChatItem); the layout is the block's own. */}
                <div className="contents" data-chat-item={i.id}>
                  {/* Only tool calls show sub-agents: a monitor patch replaces the list, and passing it to every block would render them all again. */}
                  <ChatBlock item={i} onAnswer={answer} sessionId={v.id} cwd={v.cwd} hasShell={v.modes.includes('shell')} subagents={i.kind === 'tool' ? data.monitor.subagents : undefined} />
                </div>
                {start + n === replayAt && originLine}
              </Fragment>
            ))}
            {queued.length > 0 && (
              <ul className="flex flex-col items-end gap-1.5" aria-label={t('chat.queuedList')} data-testid="queued-prompts">
                {queued.map((q) => (
                  <li key={q.id} className="flex max-w-[80%] min-w-0 flex-col items-end gap-1">
                    {q.images.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5 opacity-70">
                        {q.images.map((src, i) => (
                          <img key={i} src={src} alt={t('chat.imageAlt', { n: i + 1 })} className="size-12 rounded-md border border-border object-cover" />
                        ))}
                      </div>
                    )}
                    <div className="flex min-w-0 items-start gap-1.5">
                      <div className="max-h-80 min-w-0 overflow-y-auto rounded-xl rounded-br-sm border border-dashed border-border px-3.5 py-2 whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
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
        {showJumpToLatest(!awayFromBottom, v.state) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button size="sm" variant="secondary" className="pointer-events-auto shadow-sm" icon={<ArrowDown className="size-3.5" aria-hidden />} onClick={jumpToLatest} data-testid="chat-jump-latest">
              {t('chat.jumpToLatest')}
            </Button>
          </div>
        )}
      </div>
      {pending.length > 0 && (
        <section ref={pendingBox} data-testid="pending-requests" aria-label={t('chat.pendingRequests')} className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-t border-warning/30 px-6 py-3">
          <p role="status" className="text-xs font-medium text-warning" data-testid="pending-count">
            {tn('chat.pendingCount', pending.length)}
          </p>
          {pending.map((i) => (
            <div key={i.id} data-request-id={i.requestId}>
              <PermissionCard item={i} onAnswer={answer} pinned />
            </div>
          ))}
        </section>
      )}
      <div className="shrink-0 px-6 pb-4">
        <div
          className={cn('@container w-full rounded-xl border border-border bg-surface shadow-sm transition-colors focus-within:border-accent/60', open && 'cursor-text')}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onClick={focusFromBox}
          data-testid="composer"
        >
          <BackgroundTasksNotice tasks={waitingTasks(data.monitor.backgroundTasks)} now={now} />
          {idle && <IdleContextNotice idle={idle} now={now} onDismiss={() => setIdleDismissedAt(lastAt)} />}
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
                  <ImageNumber n={i + 1} />
                  <IconButton
                    size="sm"
                    label={t('chat.removeImage', { n: i + 1 })}
                    icon={<X className="size-3" />}
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 size-5 rounded-full border border-border bg-surface-raised"
                  />
                </li>
              ))}
            </ul>
          )}
          {menu.length > 0 && (
            <SlashCommandMenu sessionId={v.id} agentName={v.agentName} commands={menu} selected={menuIndex} onPick={pickCommand} onHover={setMenuSelected} />
          )}
          {mentionMenu.length > 0 && <FileMentionMenu sessionId={v.id} paths={mentionMenu} selected={mentionIndex} onPick={pickMention} onHover={setMentionSelected} />}
          <div className="relative">
            {/* The keys, where the text will go, while there is none: gone as soon as typing starts, and on a narrow pane. */}
            {text === '' && v.state === 'ready' && (
              <span className="pointer-events-none absolute top-2.5 right-3.5 hidden items-center gap-2.5 text-2xs text-subtle @md:flex" data-testid="composer-keys">
                <KeyHint keys="↵">{t('chat.keyEnter')}</KeyHint>
                <KeyHint keys="⇧↵">{t('chat.keyNewLine')}</KeyHint>
                <KeyHint keys="/">{t('chat.keyCommands')}</KeyHint>
                <KeyHint keys="@">{t('chat.keyFiles')}</KeyHint>
              </span>
            )}
            <textarea
              ref={composer}
              aria-label={t('chat.prompt')}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={menu.length > 0 || mentionMenu.length > 0}
              aria-controls={menu.length > 0 ? `slash-${v.id}` : mentionMenu.length > 0 ? `mention-${v.id}` : undefined}
              aria-activedescendant={menu.length > 0 ? slashOptionId(v.id, menuIndex) : mentionMenu.length > 0 ? mentionOptionId(v.id, mentionIndex) : undefined}
              rows={1}
              value={text}
              disabled={!open}
              placeholder={t(placeholder)}
              onChange={(e) => {
                // Editing a recalled prompt makes it the draft.
                history.current = null
                setText(e.target.value)
                setCaret(e.target.selectionStart)
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              className="block max-h-48 min-h-9 w-full resize-none overflow-y-auto bg-transparent px-3.5 pt-2.5 pb-1 text-base leading-normal text-text placeholder:text-subtle focus:outline-none disabled:opacity-60"
            />
          </div>
          {/* One bar: what the session runs with on the left, the send button on the right. */}
          <div className="flex items-center gap-1 px-2 pb-1.5">
            {acceptsImages && (
              <>
                <input ref={fileInput} type="file" accept={PROMPT_IMAGE_TYPES.join(',')} multiple hidden onChange={pickFiles} data-testid="image-picker" />
                <IconButton size="sm" className="size-6" label={t('chat.attachImages')} icon={<ImagePlus className="size-3.5" />} disabled={!open} onClick={() => fileInput.current?.click()} />
              </>
            )}
            <SessionControls view={v} reportedModel={data.monitor.model} />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {v.state === 'busy' && (
                <Button size="sm" variant="secondary" icon={<Square className="size-3" aria-hidden />} title={`${t('chat.interrupt')} · Esc`} onClick={interrupt}>
                  {t('chat.interrupt')}
                </Button>
              )}
              <IconButton
                label={t('chat.send')}
                hint={<KeyCap>↵</KeyCap>}
                icon={<ArrowUp className="size-4" />}
                disabled={!canSend}
                onClick={() => void send()}
                className="size-7 bg-accent text-accent-fg hover:bg-accent-strong hover:text-accent-fg"
              />
            </div>
          </div>
        </div>
      </div>
      {closing && <CloseSessionDialog session={data} working={isWorking(data)} onDone={() => setClosing(false)} onError={(message) => pushItem(v.id, 'error', message)} />}
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
