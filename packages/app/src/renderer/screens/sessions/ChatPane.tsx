import { ArrowRightLeft, ArrowUp, Brain, ChevronRight, CircleAlert, History, Info, ShieldAlert, Square, TriangleAlert, Webhook, X, type LucideIcon } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { gatePrompt, setCeiling, type ImageInput, type SubagentSummary } from '@workhub/core'
import { Button, IconButton } from '../../components/atoms'
import { Markdown } from '../../components/molecules'
import { BrandMark, ToolCallCard } from '../../components/organisms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { onComposerDraft, takeComposerDraft } from '../../lib/drafts'
import { imageInputFromDataUrl, MAX_PROMPT_IMAGES, readPastedImages } from '../../lib/images'
import { markPermission, pushItem, pushTurnEnd, pushUser, type ChatItem, type SessionData } from '../../store'
import { refreshConfig } from '../../configStore'
import { sessionBudget } from '../../lib/agent-usage'
import { useAccountLabel, useAccountUsage, useNow, useUsageSettings } from '../../lib/usage'
import { BudgetNotice } from './BudgetNotice'
import type { ContinuityOptions } from '@shared/continuity-api'
import { dismissOffer, originText, useContinuityActions, useContinuityOffer } from '../../lib/continuity'
import { ContinuityNotice } from './ContinuityNotice'
import { openSubagent, subagentOfCall } from '../../lib/subagentView'
import { errorText } from '../../lib/errorText'

const NOTICE_ICON: Record<'hook' | 'info' | 'warning', LucideIcon> = { hook: Webhook, info: Info, warning: TriangleAlert }

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

