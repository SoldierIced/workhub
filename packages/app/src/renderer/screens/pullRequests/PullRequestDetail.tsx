import {
  AppWindow,
  Check,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  GitPullRequestClosed,
  Link,
  MessageSquare,
  RefreshCw,
  SquareTerminal,
  Sparkles,
  Timer,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  closeRefusal,
  historyForPullRequest,
  prName,
  reviewerStates,
  reviewRefusal,
  ticketKeysOfPullRequest,
  type CiStatus,
  type PullRequest,
  type PullRequestDetail as Detail,
  type ReviewAction,
  type ReviewerState
} from '@workhub/core'
import type { PullRequestViewResult, PullRequestWindowTab } from '@shared/codehost-api'
import type { PullRequestTarget } from '@shared/links-api'
import type { TicketsStatus } from '@shared/tickets-api'
import { Avatar, Badge, Button, IconButton, Spinner, Textarea } from '../../components/atoms'
import { EmptyState, Markdown, PastSessions, SlackBadge, Tabs, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { usePlatform } from '../../lib/platform'
import { conversationTimeline, relativeTime, type TimelineEntry } from '../../lib/pullRequests'
import { usePullRequestSlack } from '../../lib/slackLinks'
import { keyProviders } from '../../lib/tickets'
import { usePastSessions } from '../../lib/usePastSessions'
import { refreshPullRequests } from '../../pullRequestsStore'
import { ClosePullRequestDialog } from './ClosePullRequestDialog'
import { DiffView, ThreadBox } from './DiffView'
import { PrStateBadges } from './PrBadges'
import { PrSlackTab } from './PrSlackTab'
import { ReviewDialog } from './ReviewDialog'
import { TicketChip } from './TicketChip'

export interface PullRequestDetailProps {
  profileId: string | null
  url: string
  /** The list's copy of the PR: the header shows it while the full view loads. */
  seed?: PullRequest
  /** Inside the Pull requests screen: offers "open in its own window". */
  onOpenWindow?: () => void
  /**
   * Its own window: the header is the title bar (draggable, room for the window controls), the
   * window is titled `repo#N` with the PR title, and the window can be asked to show a tab.
   */
  standalone?: boolean
  /** The tab to open on (the Slack badge opens Slack). */
  initialTab?: PullRequestWindowTab
}

const REVIEWER_LABEL: Record<ReviewerState['state'], MessageKey> = {
  approved: 'pr.reviewer.approved',
  changesRequested: 'pr.reviewer.changesRequested',
  dismissed: 'pr.reviewer.dismissed',
  requested: 'pr.reviewer.requested'
}
const REVIEWER_ICON: Record<ReviewerState['state'], { icon: typeof Check; className: string }> = {
  approved: { icon: CircleCheck, className: 'text-success' },
  changesRequested: { icon: CircleX, className: 'text-warning' },
  dismissed: { icon: CircleDashed, className: 'text-subtle' },
  requested: { icon: Timer, className: 'text-muted' }
}
const CHECK_TONE: Record<CiStatus, 'success' | 'danger' | 'info' | 'neutral'> = { success: 'success', failure: 'danger', pending: 'info', none: 'neutral' }

function SideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-subtle uppercase">{title}</h3>
      {children}
    </section>
  )
}

/** One bubble of the conversation: who, when, what. */
function Bubble({ author, isBot, at, badge, children }: { author: string; isBot?: boolean; at?: number; badge?: ReactNode; children: ReactNode }) {
  const { t, locale } = useI18n()
  return (
    <li className="flex gap-3">
      <Avatar name={author} className="mt-0.5" />
      <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3.5 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{author}</span>
          {isBot && <Badge>{t('pr.detail.bot')}</Badge>}
          {badge}
          {at ? <span className="text-subtle">{relativeTime(at, Date.now(), locale)}</span> : null}
        </div>
        {children}
      </div>
    </li>
  )
}

