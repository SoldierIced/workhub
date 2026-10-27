import { AppWindow, Check, ExternalLink, GitBranch, MessageSquare, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { prName, reviewerStates, reviewRefusal, type PullRequest, type PullRequestDetail as Detail, type ReviewAction } from '@workhub/core'
import type { PullRequestViewResult } from '@shared/codehost-api'
import { Badge, Button, IconButton, Spinner, Textarea } from '../../components/atoms'
import { EmptyState, Tabs, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { initials, relativeTime } from '../../lib/pullRequests'
import { refreshPullRequests } from '../../pullRequestsStore'
import { DiffView } from './DiffView'
import { PrStateBadges } from './PrBadges'
import { ReviewDialog } from './ReviewDialog'

export interface PullRequestDetailProps {
  profileId: string | null
  url: string
  /** The list's copy of the PR: the header shows it while the full view loads. */
  seed?: PullRequest
  /** Inside the Pull requests screen: offers "open in its own window". */
  onOpenWindow?: () => void
}

const REVIEWER_LABEL: Record<string, MessageKey> = {
  approved: 'pr.reviewer.approved',
  changesRequested: 'pr.reviewer.changesRequested',
  dismissed: 'pr.reviewer.dismissed',
  requested: 'pr.reviewer.requested'
}

function Avatar({ name }: { name: string }) {
  return (
    <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
      {initials(name)}
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-muted">{title}</h3>
      {children}
    </section>
  )
}

function Conversation({ detail, canComment, onComment }: { detail: Detail; canComment: boolean; onComment: (body: string) => Promise<string | null> }) {
  const { t, locale } = useI18n()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reviewers = reviewerStates(detail)
  const now = Date.now()
  const send = async () => {
    setBusy(true)
    const failure = await onComment(body)
    setBusy(false)
    setError(failure)
    if (!failure) setBody('')
  }
  return (
    <div className="flex max-w-3xl flex-col gap-6 pb-8">
      <Section title={t('pr.detail.reviewers')}>
        {reviewers.length === 0 ? (
          <p className="text-base text-muted">{t('pr.detail.noReviewers')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {reviewers.map((r) => (
              <li key={r.name} className="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pr-3 pl-1 text-sm">
                <Avatar name={r.name} />
                <span className="font-medium">{r.name}</span>
                <Badge tone={r.state === 'approved' ? 'success' : r.state === 'changesRequested' ? 'warning' : 'neutral'}>{t(REVIEWER_LABEL[r.state]!)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <p className="whitespace-pre-wrap break-words text-base">{detail.body.trim() === '' ? <span className="text-muted">{t('pr.detail.noDescription')}</span> : detail.body}</p>
      {detail.labels.length > 0 && (
        <Section title={t('pr.detail.labels')}>
          <div className="flex flex-wrap gap-1.5">
            {detail.labels.map((l) => (
              <Badge key={l}>{l}</Badge>
            ))}
          </div>
        </Section>
      )}
      {detail.reviews.some((r) => r.body.trim() !== '') && (
        <Section title={t('pr.detail.reviews')}>
          <ul className="flex flex-col gap-3">
            {detail.reviews
              .filter((r) => r.body.trim() !== '')
              .map((r) => (
                <li key={r.id} className="flex gap-3">
                  <Avatar name={r.author} />
                  <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-semibold">{r.author}</span>
                      {r.isBot && <Badge>{t('pr.detail.bot')}</Badge>}
                      {r.state === 'approved' && <Badge tone="success">{t('pr.reviewer.approved')}</Badge>}
                      {r.state === 'changesRequested' && <Badge tone="warning">{t('pr.reviewer.changesRequested')}</Badge>}
                      {r.submittedAt && <span className="text-subtle">{relativeTime(r.submittedAt, now, locale)}</span>}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-base">{r.body}</p>
                  </div>
                </li>
              ))}
          </ul>
        </Section>
      )}
      <Section title={t('pr.detail.comments')}>
        {detail.comments.length === 0 ? (
          <p className="text-base text-muted">{t('pr.detail.noComments')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.comments.map((c) => (
              <li key={c.id} className="flex gap-3">
                <Avatar name={c.author} />
                <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold">{c.author}</span>
                    {c.isBot && <Badge>{t('pr.detail.bot')}</Badge>}
                    {c.createdAt && <span className="text-subtle">{relativeTime(c.createdAt, now, locale)}</span>}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-base">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {canComment && (
        <div className="flex flex-col gap-2">
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
  )
}

/** One pull request: header, review actions and Conversation / Files / Commits / Checks. */
export function PullRequestDetail({ profileId, url, seed, onOpenWindow }: PullRequestDetailProps) {
  const { t, tn, locale, formatNumber } = useI18n()
  const notify = useToast()
  const [result, setResult] = useState<PullRequestViewResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('conversation')
  const [action, setAction] = useState<ReviewAction | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setResult(await window.hub.codeHost.view(profileId, url))
    setLoading(false)
  }, [profileId, url])

  useEffect(() => {
    setResult(null)
    setTab('conversation')
    void load()
  }, [load])

  const view = result?.ok ? result.view : null
  const detail = view?.detail
  const head: PullRequest | undefined = detail ?? seed
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

  if (!head) {
    return result && !result.ok ? (
      <EmptyState title={t('pr.detail.error')} description={result.error} action={<Button onClick={() => void load()}>{t('pr.retry')}</Button>} />
    ) : (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Spinner /> {t('pr.detail.loading')}
      </div>
    )
  }

  const capabilities = result?.ok ? result.capabilities : null
  const isMine = result?.ok ? result.isMine : false
  const actions: { action: ReviewAction; label: MessageKey; icon: typeof Check; variant: 'primary' | 'secondary' | 'danger' }[] = [
    { action: 'approve', label: 'pr.action.approve', icon: Check, variant: 'primary' },
    { action: 'requestChanges', label: 'pr.action.requestChanges', icon: X, variant: 'danger' },
    { action: 'comment', label: 'pr.action.comment', icon: MessageSquare, variant: 'secondary' }
  ]
  const open = head.state === 'open'

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-col gap-2.5 border-b border-border px-6 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-sm text-muted">{prName(head, head.provider)}</p>
            <h2 className="mt-0.5 break-words text-xl font-semibold tracking-tight">{head.title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {loading && <Spinner className="size-4" />}
            <IconButton label={t('pr.refresh')} icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void afterWrite()} />
            {onOpenWindow && <IconButton label={t('pr.detail.openWindow')} icon={<AppWindow className="size-4" aria-hidden />} onClick={onOpenWindow} />}
            <IconButton label={t('pr.detail.openBrowser')} icon={<ExternalLink className="size-4" aria-hidden />} onClick={() => void window.hub.codeHost.openExternal(profileId, url)} />
          </div>
        </div>
        <PrStateBadges pr={head} />
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span>{t('pr.detail.by', { author: head.author })}</span>
          <span className="inline-flex items-center gap-1 font-mono">
            <GitBranch className="size-3.5" aria-hidden />
            {t('pr.detail.branches', { head: head.branch, base: head.base })}
          </span>
          {head.changedFiles > 0 && <span>{tn('pr.detail.filesChanged', head.changedFiles)}</span>}
          {(head.additions > 0 || head.deletions > 0) && (
            <span className="tabular-nums" aria-label={t('pr.detail.lines', { additions: head.additions, deletions: head.deletions })}>
              <span className="text-success">+{formatNumber(head.additions)}</span> <span className="text-danger">−{formatNumber(head.deletions)}</span>
            </span>
          )}
          {head.updatedAt && <span>{t('pr.updated', { time: relativeTime(head.updatedAt, Date.now(), locale) })}</span>}
        </p>
        {capabilities && open && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {actions
              .filter((a) => capabilities.reviewActions.includes(a.action))
              .map((a) => {
                const refusal = reviewRefusal(capabilities, a.action, 'x', isMine)
                const Icon = a.icon
                return (
                  <Button key={a.action} variant={a.variant} icon={<Icon className="size-4" aria-hidden />} disabled={refusal !== null} title={refusal === 'ownPullRequest' ? t('pr.action.ownPullRequest') : undefined} onClick={() => setAction(a.action)}>
                    {t(a.label)}
                  </Button>
                )
              })}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 px-6 pb-4">
        {result && !result.ok && <p role="alert" className="py-4 text-sm text-danger">{result.error}</p>}
        {detail && (
          <Tabs
            label={t('pr.detail.tabs')}
            value={tab}
            onChange={setTab}
            items={[
              { value: 'conversation', label: t('pr.detail.tab.conversation'), content: <Conversation detail={detail} canComment={open} onComment={comment} /> },
              {
                value: 'files',
                label: `${t('pr.detail.tab.files')}${view?.files ? ` (${view.files.length})` : ''}`,
                content: view?.files ? (
                  <DiffView files={view.files} threads={detail.threads} canReply={Boolean(capabilities?.replyToThread) && open} onReply={reply} />
                ) : (
                  <p role="alert" className="text-sm text-danger">{t('pr.files.error', { message: view?.filesError ?? '' })}</p>
                )
              },
              {
                value: 'commits',
                label: `${t('pr.detail.tab.commits')} (${detail.commits.length})`,
                content:
                  detail.commits.length === 0 ? (
                    <p className="text-base text-muted">{t('pr.detail.noCommits')}</p>
                  ) : (
                    <ul className="flex max-w-3xl flex-col divide-y divide-border rounded-lg border border-border bg-surface">
                      {detail.commits.map((c) => (
                        <li key={c.sha} className="flex items-center gap-3 px-4 py-2.5 text-base">
                          <code className="font-mono text-sm text-muted">{c.sha.slice(0, 7)}</code>
                          <span className="min-w-0 flex-1 truncate">{c.headline}</span>
                          <span className="text-sm text-subtle">{c.author}</span>
                        </li>
                      ))}
                    </ul>
                  )
              },
              {
                value: 'checks',
                label: `${t('pr.detail.tab.checks')} (${detail.checks.length})`,
                content:
                  detail.checks.length === 0 ? (
                    <p className="text-base text-muted">{t('pr.detail.noChecks')}</p>
                  ) : (
                    <ul className="flex max-w-3xl flex-col divide-y divide-border rounded-lg border border-border bg-surface">
                      {detail.checks.map((c) => (
                        <li key={`${c.name}:${c.url ?? ''}`} className="flex items-center gap-3 px-4 py-2.5 text-base">
                          <Badge tone={c.status === 'success' ? 'success' : c.status === 'failure' ? 'danger' : 'info'}>{t(`pr.ci.${c.status}`)}</Badge>
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        </li>
                      ))}
                    </ul>
                  )
              }
            ]}
          />
        )}
      </div>
      <ReviewDialog action={action} subject={`${prName(head, head.provider)} ${head.title}`} onClose={() => setAction(null)} onSubmit={submit} />
    </div>
  )
}
