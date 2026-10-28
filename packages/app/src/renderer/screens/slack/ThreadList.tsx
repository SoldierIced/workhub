import { Archive, BellRing, ChevronRight, Clock, ExternalLink, GitPullRequest, Hash, MessageSquareReply, RotateCcw, SquareArrowOutUpRight, Ticket, Trash2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { archivedThreadIds, hasUnread, plainText, threadActivity, type TrackedThread } from '@workhub/core'
import { Avatar, Badge, Button, IconButton, Switch } from '../../components/atoms'
import { ConfirmDeleteDialog } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { relativeTime } from '../../lib/pullRequests'
import { useAsyncAction } from '../../lib/useAsyncAction'

export interface ThreadActions {
  onOpenSession?: (thread: TrackedThread) => void
  /** Hides the per-thread controls (the session monitor shows a compact list). */
  compact?: boolean
  /** Channel id -> name, for "#channel" (the threads only store ids). */
  channelName?: (id: string) => string
}

/** "github.com/acme/web/pull/12" -> "web#12". */
export function shortPr(url: string): string {
  const m = url.match(/\/([^/]+)\/(?:pull|merge_requests|-\/merge_requests)\/(\d+)/)
  return m ? `${m[1]}#${m[2]}` : url.replace(/^https?:\/\/(www\.)?/, '')
}

/** Active threads first; the archived ones (quiet past the profile's threshold) fold into "Archived (n)". */
export function ThreadGroup({ threads, me, archiveMinutes, now, actions }: { threads: TrackedThread[]; me: string; archiveMinutes: number; now: number; actions: ThreadActions }) {
  const { t } = useI18n()
  const archived = archivedThreadIds(threads, now, archiveMinutes)
  const byActivity = [...threads].sort((a, b) => threadActivity(b) - threadActivity(a))
  const active = byActivity.filter((th) => !archived.has(th.id))
  const folded = byActivity.filter((th) => archived.has(th.id))
  const Item = actions.compact ? CompactThread : ThreadCard
  return (
    <div className="flex flex-col gap-2">
      {active.length > 0 && (
        <ul className={cn('flex flex-col', actions.compact ? 'gap-1' : 'gap-2')}>
          {active.map((th) => (
            <Item key={th.id} thread={th} me={me} now={now} actions={actions} />
          ))}
        </ul>
      )}
      {folded.length > 0 && (
        <details className="group" data-testid="archived-threads">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted select-none hover:bg-surface-hover hover:text-text">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            <Archive className="size-3.5" aria-hidden />
            {t('slack.archived', { count: folded.length })}
          </summary>
          <ul className={cn('mt-1.5 flex flex-col opacity-75', actions.compact ? 'gap-1' : 'gap-2')}>
            {folded.map((th) => (
              <Item key={th.id} thread={th} me={me} now={now} actions={actions} />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** The state chips of a thread: new replies, auto-followed, waiting for the session, not followed. */
function ThreadBadges({ thread: th, me }: { thread: TrackedThread; me: string }) {
  const { t } = useI18n()
  return (
    <>
      {hasUnread(th, me) && <Badge tone="accent">{t('slack.unread')}</Badge>}
      {th.source === 'hook' && (
        <Badge tone="info" title={t('slack.autoHint')}>
          {t('slack.auto')}
        </Badge>
      )}
      {th.pendingWake.length > 0 && (
        <Badge tone="warning" icon={<Clock className="size-3" aria-hidden />}>
          {t('slack.pendingWake', { count: th.pendingWake.length })}
        </Badge>
      )}
      {th.closed && <Badge>{th.closedReason ? t(`slack.closedReason.${th.closedReason}`) : t('slack.closed')}</Badge>}
    </>
  )
}

/** A followed thread on the Slack screen: where it is, what it links to, its latest replies and its switches. */
function ThreadCard({ thread: th, me, now, actions }: { thread: TrackedThread; me: string; now: number; actions: ThreadActions }) {
  const { t, tn, locale } = useI18n()
  const channel = actions.channelName?.(th.channelId) ?? th.channelId
  const shown = th.replies.slice(-3)
  const lastWake = th.wakeLog[0]
  const wake = useAsyncAction((on: boolean) => window.hub.slack.setWake(th.id, on))
  const send = useAsyncAction(() => window.hub.slack.sendToSession(th.id))
  const follow = useAsyncAction(() => window.hub.slack.setClosed(th.id, !th.closed))
  const remove = useAsyncAction(() => window.hub.slack.remove(th.id))
  const [confirming, setConfirming] = useState(false)
  return (
    <li className={cn('rounded-lg border border-border bg-surface p-3.5 shadow-sm transition-colors', th.closed && 'opacity-70')} data-testid="thread-card">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="line-clamp-2 min-w-0 text-base font-semibold break-words" title={plainText(th.title || th.permalink)}>
              {plainText(th.title) || th.permalink}
            </h4>
            <ThreadBadges thread={th} me={me} />
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-subtle">
            <span className="inline-flex items-center gap-0.5 font-medium text-muted">
              <Hash className="size-3" aria-hidden />
              {channel}
            </span>
            <span aria-hidden>·</span>
            <span>{t('slack.started', { time: relativeTime(th.createdAt, now, locale) })}</span>
            <span aria-hidden>·</span>
            <span>{th.replies.length ? tn('slack.replyCount', th.replies.length) : t('slack.noReplies')}</span>
          </p>
        </div>
        <IconButton size="sm" label={t('slack.openInSlack')} icon={<ExternalLink className="size-3.5" />} onClick={() => window.hub.openExternal(th.permalink)} />
      </div>

      {(th.prUrl || th.ticketKey) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {th.prUrl && <LinkChip icon={<GitPullRequest className="size-3" aria-hidden />} label={shortPr(th.prUrl)} title={th.prUrl} onClick={() => window.hub.openExternal(th.prUrl!)} />}
          {th.ticketKey && <LinkChip icon={<Ticket className="size-3" aria-hidden />} label={th.ticketKey} />}
        </div>
      )}

      {shown.length > 0 && (
        <ol className="mt-2.5 flex flex-col gap-2 border-l-2 border-border pl-3" aria-label={t('slack.latestReplies')}>
          {th.replies.length > shown.length && <li className="text-xs text-subtle">{tn('slack.earlierReplies', th.replies.length - shown.length)}</li>}
          {shown.map((r) => (
            <li key={r.ts} className="flex gap-2">
              <Avatar name={r.user} size="sm" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-xs">
                  <span className="font-semibold text-text">{r.user}</span>
                  <span className="ml-1.5 text-subtle">{relativeTime(Number(r.ts) * 1000, now, locale)}</span>
                </p>
                <p className="line-clamp-4 text-base break-words whitespace-pre-wrap text-text">{plainText(r.text)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {lastWake && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-subtle">
          <BellRing className="size-3" aria-hidden />
          <span className="truncate" title={lastWake.detail}>
            {t(`slack.wakeOutcome.${lastWake.outcome}`)} · {relativeTime(lastWake.at, now, locale)}
            {lastWake.detail ? ` · ${lastWake.detail}` : ''}
          </span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5">
        {th.owner ? (
          <label className="mr-auto flex items-center gap-2 text-sm text-muted">
            <Switch checked={th.wake} disabled={wake.pending} onChange={wake.run} aria-label={t('slack.wake')} />
            {t('slack.wake')}
          </label>
        ) : (
          <span className="mr-auto" />
        )}
        {th.owner && actions.onOpenSession && (
          <Button size="sm" variant="ghost" icon={<SquareArrowOutUpRight className="size-3.5" aria-hidden />} onClick={() => actions.onOpenSession?.(th)}>
            {t('slack.openSessionShort')}
          </Button>
        )}
        {th.owner && !th.closed && th.replies.length > 0 && (
          <IconButton size="sm" label={t('slack.sendToSession')} icon={<MessageSquareReply className="size-3.5" />} disabled={send.pending} onClick={() => send.run()} />
        )}
        <IconButton
          size="sm"
          label={th.closed ? t('slack.reopen') : t('slack.stopFollowing')}
          icon={th.closed ? <RotateCcw className="size-3.5" /> : <X className="size-3.5" />}
          disabled={follow.pending}
          onClick={() => follow.run()}
        />
        <IconButton size="sm" label={t('common.delete')} icon={<Trash2 className="size-3.5" />} disabled={remove.pending} onClick={() => setConfirming(true)} />
      </div>
      <ConfirmDeleteDialog name={plainText(th.title) || th.permalink} open={confirming} onOpenChange={setConfirming} onConfirm={() => remove.run()} />
    </li>
  )
}

/** One row of the session monitor's list: who replied last, what they said, when. */
function CompactThread({ thread: th, me, now, actions }: { thread: TrackedThread; me: string; now: number; actions: ThreadActions }) {
  const { t, locale } = useI18n()
  const last = th.replies.at(-1)
  return (
    <li className={cn('group/row rounded-md px-2 py-1.5 hover:bg-surface-hover', th.closed && 'opacity-60')} data-testid="thread-row">
      <div className="flex items-center gap-1.5">
        <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline" title={plainText(th.title || th.permalink)} onClick={() => window.hub.openExternal(th.permalink)}>
          {plainText(th.title) || th.permalink}
        </button>
        <span className="shrink-0 text-2xs text-subtle tabular-nums">{relativeTime(threadActivity(th), now, locale)}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
        {last ? (
          <>
            <Avatar name={last.user} size="sm" className="size-4 text-[8px]" />
            <span className="min-w-0 flex-1 truncate text-xs text-muted" title={plainText(last.text)}>
              <span className="font-medium text-text">{last.user}</span> {plainText(last.text)}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-subtle">
            #{actions.channelName?.(th.channelId) ?? th.channelId} · {t('slack.noReplies')}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-1 empty:hidden">
        <ThreadBadges thread={th} me={me} />
      </div>
    </li>
  )
}

function LinkChip({ icon, label, title, onClick }: { icon: ReactNode; label: string; title?: string; onClick?: () => void }) {
  const cls = 'inline-flex h-5 items-center gap-1 rounded-md bg-accent-soft px-1.5 text-xs font-medium text-accent'
  return onClick ? (
    <button type="button" className={cn(cls, 'hover:underline')} title={title} onClick={onClick}>
      {icon}
      {label}
    </button>
  ) : (
    <span className={cls} title={title}>
      {icon}
      {label}
    </span>
  )
}

export { LinkChip }
