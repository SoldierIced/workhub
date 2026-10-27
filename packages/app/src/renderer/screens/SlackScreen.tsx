import { MessageSquare, Play, Plus, Settings } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { hasUnread, plainText, sessionIdentity, type Profile, type TrackedThread } from '@workhub/core'
import type { SlackSnapshot } from '@shared/chat-api'
import { Badge, Button, Input, Spinner } from '../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, useToast } from '../components/molecules'
import { useSlack } from '../chatStore'
import { useI18n } from '../i18n/I18nProvider'
import { relativeTime } from '../lib/pullRequests'
import type { SessionData } from '../store'
import { ThreadGroup } from './slack/ThreadList'

const HEALTH_TONE = { off: 'neutral', watching: 'success', checking: 'info', paused: 'warning', failing: 'danger' } as const

export interface SlackScreenProps {
  profile: Profile | undefined
  sessions: SessionData[]
  onOpenSession: (viewId: string) => void
  onOpenSettings: (tab?: string) => void
}

/** Slack (⌘4): the watched channels' latest messages and the followed threads, grouped by the session that owns them. */
export function SlackScreen({ profile, sessions, onOpenSession, onOpenSettings }: SlackScreenProps) {
  const { t, locale } = useI18n()
  const toast = useToast()
  const snap = useSlack()
  const [link, setLink] = useState('')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  // What is on screen counts as read.
  const unreadIds = useMemo(() => (snap ? snap.threads.filter((th) => hasUnread(th, snap.me)).map((th) => th.id) : []), [snap])
  useEffect(() => {
    if (unreadIds.length) void window.hub.slack.markViewed(unreadIds)
  }, [unreadIds])

  if (!snap) {
    return (
      <p className="flex items-center gap-2 p-8 text-sm text-muted" role="status">
        <Spinner /> {t('slack.loading')}
      </p>
    )
  }

  const openOwner = async (th: TrackedThread) => {
    const id = await window.hub.slack.openOwner(th.id)
    if (id) onOpenSession(id)
    else toast(t('slack.ownerMissing'), 'danger')
  }
  const track = async () => {
    const r = await window.hub.slack.track({ permalink: link.trim() })
    if (r.ok) setLink('')
    else toast(t(`slack.trackError.${r.error}`), 'danger')
  }

  const configured = snap.settings.enabled && snap.settings.channels.length > 0
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-8 py-7">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('nav.slack')}</h1>
          <p className="mt-0.5 max-w-2xl text-base text-muted">{t('slack.subtitle')}</p>
        </div>
        {snap.demo && <Badge tone="info">{t('slack.demo')}</Badge>}
        <Badge tone={HEALTH_TONE[snap.health]}>{t(`slack.health.${snap.health}`)}</Badge>
        <Button size="sm" icon={snap.health === 'checking' ? <Spinner /> : <Play className="size-3.5" aria-hidden />} disabled={snap.health === 'checking'} onClick={() => void window.hub.slack.runNow()}>
          {t('slack.runNow')}
        </Button>
        <Button size="sm" variant="ghost" icon={<Settings className="size-3.5" aria-hidden />} onClick={() => onOpenSettings('slack')}>
          {t('slack.settings')}
        </Button>
      </header>
      <StatusLine snap={snap} now={now} />

      {!configured && snap.threads.length === 0 ? (
        <EmptyState
          icon={<MessageSquare className="size-6" aria-hidden />}
          title={t('slack.empty.title')}
          description={t('slack.empty.hint')}
          action={
            <Button variant="primary" onClick={() => onOpenSettings('slack')}>
              {t('slack.settings')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t('slack.threads')} meta={String(snap.threads.length)} />
            <CardBody className="flex flex-col gap-4">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void track()
                }}
              >
                <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder={t('slack.trackPlaceholder')} aria-label={t('slack.trackPlaceholder')} className="flex-1" />
                <Button type="submit" size="sm" icon={<Plus className="size-3.5" aria-hidden />} disabled={!link.trim()}>
                  {t('slack.track')}
                </Button>
              </form>
              {snap.threads.length === 0 && <p className="text-sm text-subtle">{t('slack.noThreads')}</p>}
              <ThreadsBySession snap={snap} sessions={sessions} now={now} onOpen={(th) => void openOwner(th)} />
            </CardBody>
          </Card>
          <div className="flex flex-col gap-4">
            <ChannelMessages snap={snap} now={now} locale={locale} />
            <RunLog snap={snap} now={now} locale={locale} />
          </div>
        </div>
      )}
    </div>
  )
}

