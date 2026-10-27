import { AppWindow, ExternalLink, GitPullRequest, GitPullRequestClosed, Link, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useEffect, useMemo, useState } from 'react'
import { itemsForFilter, PULL_REQUEST_FILTERS, prName, searchPullRequests, STALE_DAYS, type PullRequest, type PullRequestFilter, type PullRequestItem, type Profile } from '@workhub/core'
import type { CodeHostLists } from '@shared/codehost-api'
import { Badge, Button, IconButton, Input, Spinner } from '../components/atoms'
import { EmptyState, SlackBadge, useToast } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { defaultFilter, findItem, initials, installUrl, loginCommand, relativeTime } from '../lib/pullRequests'
import { applyNarrowing, NO_NARROWING, type PrNarrowing } from '../lib/prNarrowing'
import { usePullRequestSlack } from '../lib/slackLinks'
import { refreshPullRequests, usePullRequestLists } from '../pullRequestsStore'
import { ClosePullRequestDialog } from './pullRequests/ClosePullRequestDialog'
import { NarrowingBar } from './pullRequests/NarrowingBar'
import { StatusBadge } from './pullRequests/PrBadges'
import { PullRequestDetail } from './pullRequests/PullRequestDetail'
import { TicketChip } from './pullRequests/TicketChip'

export interface PullRequestsScreenProps {
  profile: Profile | undefined
  /** A PR to select when the screen opens (from a Home card). */
  focusUrl?: string | null
  onOpenSettings: (tab?: string) => void
}

/** Why there is nothing to list: no connection, a missing CLI, no login, or a failed read. */
function Unavailable({ lists, onOpenSettings, onRetry }: { lists: CodeHostLists; onOpenSettings: PullRequestsScreenProps['onOpenSettings']; onRetry: () => void }) {
  const { t } = useI18n()
  const cli = lists.cli ?? 'gh'
  const host = lists.provider === 'gitlab' ? t('pr.host.gitlab') : t('pr.host.github')
  const retry = (
    <Button icon={<RefreshCw className="size-4" aria-hidden />} onClick={onRetry}>
      {t('pr.retry')}
    </Button>
  )
  const icon = <TriangleAlert className="size-6" aria-hidden />
  switch (lists.state) {
    case 'notConnected':
      return (
        <EmptyState
          icon={<GitPullRequest className="size-6" aria-hidden />}
          title={t('pr.notConnected.title')}
          description={t('pr.notConnected.description')}
          action={<Button variant="primary" onClick={() => onOpenSettings('connections')}>{t('pr.openSettings')}</Button>}
        />
      )
    case 'missingCli':
      return <EmptyState icon={icon} title={t('pr.missingCli.title', { cli })} description={t('pr.missingCli.description', { cli, url: installUrl(cli) })} action={retry} />
    case 'signedOut':
      return <EmptyState icon={icon} title={t('pr.signedOut.title', { host })} description={t('pr.signedOut.description', { command: loginCommand(cli) })} action={retry} />
    default:
      return <EmptyState icon={icon} title={t('pr.error.title')} description={lists.message} action={retry} />
  }
}

interface RowProps {
  item: PullRequestItem
  profileId: string | null
  selected: boolean
  showAuthor: boolean
  /** Only the user's own PRs can be closed from Workhub. */
  mine: boolean
  onSelect: () => void
  onOpenWindow: () => void
  onClose: () => void
}

const MENU_CONTENT = 'z-50 min-w-52 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg'
const MENU_ITEM = 'flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft'

/**
 * One PR of the list. The whole row selects it (double click opens its window); the Slack badge
 * and the ticket chips sit above that click area and act on their own. Right click: open in a new
 * window, open in the browser, copy the link, and "Close PR…" for the user's own.
 */