function ChatBlock({ item, onAnswer, sessionId, cwd, subagents }: ChatBlockProps) {
  const { t, tn } = useI18n()
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1.5">
          {Array.isArray(item.images) && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {item.images.map((src, i) => (
                <img key={i} src={src} alt={t('chat.imageAlt', { n: i + 1 })} className="size-16 rounded-md border border-border object-cover" />
              ))}
            </div>
          )}
          {typeof item.images === 'number' && <span className="text-xs text-subtle">{tn('chat.images', item.images)}</span>}
          {item.text && <div className="max-w-[80%] rounded-xl rounded-br-sm bg-accent-soft px-3.5 py-2 whitespace-pre-wrap text-text">{item.text}</div>}
        </div>
      )
    case 'agent':
      return (
        <div className="flex gap-3" data-testid="agent-message">
          <BrandMark className="mt-0.5 size-5 shrink-0" />
          <Markdown text={item.text} className="flex-1 leading-relaxed" />
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
          <pre className="font-mono text-xs whitespace-pre-wrap">{item.text || t('chat.noticeEmpty')}</pre>
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
        <div role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="whitespace-pre-wrap">{item.text}</span>
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

/** The structured chat of a session: Markdown replies, tools, permissions, hook notices, pasted images. */
export function ChatPane({ data }: { data: SessionData }) {
  const { t } = useI18n()
  const v = data.view
  const [text, setText] = useState(() => takeComposerDraft(v.id) ?? '')
  const [images, setImages] = useState<string[]>([])
  const bottom = useRef<HTMLDivElement>(null)
  // A draft written for this session after its chat mounted (Investigate with Claude).
  useEffect(
    () =>
      onComposerDraft((id) => {
        const draft = id === v.id ? takeComposerDraft(id) : undefined
        if (draft !== undefined) setText(draft)
      }),
    [v.id]
  )
  useEffect(() => {
    // Braces matter: scrollIntoView returns a Promise in recent Chromium, which React would take as a cleanup.
    void bottom.current?.scrollIntoView({ block: 'end' })
  }, [data.items])

  const acceptsImages = v.capabilities.imageInput

  // Usage budget of the session's account (Settings → Usage): past a ceiling, a prompt needs "Send anyway".
  const reads = useAccountUsage()
  const usageSettings = useUsageSettings()
  const now = useNow()
  const accountLabel = useAccountLabel()
  const gate = sessionBudget(v, reads, usageSettings.budget, usageSettings.accountsOf, now)
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
    const r = await window.hub.config.saveOptions({ usageBudget: setCeiling(usageSettings.budget, gate.key, gate.status.window, null) })
    if (r.ok) await refreshConfig()
  }

  const send = async (override = false) => {
    const value = text.trim()
    if ((!value && images.length === 0) || v.state !== 'ready') return
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
    const sent = images
    setText('')
    setImages([])
    pushUser(v.id, value, sent)
    const inputs = sent.map(imageInputFromDataUrl).filter((i): i is ImageInput => i !== null)
    try {
      pushTurnEnd(v.id, await window.hub.sessions.prompt(v.id, value, inputs.length ? inputs : undefined))
    } catch (e) {
      pushItem(v.id, 'error', errorText(e))
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

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!acceptsImages) return
    const hasImage = [...e.clipboardData.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'))
    if (!hasImage) return
    e.preventDefault()
    void readPastedImages(e.clipboardData.items).then((urls) => {
      const usable = urls.filter((u) => imageInputFromDataUrl(u) !== null)
      if (usable.length < urls.length) pushItem(v.id, 'error', t('chat.imageRejected'))
      setImages((prev) => [...prev, ...usable].slice(0, MAX_PROMPT_IMAGES))
    })
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
    v.state === 'starting' ? 'chat.placeholderStarting' : v.state === 'ready' ? 'chat.placeholder' : v.state === 'busy' ? 'chat.placeholderBusy' : 'chat.placeholderClosed'

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto text-[length:var(--wh-chat-font-size,13px)]" aria-live="polite" aria-label={t('chat.log')} role="log">
        <div className="mx-auto flex max-w-3xl flex-col gap-3.5 px-6 py-5">
          {data.items.length === 0 && !v.origin && <p className="py-10 text-center text-sm text-subtle">{t('chat.empty')}</p>}
          {replayAt < 0 && originLine}
          {data.items.map((i, n) => (
            <Fragment key={i.id}>
              <ChatBlock item={i} onAnswer={answer} sessionId={v.id} cwd={v.cwd} subagents={data.monitor.subagents} />
              {n === replayAt && originLine}
            </Fragment>
          ))}
          <div ref={bottom} />
        </div>
      </div>
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto max-w-3xl rounded-xl border border-border bg-surface shadow-md transition-colors focus-within:border-accent/60">
          <BudgetNotice
            status={gate.status}
            account={accountLabel(usageSettings.accountsOf(v.agentId), reads.find((r) => r.key === gate.key)?.name ?? v.accountName ?? '')}
            now={now}
            needsConfirm={needsConfirm}
            canSend={v.state === 'ready' && (text.trim().length > 0 || images.length > 0)}
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
            aria-label={t('chat.prompt')}
            rows={2}
            value={text}
            disabled={v.state !== 'ready'}
            placeholder={t(placeholder)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="block max-h-48 min-h-14 w-full resize-none bg-transparent px-4 pt-3 text-base text-text placeholder:text-subtle focus:outline-none disabled:opacity-60"
          />
          <div className="flex items-center gap-2 px-3 pb-2.5">
            <span className="text-xs text-subtle">{acceptsImages ? t('chat.keysImages') : t('chat.keys')}</span>
            <div className="ml-auto flex items-center gap-1.5">
              {v.state === 'busy' && (
                <Button size="sm" variant="secondary" icon={<Square className="size-3" aria-hidden />} onClick={() => void window.hub.sessions.cancel(v.id)}>
                  {t('chat.interrupt')}
                </Button>
              )}
              <IconButton
                label={t('chat.send')}
                icon={<ArrowUp className="size-4" />}
                disabled={v.state !== 'ready' || (!text.trim() && images.length === 0)}
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