function TimelineItem({ entry, canReply, onReply }: { entry: TimelineEntry; canReply: boolean; onReply: (threadId: string, body: string) => Promise<string | null> }) {
  const { t } = useI18n()
  if (entry.kind === 'comment') {
    const c = entry.comment
    return (
      <Bubble author={c.author} isBot={c.isBot} at={c.createdAt}>
        <Markdown text={c.body} className="mt-1 text-base" />
      </Bubble>
    )
  }
  if (entry.kind === 'review') {
    const r = entry.review
    const verdict =
      r.state === 'approved' ? <Badge tone="success">{t('pr.reviewer.approved')}</Badge> : r.state === 'changesRequested' ? <Badge tone="warning">{t('pr.reviewer.changesRequested')}</Badge> : <span className="text-muted">{t('pr.detail.reviewed')}</span>
    return (
      <Bubble author={r.author} isBot={r.isBot} at={r.submittedAt} badge={verdict}>
        {r.body.trim() !== '' && <Markdown text={r.body} className="mt-1 text-base" />}
      </Bubble>
    )
  }
  // A code thread: who opened it and where, then the thread itself (its comments carry their own authors).
  const th = entry.thread
  const first = th.comments[0]!
  const where = th.line !== undefined ? `${th.path}:${th.line}` : th.path
  return (
    <li className="flex gap-3">
      <Avatar name={first.author} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 py-1 text-sm">
          <span className="font-semibold">{first.author}</span>
          <span className="truncate font-mono text-xs text-muted" title={where}>
            {t('pr.detail.onLine', { path: where })}
          </span>
        </p>
        <ThreadBox thread={th} canReply={canReply} onReply={onReply} className="mt-1" />
      </div>
    </li>
  )
}

interface ConversationProps {
  detail: Detail
  profileId: string | null
  tickets: string[]
  canComment: boolean
  canReply: boolean
  onComment: (body: string) => Promise<string | null>
  onReply: (threadId: string, body: string) => Promise<string | null>
  onShowChecks: () => void
}

/**
 * The description and the timeline (comments, reviews, code threads in time order) with the
 * composer; in a wide window an "About" column beside it holds reviewers, labels, tickets and checks.
 */
