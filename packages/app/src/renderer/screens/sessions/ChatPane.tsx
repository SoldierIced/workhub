import { ArrowUp, Brain, ChevronRight, CircleAlert, FileText, History, Info, Pencil, Search, ShieldAlert, Square, SquareTerminal, TriangleAlert, Webhook, Wrench, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { ImageInput } from '@workhub/core'
import { Badge, Button, IconButton, Spinner } from '../../components/atoms'
import { Markdown } from '../../components/molecules'
import { BrandMark } from '../../components/organisms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { onComposerDraft, takeComposerDraft } from '../../lib/drafts'
import { imageInputFromDataUrl, MAX_PROMPT_IMAGES, readPastedImages } from '../../lib/images'
import { markPermission, pushItem, pushTurnEnd, pushUser, type ChatItem, type SessionData } from '../../store'

const TOOL_ICON: Record<string, LucideIcon> = { read: FileText, edit: Pencil, execute: SquareTerminal, search: Search, think: Brain }
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

function ChatBlock({ item, onAnswer }: { item: ChatItem; onAnswer: (requestId: string, optionId: string | null, label: string) => void }) {
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
      const Icon = TOOL_ICON[item.toolKind ?? ''] ?? Wrench
      const done = item.status === 'completed'
      const failed = item.status === 'failed'
      return (
        <div className="ml-8 flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm" title={item.detail}>
          <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{item.title}</span>
            {item.detail && item.detail !== item.title && <span className="block truncate font-mono text-2xs text-subtle">{item.detail}</span>}
          </span>
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

  const send = async () => {
    const value = text.trim()
    if ((!value && images.length === 0) || v.state !== 'ready') return
    const sent = images
    setText('')
    setImages([])
    pushUser(v.id, value, sent)
    const inputs = sent.map(imageInputFromDataUrl).filter((i): i is ImageInput => i !== null)
    try {
      pushTurnEnd(v.id, await window.hub.sessions.prompt(v.id, value, inputs.length ? inputs : undefined))
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