function Row({ item, profileId, selected, showAuthor, mine, onSelect, onOpenWindow, onClose }: RowProps) {
  const { t, locale, formatNumber } = useI18n()
  const notify = useToast()
  const { pr } = item
  const slack = usePullRequestSlack(pr.url)
  const name = prName(pr, pr.provider)
  return (
    <li>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className={cn('relative flex gap-2.5 rounded-md px-2.5 py-2 transition-colors duration-150 hover:bg-surface-hover', selected && 'bg-accent-soft hover:bg-accent-soft')} data-testid="pr-row">
            <button
              type="button"
              onClick={onSelect}
              onDoubleClick={onOpenWindow}
              aria-current={selected ? 'true' : undefined}
              aria-label={`${name} ${pr.title}`}
              className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <span aria-hidden className="pointer-events-none mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
              {initials(pr.author)}
            </span>
            <span className="pointer-events-none min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-base font-semibold">{name}</span>
                <span className="pointer-events-auto relative">
                  <SlackBadge summary={slack.summary} onOpen={() => void window.hub.codeHost.openWindow(profileId, pr.url, 'slack')} />
                </span>
                {pr.updatedAt && <span className="ml-auto shrink-0 text-xs text-subtle">{relativeTime(pr.updatedAt, Date.now(), locale)}</span>}
              </span>
              <span className="mt-0.5 line-clamp-2 text-sm text-muted">{pr.title}</span>
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <StatusBadge status={item.status} />
                {item.stale && <Badge>{t('pr.stale')}</Badge>}
                {(pr.additions > 0 || pr.deletions > 0) && (
                  <span className="text-xs tabular-nums">
                    <span className="text-success">+{formatNumber(pr.additions)}</span> <span className="text-danger">−{formatNumber(pr.deletions)}</span>
                  </span>
                )}
                {showAuthor && <span className="text-xs text-subtle">{pr.author}</span>}
                {item.ticketKeys.map((k) => (
                  <span key={k} className="pointer-events-auto relative">
                    <TicketChip profileId={profileId} ticketKey={k} />
                  </span>
                ))}
              </span>
            </span>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT}>
            <ContextMenu.Item className={MENU_ITEM} onSelect={onOpenWindow}>
              <AppWindow className="size-4 text-muted" aria-hidden />
              {t('pr.menu.openWindow')}
            </ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => void window.hub.codeHost.openExternal(profileId, pr.url)}>
              <ExternalLink className="size-4 text-muted" aria-hidden />
              {t('pr.menu.openBrowser')}
            </ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => void navigator.clipboard.writeText(pr.url).then(() => notify(t('pr.detail.linkCopied')))}>
              <Link className="size-4 text-muted" aria-hidden />
              {t('pr.detail.copyLink')}
            </ContextMenu.Item>
            {mine && pr.state === 'open' && (
              <>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
                <ContextMenu.Item className={cn(MENU_ITEM, 'text-danger')} onSelect={onClose}>
                  <GitPullRequestClosed className="size-4" aria-hidden />
                  {t('pr.close.open')}
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </li>
  )
}

