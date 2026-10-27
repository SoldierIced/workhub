import { Hash, MessagesSquare, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { hasUnread, plainText, threadArchiveMinutes } from '@workhub/core'
import { Avatar, Button } from '../../components/atoms'
import { EmptyState } from '../../components/molecules'
import { useSlack } from '../../chatStore'
import { useI18n } from '../../i18n/I18nProvider'
import { relativeTime } from '../../lib/pullRequests'
import type { SlackLinks } from '../../lib/slackLinks'
import { ThreadGroup } from '../slack/ThreadList'
import { TrackThreadDialog } from '../slack/TrackThreadDialog'

/**
 * The PR window's Slack tab (Workhub 1's): the threads followed for this PR, then the channel
 * messages that link it, and "Track a Slack link" with the PR (and its ticket) filled in.
 * What is on screen counts as read.
 */
export function PrSlackTab({ url, ticketKey, links }: { url: string; ticketKey?: string; links: SlackLinks }) {
  const { t, locale } = useI18n()
  const snap = useSlack()
  const [tracking, setTracking] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const unreadIds = useMemo(() => links.threads.filter((th) => hasUnread(th, links.me)).map((th) => th.id), [links])
  useEffect(() => {
    if (unreadIds.length) void window.hub.slack.markViewed(unreadIds)
  }, [unreadIds])
  const channelName = (id: string) => snap?.settings.channels.find((c) => c.id === id)?.name || id
  const empty = links.threads.length === 0 && links.messages.length === 0
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <p className="mr-auto text-sm text-muted">{t('pr.slack.empty.hint')}</p>
        <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setTracking(true)}>
          {t('pr.slack.track')}
        </Button>
      </div>
      {empty && <EmptyState compact icon={<MessagesSquare className="size-5" aria-hidden />} title={t('pr.slack.empty.title')} />}
      {links.threads.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-muted">{t('pr.slack.threads')}</h3>
          <ThreadGroup threads={links.threads} me={links.me} archiveMinutes={threadArchiveMinutes(undefined)} now={now} actions={{ channelName }} />
        </section>
      )}
      {links.messages.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-muted">{t('pr.slack.messages')}</h3>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
            {links.messages.map((m) => (
              <li key={`${m.channelId}:${m.ts}`} className="flex gap-3 px-4 py-3" data-testid="pr-slack-message">
                <Avatar name={m.user} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 text-sm">
                    <span className="font-semibold">{m.user}</span>
                    <span className="inline-flex items-center gap-0.5 text-xs text-muted">
                      <Hash className="size-3" aria-hidden />
                      {channelName(m.channelId)}
                    </span>
                    <span className="text-xs text-subtle">{relativeTime(Number(m.ts) * 1000, now, locale)}</span>
                    {m.permalink && (
                      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => window.hub.openExternal(m.permalink!)}>
                        {t('slack.openInSlack')}
                      </Button>
                    )}
                  </div>
                  <p className="mt-0.5 text-base break-words whitespace-pre-wrap select-text">{plainText(m.text)}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <TrackThreadDialog open={tracking} onOpenChange={setTracking} initial={{ prUrl: url, ticketKey: ticketKey ?? '' }} />
    </div>
  )
}
