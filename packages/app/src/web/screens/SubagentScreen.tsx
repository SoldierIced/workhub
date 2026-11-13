import { Bot, Brain, Check, CircleCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ConversationEntry, SubagentConversation } from '@workhub/core'
import { Spinner } from '../../renderer/components/atoms'
import { Markdown } from '../../renderer/components/molecules/Markdown'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import type { MessageKey } from '../../renderer/i18n/translate'
import { isLive } from '../../renderer/lib/subagentView'
import { useSessions } from '../../renderer/store'
import { navigate } from '../app-context'
import { Body, Header, Screen } from '../ui'
import { FileChip } from './SessionScreen'

/** A running sub-agent keeps writing: read again this often while it runs. */
const POLL_MS = 3_000

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; conversation: SubagentConversation }

function useConversation(sessionId: string, id: string): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      const conversation = await window.hub.sessions.subagent(sessionId, id).catch(() => null)
      if (!alive) return
      // A failed read while one is shown keeps it (the link dropped); only a first one says missing.
      setLoad((prev) => (conversation ? { state: 'ready', conversation } : prev.state === 'ready' ? prev : { state: 'missing' }))
      if (!conversation || isLive(conversation.status)) timer = setTimeout(() => void read(), POLL_MS)
    }
    void read()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [sessionId, id])
  return load
}

function Step({ entry, sessionId }: { entry: ConversationEntry; sessionId: string }) {
  const { t } = useI18n()
  switch (entry.kind) {
    case 'text':
      return (
        <div className="max-w-[94%] rounded-2xl rounded-tl-sm border border-border bg-surface px-3.5 py-2.5 text-chat">
          <Markdown text={entry.text} />
        </div>
      )
    case 'thinking':
      return entry.text.trim() ? (
        <div className="flex max-w-[94%] gap-1.5 px-1 text-chat-xs text-subtle italic">
          <Brain className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="line-clamp-3">{entry.text}</span>
        </div>
      ) : null
    case 'user':
      return (
        <div className="ml-auto max-w-[85%]">
          <div className="mb-0.5 text-right text-2xs text-subtle">{t('subagent.toParent')}</div>
          <div className="rounded-2xl rounded-br-sm bg-accent-soft px-3.5 py-2.5 text-chat-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.text}</div>
        </div>
      )
    case 'tool': {
      const running = entry.status === 'in_progress'
      const path = entry.view.kind === 'read' || entry.view.kind === 'write' || entry.view.kind === 'edit' ? entry.view.path : null
      const nested = entry.result?.agentId
      return (
        <div className="max-w-[94%] text-chat-xs text-muted">
          <div className="flex items-start gap-2">
            {running ? (
              <Spinner className="mt-0.5 size-3.5" />
            ) : entry.status === 'failed' ? (
              <X className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
            ) : (
              <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
            )}
            <span className="min-w-0 [overflow-wrap:anywhere]">{entry.title}</span>
          </div>
          {path && <FileChip sessionId={sessionId} path={path} />}
          {nested && <SubagentLink sessionId={sessionId} id={nested} />}
        </div>
      )
    }
  }
}

/** Opens a sub-agent's conversation: under a Task call in the chat, or one sub-agent started by another. */
export function SubagentLink({ sessionId, id }: { sessionId: string; id: string }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={() => navigate({ screen: 'subagent', sessionId, id })}
      className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs font-medium text-accent active:bg-surface-hover"
    >
      <Bot className="size-3.5" aria-hidden />
      {t('web.session.openSubagent')}
    </button>
  )
}

/** A sub-agent's conversation, read from the desktop: what it was asked, its steps and its answer. */
export function SubagentScreen({ sessionId, id }: { sessionId: string; id: string }) {
  const { t, tn } = useI18n()
  const session = useSessions()[sessionId]
  const load = useConversation(sessionId, id)
  const c = load.state === 'ready' ? load.conversation : undefined
  const summary = session?.monitor.subagents?.find((s) => s.id === id)
  const name = c?.description ?? c?.type ?? summary?.description ?? summary?.type ?? t('web.subagent.title')
  const status = c?.status ?? summary?.status
  return (
    <Screen>
      <Header
        title={name}
        subtitle={
          <span className="flex items-center gap-1.5">
            {status && isLive(status) && <Spinner className="size-3" />}
            {[c?.type, status ? t(`subagent.status.${status}` as MessageKey) : null].filter(Boolean).join(' · ')}
          </span>
        }
        back={{ screen: 'session', id: sessionId }}
      />
      <Body className="flex flex-col gap-3 px-4 py-4">
        {load.state === 'loading' && (
          <p className="flex items-center justify-center gap-2 py-10 text-sm text-subtle">
            <Spinner className="size-4" /> {t('subagent.loading')}
          </p>
        )}
        {load.state === 'missing' && <p className="py-10 text-center text-sm text-subtle">{t('subagent.missing')}</p>}
        {c?.prompt && (
          <section className="rounded-2xl border border-border bg-surface px-3.5 py-2.5">
            <div className="mb-1 text-2xs font-semibold tracking-wide text-subtle uppercase">{t('subagent.prompt')}</div>
            <div className="max-h-64 overflow-y-auto text-chat-sm">
              <Markdown text={c.prompt} />
            </div>
          </section>
        )}
        {c?.omitted ? <p className="text-center text-2xs text-subtle">{tn('subagent.omitted', c.omitted)}</p> : null}
        {c?.entries.map((e) => (
          <Step key={e.id} entry={e} sessionId={sessionId} />
        ))}
        {c && !c.entries.length && !c.result && <p className="text-center text-sm text-subtle">{t('subagent.empty')}</p>}
        {c?.result && (
          <section className="rounded-2xl border border-success/40 bg-success-soft/40 px-3.5 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-success uppercase">
              <CircleCheck className="size-3.5" aria-hidden />
              {t('subagent.result')}
            </div>
            <div className="text-chat-sm">
              <Markdown text={c.result} />
            </div>
          </section>
        )}
      </Body>
    </Screen>
  )
}
