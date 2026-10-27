import { ArrowLeft, Bot, Brain, ChevronRight, CircleCheck, X } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import { useEffect, useState } from 'react'
import type { ConversationEntry, SubagentConversation } from '@workhub/core'
import { Badge, Button, IconButton, Spinner, type Tone } from '../../components/atoms'
import { Markdown } from '../../components/molecules'
import { ToolCallCard } from '../../components/organisms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { formatTokens } from '../../lib/home'
import { backSubagent, closeSubagent, ENTRY_PAGE, isLive, openSubagent, shortDuration, useOpenSubagent, visibleEntries } from '../../lib/subagentView'

const POLL_MS = 2_500
/** A prompt longer than this starts folded. */
const LONG_PROMPT = 700

const STATUS_TONE: Record<string, Tone> = { running: 'info', background: 'info', completed: 'success', failed: 'danger', stopped: 'neutral' }

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; conversation: SubagentConversation }

function useConversation(sessionId: string, subagentId: string): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoad({ state: 'loading' })
    const read = async () => {
      const conversation = await window.hub.sessions.subagent(sessionId, subagentId).catch(() => null)
      if (!alive) return
      setLoad(conversation ? { state: 'ready', conversation } : { state: 'missing' })
      // A running sub-agent keeps writing: read again; a finished one is read once.
      if (conversation && isLive(conversation.status)) timer = setTimeout(() => void read(), POLL_MS)
    }
    void read()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [sessionId, subagentId])
  return load
}

function Prompt({ text }: { text: string }) {
  const { t } = useI18n()
  const long = text.length > LONG_PROMPT
  const [open, setOpen] = useState(!long)
  return (
    <section className="rounded-lg border border-border bg-surface px-4 py-3" aria-label={t('subagent.prompt')}>
      <div className="mb-1.5 text-chat-xs font-semibold tracking-wide text-subtle uppercase">{t('subagent.prompt')}</div>
      <div className={open ? '' : 'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]'}>
        <Markdown text={text} className="text-chat-sm leading-relaxed" />
      </div>
      {long && (
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => setOpen((v) => !v)}>
          {open ? t('tool.showLess') : t('tool.showMore')}
        </Button>
      )}
    </section>
  )
}

function Thinking({ text, durationMs }: { text: string; durationMs?: number }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const label = durationMs !== undefined ? t('subagent.thoughtFor', { duration: shortDuration(durationMs) }) : t('subagent.thought')
  if (!text.trim()) {
    return (
      <div className="ml-8 flex items-center gap-1.5 text-chat-sm text-subtle">
        <Brain className="size-3.5" aria-hidden />
        {label}
      </div>
    )
  }
  return (
    <div className="ml-8 text-chat-sm text-muted">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 hover:text-text">
        <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        <Brain className="size-3.5" aria-hidden />
        {label}
      </button>
      {open && <div className="mt-1.5 border-l-2 border-border pl-3 whitespace-pre-wrap italic">{text}</div>}
    </div>
  )
}

function Entry({ entry, sessionId, cwd }: { entry: ConversationEntry; sessionId: string; cwd?: string }) {
  const { t } = useI18n()
  switch (entry.kind) {
    case 'text':
      return (
        <div className="flex gap-3">
          <Bot className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
          <Markdown text={entry.text} className="min-w-0 flex-1 leading-relaxed" />
        </div>
      )
    case 'thinking':
      return <Thinking text={entry.text} durationMs={entry.durationMs} />
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1">
          <span className="text-chat-2xs text-subtle">{t('subagent.toParent')}</span>
          <div className="max-w-[80%] rounded-xl rounded-br-sm bg-accent-soft px-3.5 py-2 text-chat-sm whitespace-pre-wrap text-text">{entry.text}</div>
        </div>
      )
    case 'tool': {
      const agentId = entry.result?.agentId
      return (
        <ToolCallCard
          title={entry.title}
          detail={entry.detail}
          status={entry.status}
          view={entry.view}
          result={entry.result}
          cwd={cwd}
          onReveal={(path) => void window.hub.sessions.revealFile(sessionId, path)}
          onOpenAgent={agentId ? () => openSubagent(sessionId, agentId, true) : undefined}
        />
      )
    }
  }
}

