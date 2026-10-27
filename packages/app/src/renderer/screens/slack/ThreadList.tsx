import { Archive, ChevronRight, ExternalLink, MessageSquareReply, RotateCcw, SquareArrowOutUpRight, Trash2, X } from 'lucide-react'
import { archivedThreadIds, hasUnread, threadActivity, type TrackedThread } from '@workhub/core'
import { Badge, IconButton, Switch } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { relativeTime } from '../../lib/pullRequests'

export interface ThreadActions {
  onOpenSession?: (thread: TrackedThread) => void
  /** Hides the per-thread controls (the session monitor shows a compact list). */
  compact?: boolean
}

/** Active threads first; the archived ones (quiet past the profile's threshold) fold into "Archived (n)". */
export function ThreadGroup({ threads, me, archiveMinutes, now, actions }: { threads: TrackedThread[]; me: string; archiveMinutes: number; now: number; actions: ThreadActions }) {
  const { t } = useI18n()
  const archived = archivedThreadIds(threads, now, archiveMinutes)
  const byActivity = [...threads].sort((a, b) => threadActivity(b) - threadActivity(a))
  const active = byActivity.filter((th) => !archived.has(th.id))
  const folded = byActivity.filter((th) => archived.has(th.id))
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">
        {active.map((th) => (
          <ThreadRow key={th.id} thread={th} me={me} now={now} actions={actions} />
        ))}
      </ul>
      {folded.length > 0 && (
        <details className="group opacity-60 hover:opacity-100" data-testid="archived-threads">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-sm text-muted select-none hover:text-text">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            <Archive className="size-3.5" aria-hidden />
            {t('slack.archived', { count: folded.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {folded.map((th) => (
              <ThreadRow key={th.id} thread={th} me={me} now={now} actions={actions} />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function ThreadRow({ thread: th, me, now, actions }: { thread: TrackedThread; me: string; now: number; actions: ThreadActions }) {
  const { t, locale } = useI18n()
  const unread = hasUnread(th, me)
  const last = th.replies.at(-1)
  return (
    <li className={cn('rounded-md border border-border bg-surface px-3 py-2', th.closed && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-base font-medium" title={th.title}>
          {th.title || th.permalink}
        </span>
        {unread && <Badge tone="accent">{t('slack.unread')}</Badge>}
        {th.closed && <Badge>{th.closedReason ? t(`slack.closedReason.${th.closedReason}`) : t('slack.closed')}</Badge>}
        {th.pendingWake.length > 0 && <Badge tone="warning">{t('slack.pendingWake', { count: th.pendingWake.length })}</Badge>}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-subtle">
        <span className="truncate">{last ? `${last.user}: ${last.text}` : t('slack.noReplies')}</span>
        <span className="ml-auto shrink-0">{relativeTime(threadActivity(th), now, locale)}</span>
      </div>
      {!actions.compact && (
        <div className="mt-1.5 flex items-center gap-1">
          {th.owner && (
            <label className="mr-1 flex items-center gap-1.5 text-xs text-muted">
              <Switch checked={th.wake} onChange={(v) => void window.hub.slack.setWake(th.id, v)} aria-label={t('slack.wake')} />
              {t('slack.wake')}
            </label>
          )}
          {th.owner && actions.onOpenSession && (
            <IconButton size="sm" label={t('slack.openSession')} icon={<SquareArrowOutUpRight className="size-3.5" />} onClick={() => actions.onOpenSession?.(th)} />
          )}
          {th.owner && !th.closed && (
            <IconButton size="sm" label={t('slack.sendToSession')} icon={<MessageSquareReply className="size-3.5" />} onClick={() => void window.hub.slack.sendToSession(th.id)} />
          )}
          <IconButton size="sm" label={t('slack.openInSlack')} icon={<ExternalLink className="size-3.5" />} onClick={() => window.hub.openExternal(th.permalink)} />
          <IconButton
            size="sm"
            label={th.closed ? t('slack.reopen') : t('slack.stopFollowing')}
            icon={th.closed ? <RotateCcw className="size-3.5" /> : <X className="size-3.5" />}
            onClick={() => void window.hub.slack.setClosed(th.id, !th.closed)}
          />
          <IconButton size="sm" label={t('common.delete')} icon={<Trash2 className="size-3.5" />} onClick={() => void window.hub.slack.remove(th.id)} />
        </div>
      )}
    </li>
  )
}