function StatusLine({ snap, now }: { snap: SlackSnapshot; now: number }) {
  const { t, locale } = useI18n()
  const parts: string[] = []
  if (snap.skipReason) parts.push(t(`slack.skip.${snap.skipReason}`))
  if (snap.nextRunAt && snap.settings.enabled) parts.push(t('slack.nextRun', { time: relativeTime(snap.nextRunAt, now, locale) }))
  if (snap.lastError) parts.push(t('slack.lastError', { error: snap.lastError === 'nothingToWatch' ? t('slack.nothingToWatch') : snap.lastError }))
  return parts.length ? <p className="-mt-2 text-sm text-subtle">{parts.join(' · ')}</p> : null
}

/** One group per owning session (its sidebar label), then the threads with no session. */
function ThreadsBySession({ snap, sessions, now, onOpen }: { snap: SlackSnapshot; sessions: SessionData[]; now: number; onOpen: (th: TrackedThread) => void }) {
  const { t } = useI18n()
  const groups = new Map<string, TrackedThread[]>()
  for (const th of snap.threads) groups.set(th.owner ?? '', [...(groups.get(th.owner ?? '') ?? []), th])
  const labelOf = (owner: string) => {
    if (!owner) return t('slack.noSession')
    const view = sessions.find((s) => sessionIdentity(s.view) === owner)?.view
    return view ? `${view.label} · ${view.cwd.split(/[\\/]/).pop() ?? ''}` : t('slack.closedSession', { id: owner.slice(0, 8) })
  }
  return (
    <>
      {[...groups.entries()]
        .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0))
        .map(([owner, threads]) => (
          <section key={owner || 'none'} aria-label={labelOf(owner)} data-testid="thread-group">
            <h3 className="mb-1.5 text-sm font-semibold text-muted">{labelOf(owner)}</h3>
            <ThreadGroup threads={threads} me={snap.me} now={now} actions={{ onOpenSession: onOpen }} />
          </section>
        ))}
    </>
  )
}

function ChannelMessages({ snap, now, locale }: { snap: SlackSnapshot; now: number; locale: string }) {
  const { t } = useI18n()
  const name = (id: string) => snap.settings.channels.find((c) => c.id === id)?.name ?? id
  const followed = new Set(snap.threads.map((th) => `${th.channelId}:${th.ts}`))
  return (
    <Card>
      <CardHeader title={t('slack.messages')} meta={String(snap.messages.length)} />
      <CardBody>
        {snap.messages.length === 0 && <p className="text-sm text-subtle">{t('slack.noMessages')}</p>}
        <ul className="flex flex-col gap-2">
          {snap.messages.slice(0, 40).map((m) => (
            <li key={`${m.channelId}:${m.ts}`} className="rounded-md border border-border px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-subtle">
                <span className="font-medium text-muted">#{name(m.channelId)}</span>
                <span>{m.user}</span>
                <span className="ml-auto">{relativeTime(Number(m.ts) * 1000, now, locale)}</span>
              </div>
              <p className="mt-0.5 line-clamp-3 text-sm break-words">{plainText(m.text)}</p>
              <div className="mt-1 flex gap-1">
                {m.prUrls.map((u) => (
                  <Badge key={u} tone="accent">
                    {u.replace(/^https:\/\/(www\.)?/, '')}
                  </Badge>
                ))}
                {!followed.has(`${m.channelId}:${m.ts}`) && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void window.hub.slack.trackMessage(m.channelId, m.ts)}>
                    {t('slack.follow')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

function RunLog({ snap, now, locale }: { snap: SlackSnapshot; now: number; locale: string }) {
  const { t } = useI18n()
  return (
    <Card>
      <CardHeader title={t('slack.runs')} />
      <CardBody>
        {snap.runs.length === 0 && <p className="text-sm text-subtle">{t('slack.noRuns')}</p>}
        <ul className="flex flex-col gap-1 text-sm">
          {snap.runs.slice(0, 10).map((r) => (
            <li key={r.id} className="flex gap-2">
              <span className={r.ok ? 'text-success' : 'text-danger'}>{r.ok ? '●' : '▲'}</span>
              <span className="min-w-0 flex-1 truncate" title={r.outcome}>
                {r.ok ? t('slack.runOk', { messages: r.messages, replies: r.replies }) : r.outcome}
              </span>
              <span className="text-xs text-subtle">{relativeTime(r.at, now, locale)}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}