function Body({ sessionId, subagentId, depth }: { sessionId: string; subagentId: string; depth: number }) {
  const { t, tn, formatNumber } = useI18n()
  const load = useConversation(sessionId, subagentId)
  const [shown, setShown] = useState(ENTRY_PAGE)
  const c = load.state === 'ready' ? load.conversation : undefined
  const name = c?.description ?? c?.type ?? subagentId
  const status = c?.status
  const toolSteps = c?.entries.filter((e) => e.kind === 'tool').length ?? 0
  const { hidden, list } = visibleEntries(c?.entries ?? [], shown)
  return (
    <>
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        {depth > 1 && <IconButton label={t('subagent.back')} icon={<ArrowLeft className="size-4" />} onClick={backSubagent} />}
        <Bot className="mt-1 size-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <RDialog.Title className="truncate text-lg font-semibold">{name}</RDialog.Title>
            {c?.type && <Badge tone="accent">{c.type}</Badge>}
            {status && (
              <Badge tone={STATUS_TONE[status] ?? 'neutral'} icon={isLive(status) ? <Spinner className="size-3 text-info" /> : undefined}>
                {t(`subagent.status.${status}` as MessageKey)}
              </Badge>
            )}
          </div>
          <RDialog.Description className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
            {c?.startedAt !== undefined && c.lastActivityAt !== undefined && (
              <span>
                {t('subagent.duration')}: {shortDuration(c.lastActivityAt - c.startedAt)}
              </span>
            )}
            {c?.tokens?.total !== undefined && (
              <span title={formatNumber(c.tokens.total)}>
                {t('subagent.tokens')}: {formatTokens(c.tokens.total)}
              </span>
            )}
            {c?.model && (
              <span>
                {t('subagent.model')}: {c.model}
              </span>
            )}
            {c && <span>{tn('subagent.steps', toolSteps)}</span>}
            {!c && <span>{t('subagent.label')}</span>}
          </RDialog.Description>
        </div>
        <RDialog.Close asChild>
          <IconButton label={t('common.close')} icon={<X className="size-4" />} />
        </RDialog.Close>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto text-chat" role="log" aria-label={t('subagent.label')}>
        <div className="mx-auto flex max-w-3xl flex-col gap-3.5 px-6 py-5">
          {load.state === 'loading' && (
            <p className="flex items-center gap-2 py-10 text-chat-sm text-subtle">
              <Spinner className="size-4" /> {t('subagent.loading')}
            </p>
          )}
          {load.state === 'missing' && <p className="py-10 text-center text-chat-sm text-subtle">{t('subagent.missing')}</p>}
          {c?.prompt && <Prompt text={c.prompt} />}
          {c?.omitted ? <p className="text-center text-chat-xs text-subtle">{tn('subagent.omitted', c.omitted)}</p> : null}
          {hidden > 0 && (
            <Button size="sm" variant="ghost" className="self-center" onClick={() => setShown((n) => n + ENTRY_PAGE)}>
              {tn('subagent.showEarlier', Math.min(hidden, ENTRY_PAGE))}
            </Button>
          )}
          {list.map((e) => (
            <Entry key={e.id} entry={e} sessionId={sessionId} cwd={c?.cwd} />
          ))}
          {c && !c.entries.length && !c.result && <p className="text-center text-chat-sm text-subtle">{t('subagent.empty')}</p>}
          {c?.result && (
            <section className="rounded-lg border border-success/40 bg-success-soft/40 px-4 py-3" aria-label={t('subagent.result')}>
              <div className="mb-1.5 flex items-center gap-1.5 text-chat-xs font-semibold tracking-wide text-success uppercase">
                <CircleCheck className="size-3.5" aria-hidden />
                {t('subagent.result')}
              </div>
              <Markdown text={c.result} className="text-chat-sm leading-relaxed" />
            </section>
          )}
        </div>
      </div>
    </>
  )
}

/** The open sub-agent of this session, as a wide sheet over the session screen. */
/**
 * The open sub-agent's conversation, of whichever session: mounted once (App), so a sub-agent
 * opened from the sidebar or the Monitor shows whether or not that session's Monitor is up.
 */
export function SubagentSheet() {
  const open = useOpenSubagent()
  const sessionId = open?.sessionId ?? ''
  const current = open ? open.stack[open.stack.length - 1] : undefined
  return (
    <RDialog.Root open={current !== undefined} onOpenChange={(o) => !o && closeSubagent()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/40" />
        <RDialog.Content
          className="fixed inset-y-0 right-0 z-50 flex w-[min(920px,calc(100vw-80px))] flex-col border-l border-border bg-bg shadow-lg focus-visible:outline-none"
          data-testid="subagent-view"
          // Focus the sheet itself, not its first button: a focused close button shows its tooltip.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement | null)?.focus()
          }}
          tabIndex={-1}
        >
          {current && <Body key={`${current}:${open!.stack.length}`} sessionId={sessionId} subagentId={current} depth={open!.stack.length} />}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