function Conversation({ detail, profileId, tickets, canComment, canReply, onComment, onReply, onShowChecks }: ConversationProps) {
  const { t, locale } = useI18n()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reviewers = reviewerStates(detail)
  const timeline = useMemo(() => conversationTimeline(detail), [detail])
  const send = async () => {
    setBusy(true)
    const failure = await onComment(body)
    setBusy(false)
    setError(failure)
    if (!failure) setBody('')
  }
  const shownChecks = detail.checks.slice(0, 8)
  return (
    <div className="grid gap-6 pb-6 @5xl:grid-cols-[minmax(0,1fr)_19rem] @7xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <ul className="flex flex-col gap-4">
          <Bubble author={detail.author} at={detail.createdAt}>
            {detail.body.trim() === '' ? <p className="mt-1 text-base text-muted">{t('pr.detail.noDescription')}</p> : <Markdown text={detail.body} className="mt-1 text-base" />}
          </Bubble>
          {timeline.map((entry) => (
            <TimelineItem key={entry.id} entry={entry} canReply={canReply} onReply={onReply} />
          ))}
        </ul>
        {timeline.length === 0 && <p className="pl-11 text-sm text-subtle">{t('pr.detail.noComments')}</p>}
        {canComment && (
          <div className="flex flex-col gap-2 pl-11">
            <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('pr.composer.placeholder')} aria-label={t('pr.composer.placeholder')} className="font-sans" />
            {error && (
              <p role="alert" className="text-sm text-danger">
                {t('pr.action.failed', { message: error })}
              </p>
            )}
            <div className="flex justify-end">
              <Button variant="primary" icon={<MessageSquare className="size-4" aria-hidden />} disabled={busy || body.trim() === ''} onClick={() => void send()}>
                {busy ? t('pr.action.submitting') : t('pr.composer.send')}
              </Button>
            </div>
          </div>
        )}
      </div>
      <aside aria-label={t('pr.detail.about')} className="flex flex-col gap-5 border-border @5xl:border-l @5xl:pl-5">
        <SideSection title={t('pr.detail.reviewers')}>
          {reviewers.length === 0 ? (
            <p className="text-sm text-subtle">{t('pr.detail.noReviewers')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {reviewers.map((r) => (
                <li key={r.name} className="flex items-center gap-2 text-sm">
                  <Avatar name={r.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                  <Badge tone={r.state === 'approved' ? 'success' : r.state === 'changesRequested' ? 'warning' : 'neutral'}>{t(REVIEWER_LABEL[r.state])}</Badge>
                </li>
              ))}
            </ul>
          )}
        </SideSection>
        {tickets.length > 0 && (
          <SideSection title={t('pr.detail.tickets')}>
            <div className="flex flex-wrap gap-1.5">
              {tickets.map((k) => (
                <TicketChip key={k} profileId={profileId} ticketKey={k} />
              ))}
            </div>
          </SideSection>
        )}
        {detail.labels.length > 0 && (
          <SideSection title={t('pr.detail.labels')}>
            <div className="flex flex-wrap gap-1.5">
              {detail.labels.map((l) => (
                <Badge key={l}>{l}</Badge>
              ))}
            </div>
          </SideSection>
        )}
        <SideSection title={t('pr.detail.tab.checks')}>
          {detail.checks.length === 0 ? (
            <p className="text-sm text-subtle">{t('pr.detail.noChecks')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {shownChecks.map((c) => (
                <li key={`${c.name}:${c.url ?? ''}`} className="flex items-center gap-2 text-sm">
                  <Badge tone={CHECK_TONE[c.status]}>{t(`pr.ci.${c.status}`)}</Badge>
                  <span className="min-w-0 flex-1 truncate" title={c.name}>
                    {c.name}
                  </span>
                </li>
              ))}
              {detail.checks.length > shownChecks.length && (
                <li>
                  <button type="button" className="text-sm text-accent hover:underline" onClick={onShowChecks}>
                    {t('pr.home.viewAll')}
                  </button>
                </li>
              )}
            </ul>
          )}
        </SideSection>
        {detail.updatedAt && <p className="text-xs text-subtle">{t('pr.updated', { time: relativeTime(detail.updatedAt, Date.now(), locale) })}</p>}
      </aside>
    </div>
  )
}

/**
 * One pull request, laid out after Workhub 1's PR window: a compact header (`repo#N`, title,
 * "author wants to merge head into base", size, state chips, tickets, reviewers), the actions in a
 * toolbar, then tabs with counts that fill the rest of the space, each scrolling on its own.
 */
export function PullRequestDetail({ profileId, url, seed, onOpenWindow, standalone, initialTab }: PullRequestDetailProps) {
  const { t, tn, locale, formatNumber } = useI18n()
  const platform = usePlatform()
  const notify = useToast()
  const [result, setResult] = useState<PullRequestViewResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<string>(initialTab ?? 'conversation')
  const [action, setAction] = useState<ReviewAction | null>(null)
  const [closing, setClosing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setResult(await window.hub.codeHost.view(profileId, url))
    setLoading(false)
  }, [profileId, url])

  useEffect(() => {
    setResult(null)
    void load()
  }, [load])

  // An open window asked to show a tab (the Slack badge of a row).
  useEffect(() => (standalone ? window.hub.codeHost.onShowTab((next) => setTab(next)) : undefined), [standalone])

  const view = result?.ok ? result.view : null
  const detail = view?.detail
  const head: PullRequest | undefined = detail ?? seed

  useEffect(() => {
    if (standalone) document.title = head ? `${prName(head, head.provider)} · ${head.title}` : t('pr.detail.loading')
  }, [standalone, head, t])

  // Past sessions that named this PR, ran on its branch or share its ticket (from the History).
  const past = usePastSessions()
  const [ticketStatus, setTicketStatus] = useState<TicketsStatus>()
  useEffect(() => {
    void window.hub.tickets.status(profileId).then(setTicketStatus, () => setTicketStatus(undefined))
  }, [profileId])
  const providers = useMemo(() => keyProviders(ticketStatus), [ticketStatus])
  const pastLinks = useMemo(() => (head ? historyForPullRequest(head, past.entries, providers, past.open) : []), [head, past.entries, past.open, providers])
  // Without a tracker for the profile, any project key (`ABC-123`) counts, as in the lists.
  const tickets = useMemo(() => (head ? ticketKeysOfPullRequest(head, providers.length > 0 ? providers : undefined) : []), [head, providers])
  const slack = usePullRequestSlack(head?.url ?? url)

  const afterWrite = async () => {
    await load()
    void refreshPullRequests(profileId, true)
  }
  const submit = async (a: ReviewAction, body: string): Promise<string | null> => {
    const r = await window.hub.codeHost.review(profileId, url, a, body)
    if (!r.ok) return r.error
    notify(t(`pr.action.done.${a}`))
    await afterWrite()
    return null
  }
  const comment = async (body: string): Promise<string | null> => {
    const r = await window.hub.codeHost.comment(profileId, url, body)
    if (!r.ok) return r.error
    notify(t('pr.action.done.comment'))
    await afterWrite()
    return null
  }
  const reply = async (threadId: string, body: string): Promise<string | null> => {
    const r = await window.hub.codeHost.reply(profileId, url, threadId, body)
    if (!r.ok) return r.error
    notify(t('pr.action.done.comment'))
    await afterWrite()
    return null
  }
  const copyLink = () => void navigator.clipboard.writeText(head?.url ?? url).then(() => notify(t('pr.detail.linkCopied')))

  // In its own window the first header row is the title bar: room for the traffic lights or the overlay controls.
  const titleBar = cn('flex h-12 shrink-0 items-center gap-2 px-5', standalone && 'drag-region', standalone && platform === 'mac' && 'pl-20', standalone && platform !== 'mac' && 'pr-36')

  if (!head) {
    return (
      <div className="flex h-full flex-col">
        <div className={titleBar} />
        {result && !result.ok ? (
          <EmptyState title={t('pr.detail.error')} description={result.error} action={<Button onClick={() => void load()}>{t('pr.retry')}</Button>} />
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 text-muted">
            <Spinner /> {t('pr.detail.loading')}
          </div>
        )}
      </div>
    )
  }

  const capabilities = result?.ok ? result.capabilities : null
  const isMine = result?.ok ? result.isMine : false
  const open = head.state === 'open'
  const reviewers = detail ? reviewerStates(detail) : []
  const target: PullRequestTarget = { provider: head.provider, owner: head.owner, repo: head.repo, number: head.number, url: head.url, title: head.title, branch: head.branch, base: head.base, author: head.author }
  const actions: { action: ReviewAction; label: MessageKey; icon: typeof Check; variant: 'primary' | 'secondary' | 'danger' }[] = [
    { action: 'comment', label: 'pr.action.comment', icon: MessageSquare, variant: 'secondary' },
    { action: 'requestChanges', label: 'pr.action.requestChanges', icon: X, variant: 'danger' },
    { action: 'approve', label: 'pr.action.approve', icon: Check, variant: 'primary' }
  ]
  const timelineCount = detail ? conversationTimeline(detail).length : 0
  const count = (label: string, n: number | null) => (n === null ? label : `${label} · ${formatNumber(n)}`)
  const scroll = 'h-full overflow-y-auto px-5 py-4'

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border">
        <div className={titleBar}>
          <span className="shrink-0 font-mono text-sm font-semibold text-accent">{prName(head, head.provider)}</span>
          <h1 className="min-w-0 truncate text-md font-semibold tracking-tight select-text" title={head.title}>
            {head.title}
          </h1>
          <SlackBadge summary={slack.summary} onOpen={() => setTab('slack')} />
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {loading && <Spinner className="mr-1 size-4" />}
            <IconButton label={t('pr.detail.copyLink')} icon={<Link className="size-4" aria-hidden />} onClick={copyLink} />
            <IconButton label={t('pr.detail.openBrowser')} icon={<ExternalLink className="size-4" aria-hidden />} onClick={() => void window.hub.codeHost.openExternal(profileId, url)} />
            {onOpenWindow && <IconButton label={t('pr.detail.openWindow')} icon={<AppWindow className="size-4" aria-hidden />} onClick={onOpenWindow} />}
            <IconButton label={t('pr.refresh')} icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void afterWrite()} />
          </div>
        </div>
        <div className="flex flex-col gap-2 px-5 pb-3">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted select-text">
            <span>{t('pr.detail.wantsToMerge', { author: head.author, head: head.branch, base: head.base })}</span>
            {head.changedFiles > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>{tn('pr.detail.filesChanged', head.changedFiles)}</span>
              </>
            )}
            {(head.additions > 0 || head.deletions > 0) && (
              <span className="tabular-nums" aria-label={t('pr.detail.lines', { additions: head.additions, deletions: head.deletions })}>
                <span className="text-success">+{formatNumber(head.additions)}</span> <span className="text-danger">−{formatNumber(head.deletions)}</span>
              </span>
            )}
            {head.updatedAt && (
              <>
                <span aria-hidden>·</span>
                <span>{t('pr.updated', { time: relativeTime(head.updatedAt, Date.now(), locale) })}</span>
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <PrStateBadges pr={head} />
            {tickets.map((k) => (
              <TicketChip key={k} profileId={profileId} ticketKey={k} />
            ))}
            {detail?.labels.map((l) => (
              <Badge key={l} tone="info">
                {l}
              </Badge>
            ))}
            {reviewers.length > 0 && (
              <span className="ml-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
                <span className="text-xs text-subtle">{t('pr.detail.reviewersShort')}</span>
                {reviewers.map((r) => {
                  const meta = REVIEWER_ICON[r.state]
                  const Icon = meta.icon
                  return (
                    <span key={r.name} className={cn('inline-flex items-center gap-1', meta.className)} title={t(REVIEWER_LABEL[r.state])}>
                      <Icon className="size-3.5" aria-hidden />
                      <span className="text-text">{r.name}</span>
                    </span>
                  )
                })}
              </span>
            )}
          </div>
        </div>
        <div role="toolbar" aria-label={t('pr.detail.toolbar')} className="flex flex-wrap items-center gap-1.5 border-t border-border bg-surface/50 px-5 py-2">
          <Button size="sm" variant="secondary" icon={<SquareTerminal className="size-3.5" aria-hidden />} title={t('links.pr.openSessionHint')} onClick={() => window.hub.links.request({ kind: 'pullRequestSession', profileId, pr: target })}>
            {t('links.pr.openSession')}
          </Button>
          <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" aria-hidden />} title={t('links.pr.reviewHint')} onClick={() => window.hub.links.request({ kind: 'reviewPullRequest', profileId, pr: target })}>
            {t('links.pr.review')}
          </Button>
          <span className="flex-1" />
          {capabilities &&
            open &&
            actions
              .filter((a) => capabilities.reviewActions.includes(a.action))
              .filter((a) => !isMine || a.action === 'comment')
              .map((a) => {
                const refusal = reviewRefusal(capabilities, a.action, 'x', isMine)
                const Icon = a.icon
                return (
                  <Button key={a.action} size="sm" variant={a.variant} icon={<Icon className="size-3.5" aria-hidden />} disabled={refusal !== null} onClick={() => setAction(a.action)}>
                    {t(a.label)}
                  </Button>
                )
              })}
          {result?.ok && closeRefusal(head, isMine) === null && (
            <Button size="sm" variant="danger" icon={<GitPullRequestClosed className="size-3.5" aria-hidden />} title={t('pr.close.openHint')} onClick={() => setClosing(true)}>
              {t('pr.close.open')}
            </Button>
          )}
        </div>
      </header>

      {result && !result.ok && (
        <p role="alert" className="px-5 py-3 text-sm text-danger">
          {result.error}
        </p>
      )}
      {detail ? (
        <Tabs
          label={t('pr.detail.tabs')}
          value={tab}
          onChange={setTab}
          className="min-h-0 flex-1"
          listClassName="px-3"
          contentClassName="pt-0"
          items={[
            {
              value: 'conversation',
              label: count(t('pr.detail.tab.conversation'), timelineCount),
              content: (
                <div className={scroll}>
                  <Conversation
                    detail={detail}
                    profileId={profileId}
                    tickets={tickets}
                    canComment={open}
                    canReply={Boolean(capabilities?.replyToThread) && open}
                    onComment={comment}
                    onReply={reply}
                    onShowChecks={() => setTab('checks')}
                  />
                </div>
              )
            },
            {
              value: 'files',
              label: count(t('pr.detail.tab.files'), view?.files ? view.files.length : head.changedFiles || null),
              content: view?.files ? (
                <div className="h-full px-5 py-4">
                  <DiffView files={view.files} threads={detail.threads} canReply={Boolean(capabilities?.replyToThread) && open} onReply={reply} />
                </div>
              ) : (
                <p role="alert" className="px-5 py-4 text-sm text-danger">
                  {t('pr.files.error', { message: view?.filesError ?? '' })}
                </p>
              )
            },
            {
              value: 'commits',
              label: count(t('pr.detail.tab.commits'), detail.commits.length),
              content: (
                <div className={scroll}>
                  {detail.commits.length === 0 ? (
                    <p className="text-base text-muted">{t('pr.detail.noCommits')}</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
                      {detail.commits.map((c) => (
                        <li key={c.sha} className="flex items-center gap-3 px-4 py-2.5 text-base">
                          <code className="font-mono text-sm text-muted">{c.sha.slice(0, 7)}</code>
                          <span className="min-w-0 flex-1 truncate" title={c.headline}>
                            {c.headline}
                          </span>
                          <span className="text-sm text-subtle">{c.author}</span>
                          {c.date && <span className="w-24 text-right text-xs text-subtle">{relativeTime(c.date, Date.now(), locale)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            },
            {
              value: 'checks',
              label: count(t('pr.detail.tab.checks'), detail.checks.length),
              content: (
                <div className={scroll}>
                  {detail.checks.length === 0 ? (
                    <p className="text-base text-muted">{t('pr.detail.noChecks')}</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
                      {detail.checks.map((c) => (
                        <li key={`${c.name}:${c.url ?? ''}`} className="flex items-center gap-3 px-4 py-2.5 text-base">
                          <Badge tone={CHECK_TONE[c.status]}>{t(`pr.ci.${c.status}`)}</Badge>
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            },
            {
              value: 'sessions',
              label: count(t('links.pastSessions'), past.loading ? null : pastLinks.length),
              content: (
                <div className={scroll}>
                  <PastSessions items={pastLinks} loading={past.loading} error={past.error} onResume={(entry) => window.hub.links.request({ kind: 'resume', profileId, entry, mode: 'app' })} />
                </div>
              )
            },
            {
              value: 'slack',
              label: count(t('pr.detail.tab.slack'), slack.threads.length + slack.messages.length),
              content: (
                <div className={scroll}>
                  <PrSlackTab url={head.url} ticketKey={tickets[0]} links={slack} />
                </div>
              )
            }
          ]}
        />
      ) : (
        !result && (
          <div className="flex flex-1 items-center justify-center gap-2 text-muted">
            <Spinner /> {t('pr.detail.loading')}
          </div>
        )
      )}
      <ReviewDialog action={action} subject={`${prName(head, head.provider)} ${head.title}`} onClose={() => setAction(null)} onSubmit={submit} />
      <ClosePullRequestDialog profileId={profileId} pr={closing ? head : null} onClose={() => setClosing(false)} onClosed={() => void afterWrite()} />
    </div>
  )
}