/** Pull requests (⌘2): mine and waiting for my review, with a detail view beside the list. */
export function PullRequestsScreen({ profile, focusUrl, onOpenSettings }: PullRequestsScreenProps) {
  const { t, tn, locale } = useI18n()
  const profileId = profile?.id ?? null
  const { lists, loading, refresh } = usePullRequestLists(profileId)
  const [filter, setFilter] = useState<PullRequestFilter>('toReview')
  const [chosenFilter, setChosenFilter] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  const [narrowing, setNarrowing] = useState<PrNarrowing>(NO_NARROWING)
  const [closing, setClosing] = useState<PullRequest | null>(null)

  // The first read decides the starting filter unless the user already picked one.
  useEffect(() => {
    if (lists && !chosenFilter) setFilter(defaultFilter(lists))
  }, [lists, chosenFilter])

  // A PR asked for from Home: show it under the filter that holds it.
  useEffect(() => {
    if (!lists || !focusUrl) return
    const item = findItem(lists, focusUrl)
    if (!item) return
    setFilter(lists.toReview.some((i) => i.pr.url === focusUrl) ? 'toReview' : item.stale ? 'stale' : 'mine')
    setChosenFilter(true)
    setQuery('')
    setSelectedUrl(focusUrl)
  }, [lists, focusUrl])

  const ready = lists !== null && (lists.state === 'ready' || lists.mine.length > 0 || lists.toReview.length > 0)
  const scoped = useMemo(() => (lists ? itemsForFilter(lists, filter) : []), [lists, filter])
  const visible = useMemo(() => applyNarrowing(searchPullRequests(scoped, query), narrowing), [scoped, query, narrowing])
  const selected = findItem(lists ?? undefined, selectedUrl ?? '') ?? null

  // Keep a PR open: the first of the list when nothing (or something filtered out) is selected.
  useEffect(() => {
    if (visible.length === 0) return
    if (!selectedUrl || !visible.some((i) => i.pr.url === selectedUrl)) setSelectedUrl(visible[0]!.pr.url)
  }, [visible, selectedUrl])

  const countOf = (f: PullRequestFilter) => (lists ? itemsForFilter(lists, f).length : 0)

  if (!lists) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Spinner /> {t('pr.loading')}
      </div>
    )
  }
  if (!ready) return <div className="h-full overflow-y-auto"><Unavailable lists={lists} onOpenSettings={onOpenSettings} onRetry={refresh} /></div>

  return (
    <div className="grid h-full grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)]">
      <section aria-label={t('nav.pullRequests')} className="flex min-h-0 flex-col border-r border-border">
        <div className="flex flex-col gap-2.5 border-b border-border p-3">
          <div role="radiogroup" aria-label={t('pr.filterLabel')} className="grid grid-cols-4 gap-1 rounded-md bg-surface-hover p-0.5">
            {PULL_REQUEST_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                onClick={() => {
                  setFilter(f)
                  setChosenFilter(true)
                }}
                className={cn('h-7 rounded-sm px-1 text-sm transition-colors duration-150', filter === f ? 'bg-surface-raised font-semibold text-text shadow-sm' : 'text-muted hover:text-text')}
              >
                {t(`pr.filter.${f}`)}
                <span className="ml-1 text-xs tabular-nums text-subtle">{countOf(f)}</span>
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-subtle" aria-hidden />
            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('pr.search')} aria-label={t('pr.search')} className="pl-8" />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
            <span className="whitespace-nowrap">{tn('pr.count', visible.length)}</span>
            {lists.demo && <Badge tone="warning">{t('pr.demo')}</Badge>}
            <span className="ml-auto flex items-center gap-2">
              <span className="whitespace-nowrap">{lists.updatedAt ? t('pr.updated', { time: relativeTime(lists.updatedAt, Date.now(), locale) }) : ''}</span>
              {loading && <Spinner className="size-3" />}
              <IconButton size="sm" label={t('pr.refresh')} icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={refresh} />
            </span>
          </div>
          <NarrowingBar items={scoped} shown={visible.length} value={narrowing} onChange={setNarrowing} />
          {lists.message && <p className="text-xs text-warning">{t('pr.partialError', { message: lists.message })}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {visible.length === 0 ? (
            <EmptyState
              compact
              title={query ? t('pr.empty.filtered.title') : t(`pr.empty.${filter}.title`)}
              description={query ? t('pr.empty.filtered.description') : t(`pr.empty.${filter}.description`, { days: STALE_DAYS })}
              action={query ? <Button size="sm" onClick={() => setQuery('')}>{t('pr.clearSearch')}</Button> : undefined}
            />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visible.map((item) => (
                <Row
                  key={item.pr.url}
                  item={item}
                  profileId={profileId}
                  selected={item.pr.url === selectedUrl}
                  showAuthor={filter === 'toReview' || filter === 'all'}
                  mine={lists.mine.some((m) => m.pr.url === item.pr.url)}
                  onSelect={() => setSelectedUrl(item.pr.url)}
                  onOpenWindow={() => void window.hub.codeHost.openWindow(profileId, item.pr.url)}
                  onClose={() => setClosing(item.pr)}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
      <section aria-label={t('pr.detail.tabs')} className="min-h-0 overflow-hidden">
        {selected ? (
          <PullRequestDetail key={selected.pr.url} profileId={profileId} url={selected.pr.url} seed={selected.pr} onOpenWindow={() => void window.hub.codeHost.openWindow(profileId, selected.pr.url)} />
        ) : (
          <EmptyState icon={<GitPullRequest className="size-6" aria-hidden />} title={t('pr.selectOne')} />
        )}
      </section>
      <ClosePullRequestDialog profileId={profileId} pr={closing} onClose={() => setClosing(null)} onClosed={() => void refreshPullRequests(profileId, true)} />
    </div>
  )
}
