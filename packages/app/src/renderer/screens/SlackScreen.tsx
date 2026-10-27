import { Check, Ear, EarOff, GitPullRequest, Hash, History, Inbox, MessagesSquare, Play, Plus, Settings, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { hasUnread, plainText, sessionIdentity, threadArchiveMinutes, type ChatMessage, type Profile, type TrackedThread } from '@workhub/core'
import type { SlackSnapshot } from '@shared/chat-api'
import { Avatar, Badge, Button, Input, Spinner } from '../components/atoms'
import { EmptyState, useToast } from '../components/molecules'
import { useSlack } from '../chatStore'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { relativeTime } from '../lib/pullRequests'
import type { SessionData } from '../store'
import { LinkChip, shortPr, ThreadGroup } from './slack/ThreadList'

const HEALTH_TONE = { off: 'neutral', watching: 'success', checking: 'info', paused: 'warning', failing: 'danger' } as const

export interface SlackScreenProps {
  profile: Profile | undefined
  sessions: SessionData[]
  onOpenSession: (viewId: string) => void
  onOpenSettings: (tab?: string) => void
}

/** What the right side shows: the followed threads, one channel's messages, or the read log. */
type Pane = { kind: 'threads' } | { kind: 'channel'; id: string } | { kind: 'runs' }

/**
 * Slack (⌘4), laid out like Workhub 1's: a status header, a left list (followed threads, then each
 * watched channel with its message count, then the reads) and the selected pane on the right.
 */
export function SlackScreen({ profile, sessions, onOpenSession, onOpenSettings }: SlackScreenProps) {
  const { t } = useI18n()
  const toast = useToast()
  const snap = useSlack()
  const [pane, setPane] = useState<Pane>({ kind: 'threads' })
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  // What is on screen counts as read.
  const unreadIds = useMemo(() => (snap && pane.kind === 'threads' ? snap.threads.filter((th) => hasUnread(th, snap.me)).map((th) => th.id) : []), [snap, pane.kind])
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
  const channelName = (id: string) => snap.settings.channels.find((c) => c.id === id)?.name ?? id
  const configured = snap.settings.enabled && snap.settings.channels.length > 0
  const openThreads = snap.threads.filter((th) => !th.closed).length
  const channel = pane.kind === 'channel' ? snap.settings.channels.find((c) => c.id === pane.id) : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StatusHeader snap={snap} now={now} onOpenSettings={() => onOpenSettings('slack')} />
      {!configured && snap.threads.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState
            icon={<MessagesSquare className="size-6" aria-hidden />}
            title={t('slack.empty.title')}
            description={t('slack.empty.hint')}
            action={
              <Button variant="primary" onClick={() => onOpenSettings('slack')}>
                {t('slack.settings')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav aria-label={t('slack.sections')} className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar/40 p-2" data-testid="slack-nav">
            <NavItem icon={<MessagesSquare className="size-4" aria-hidden />} label={t('slack.threads')} count={openThreads} active={pane.kind === 'threads'} onClick={() => setPane({ kind: 'threads' })} />
            <p className="mt-3 mb-1 px-2 text-2xs font-semibold tracking-wider text-subtle uppercase">{t('slack.channels')}</p>
            {snap.settings.channels.length === 0 && <p className="px-2 text-xs text-subtle">{t('slack.noChannels')}</p>}
            {snap.settings.channels.map((c) => (
              <NavItem
                key={c.id}
                icon={<Hash className="size-4" aria-hidden />}
                label={c.name || c.id}
                count={snap.messages.filter((m) => m.channelId === c.id).length}
                active={pane.kind === 'channel' && pane.id === c.id}
                onClick={() => setPane({ kind: 'channel', id: c.id })}
              />
            ))}
            <div className="mt-auto pt-3">
              <NavItem icon={<History className="size-4" aria-hidden />} label={t('slack.runs')} count={snap.runs.length} active={pane.kind === 'runs'} onClick={() => setPane({ kind: 'runs' })} />
            </div>
          </nav>
          <section className="min-w-0 flex-1 overflow-y-auto" aria-live="polite">
            <div className="mx-auto flex max-w-4xl flex-col gap-4 px-8 py-6">
              {pane.kind === 'threads' && <ThreadsPane snap={snap} sessions={sessions} archiveMinutes={threadArchiveMinutes(profile)} now={now} channelName={channelName} onOpen={(th) => void openOwner(th)} />}
              {pane.kind === 'channel' && (
                <ChannelPane
                  snap={snap}
                  now={now}
                  channelId={pane.id}
                  name={channel?.name || pane.id}
                  purpose={channel?.purpose ?? ''}
                  onTracked={() => toast(t('slack.followed'))}
                />
              )}
              {pane.kind === 'runs' && <RunsPane snap={snap} now={now} />}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function NavItem({ icon, label, count, active, onClick }: { icon: ReactNode; label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-base transition-colors',
        active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-surface-hover hover:text-text'
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count > 0 && <span className={cn('rounded-full px-1.5 text-xs tabular-nums', active ? 'text-accent' : 'text-subtle')}>{count}</span>}
    </button>
  )
}

/** Title, the watcher's state and schedule, whether sessions' messages are followed on their own, the last error. */
function StatusHeader({ snap, now, onOpenSettings }: { snap: SlackSnapshot; now: number; onOpenSettings: () => void }) {
  const { t, tn, locale } = useI18n()
  const last = snap.runs[0]
  const parts: string[] = []
  if (!snap.settings.enabled) parts.push(t('slack.watcherOff'))
  else {
    parts.push(last ? t('slack.lastRun', { time: relativeTime(last.at, now, locale), outcome: last.ok ? t('slack.runOkShort') : t('slack.runFailed') }) : t('slack.noRunsYet'))
    if (snap.skipReason) parts.push(t(`slack.skip.${snap.skipReason}`))
    if (snap.nextRunAt) parts.push(t('slack.nextRun', { time: relativeTime(snap.nextRunAt, now, locale) }))
  }
  const hooked = snap.hooks.filter((h) => h.status.state === 'installed').map((h) => h.name)
  const listening = snap.threads.filter((th) => th.owner && th.wake && !th.closed).length
  const checking = snap.health === 'checking'
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-border px-8 pt-6 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight">{t('nav.slack')}</h1>
        {snap.demo && <Badge tone="info">{t('slack.demo')}</Badge>}
        <Button size="sm" variant="ghost" icon={<Settings className="size-3.5" aria-hidden />} onClick={onOpenSettings}>
          {t('slack.settings')}
        </Button>
        <Button size="sm" variant="primary" icon={checking ? <Spinner /> : <Play className="size-3.5" aria-hidden />} disabled={checking} onClick={() => void window.hub.slack.runNow()}>
          {checking ? t('slack.health.checking') : t('slack.runNow')}
        </Button>
      </div>
      <p className="max-w-3xl text-base text-muted">{t('slack.subtitle')}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Badge tone={HEALTH_TONE[snap.health]}>{t(`slack.health.${snap.health}`)}</Badge>
        <span className="text-subtle">{parts.join(' · ')}</span>
      </div>
      <p className={cn('flex items-center gap-1.5 text-sm', hooked.length ? 'text-subtle' : 'text-warning')}>
        {hooked.length ? <Ear className="size-3.5 shrink-0" aria-hidden /> : <EarOff className="size-3.5 shrink-0" aria-hidden />}
        {hooked.length ? `${t('slack.autoTrackOn', { accounts: hooked.join(', ') })} · ${tn('slack.listening', listening)}` : t('slack.autoTrackOff')}
      </p>
      {snap.lastError && (
        <p className="flex items-center gap-1.5 text-sm text-warning" role="alert">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="select-text">{t('slack.lastError', { error: snap.lastError === 'nothingToWatch' ? t('slack.nothingToWatch') : snap.lastError })}</span>
        </p>
      )}
    </header>
  )
}

function ThreadsPane({
  snap,
  sessions,
  archiveMinutes,
  now,
  channelName,
  onOpen
}: {
  snap: SlackSnapshot
  sessions: SessionData[]
  archiveMinutes: number
  now: number
  channelName: (id: string) => string
  onOpen: (th: TrackedThread) => void
}) {
  const { t } = useI18n()
  const toast = useToast()
  const [link, setLink] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const visible = snap.threads.filter((th) => showClosed || !th.closed)
  const closedCount = snap.threads.length - snap.threads.filter((th) => !th.closed).length
  const track = async () => {
    const r = await window.hub.slack.track({ permalink: link.trim() })
    if (r.ok) setLink('')
    else toast(t(`slack.trackError.${r.error}`), 'danger')
  }
  // One group per owning session (its sidebar label), then the threads with no session.
  const groups = new Map<string, TrackedThread[]>()
  for (const th of visible) groups.set(th.owner ?? '', [...(groups.get(th.owner ?? '') ?? []), th])
  const labelOf = (owner: string) => {
    if (!owner) return t('slack.noSession')
    const view = sessions.find((s) => sessionIdentity(s.view) === owner)?.view
    return view ? `${view.label} · ${view.cwd.split(/[\\/]/).pop() ?? ''}` : t('slack.closedSession', { id: owner.slice(0, 8) })
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-xl font-semibold">{t('slack.threads')}</h2>
        {closedCount > 0 && (
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-[var(--wh-accent)]" />
            {t('slack.showClosed', { count: closedCount })}
          </label>
        )}
      </div>
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
      {visible.length === 0 ? (
        <EmptyState compact icon={<MessagesSquare className="size-5" aria-hidden />} title={t('slack.noThreadsTitle')} description={t('slack.noThreads')} />
      ) : (
        [...groups.entries()]
          .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0))
          .map(([owner, threads]) => (
            <section key={owner || 'none'} aria-label={labelOf(owner)} data-testid="thread-group" className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-muted">
                <span className="truncate">{labelOf(owner)}</span>
                <span className="text-xs font-normal text-subtle tabular-nums">{threads.length}</span>
              </h3>
              <ThreadGroup threads={threads} me={snap.me} archiveMinutes={archiveMinutes} now={now} actions={{ onOpenSession: onOpen, channelName }} />
            </section>
          ))
      )}
    </>
  )
}

function ChannelPane({ snap, now, channelId, name, purpose, onTracked }: { snap: SlackSnapshot; now: number; channelId: string; name: string; purpose: string; onTracked: () => void }) {
  const { t } = useI18n()
  const messages = snap.messages.filter((m) => m.channelId === channelId)
  const followed = new Set(snap.threads.map((th) => `${th.channelId}:${th.ts}`))
  return (
    <>
      <div>
        <h2 className="flex items-center gap-1 text-xl font-semibold">
          <Hash className="size-5 text-subtle" aria-hidden />
          {name}
        </h2>
        {purpose && <p className="mt-0.5 text-base text-muted">{purpose}</p>}
      </div>
      {messages.length === 0 ? (
        <EmptyState compact icon={<Inbox className="size-5" aria-hidden />} title={t('slack.noMessagesTitle')} description={t('slack.noMessages')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
          {messages.slice(0, 80).map((m) => (
            <MessageRow key={`${m.channelId}:${m.ts}`} message={m} now={now} tracked={followed.has(`${m.channelId}:${m.threadTs ?? m.ts}`)} onTracked={onTracked} />
          ))}
        </ul>
      )}
    </>
  )
}

/** One channel message: author, time, reply count, its text, the PRs and tickets it mentions, and "Follow thread". */
function MessageRow({ message: m, now, tracked, onTracked }: { message: ChatMessage; now: number; tracked: boolean; onTracked: () => void }) {
  const { t, tn, locale } = useI18n()
  const isReply = Boolean(m.threadTs && m.threadTs !== m.ts)
  return (
    <li className="flex gap-3 px-4 py-3" data-testid="slack-message">
      <Avatar name={m.user} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-base font-semibold">{m.user}</span>
          <span className="text-xs text-subtle" title={new Date(Number(m.ts) * 1000).toLocaleString(locale)}>
            {relativeTime(Number(m.ts) * 1000, now, locale)}
          </span>
          {isReply && <Badge>{t('slack.reply')}</Badge>}
          {(m.replyCount ?? 0) > 0 && <Badge tone="info">{tn('slack.replyCount', m.replyCount ?? 0)}</Badge>}
        </div>
        <p className="mt-0.5 text-base break-words whitespace-pre-wrap text-text select-text">{plainText(m.text)}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {m.prUrls.map((u) => (
            <LinkChip key={u} icon={<GitPullRequest className="size-3" aria-hidden />} label={shortPr(u)} title={u} onClick={() => window.hub.openExternal(u)} />
          ))}
          {m.tickets.map((k) => (
            <LinkChip key={k} icon={null} label={k} />
          ))}
          <span className="ml-auto flex items-center gap-1">
            {m.permalink && (
              <Button size="sm" variant="ghost" onClick={() => window.hub.openExternal(m.permalink!)}>
                {t('slack.openInSlack')}
              </Button>
            )}
            {tracked ? (
              <span className="flex items-center gap-1 px-2 text-sm text-subtle">
                <Check className="size-3.5" aria-hidden />
                {t('slack.following')}
              </span>
            ) : (
              <Button
                size="sm"
                icon={<Plus className="size-3.5" aria-hidden />}
                onClick={() => {
                  void window.hub.slack.trackMessage(m.channelId, m.ts).then(onTracked)
                }}
              >
                {t('slack.follow')}
              </Button>
            )}
          </span>
        </div>
      </div>
    </li>
  )
}

function RunsPane({ snap, now }: { snap: SlackSnapshot; now: number }) {
  const { t, tn, locale } = useI18n()
  return (
    <>
      <h2 className="text-xl font-semibold">{t('slack.runs')}</h2>
      {snap.runs.length === 0 ? (
        <EmptyState compact icon={<History className="size-5" aria-hidden />} title={t('slack.noRuns')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
          {snap.runs.slice(0, 30).map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-base">
              <span className={cn('size-2 shrink-0 rounded-full', r.ok ? 'bg-success' : 'bg-danger')} aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={r.outcome}>
                {r.ok ? t('slack.runOk', { messages: r.messages, replies: r.replies }) : r.outcome}
              </span>
              {r.deniedTools.length > 0 && <Badge tone="warning">{tn('slack.deniedTools', r.deniedTools.length)}</Badge>}
              <span className="text-xs text-subtle tabular-nums">{relativeTime(r.at, now, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
