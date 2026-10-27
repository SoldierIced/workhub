import { GitPullRequest, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { itemsForFilter, PULL_REQUEST_FILTERS, prName, searchPullRequests, STALE_DAYS, type PullRequestFilter, type PullRequestItem, type Profile } from '@workhub/core'
import type { CodeHostLists } from '@shared/codehost-api'
import { Badge, Button, IconButton, Input, Spinner } from '../components/atoms'
import { EmptyState } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { defaultFilter, findItem, initials, installUrl, loginCommand, relativeTime } from '../lib/pullRequests'
import { usePullRequestLists } from '../pullRequestsStore'
import { StatusBadge } from './pullRequests/PrBadges'
import { PullRequestDetail } from './pullRequests/PullRequestDetail'

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

function Row({ item, selected, onSelect, onOpenWindow, showAuthor }: { item: PullRequestItem; selected: boolean; onSelect: () => void; onOpenWindow: () => void; showAuthor: boolean }) {
  const { t, locale, formatNumber } = useI18n()
  const { pr } = item
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onOpenWindow}
        aria-current={selected ? 'true' : undefined}
        className={cn('flex w-full gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover', selected && 'bg-accent-soft hover:bg-accent-soft')}
      >
        <span aria-hidden className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
          {initials(pr.author)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-base font-semibold">{prName(pr, pr.provider)}</span>
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
              <Badge key={k} tone="accent" className="font-mono">
                {k}
              </Badge>
            ))}
          </span>
        </span>
      </button>
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
  const visible = useMemo(() => searchPullRequests(scoped, query), [scoped, query])
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
                  selected={item.pr.url === selectedUrl}
                  showAuthor={filter === 'toReview' || filter === 'all'}
                  onSelect={() => setSelectedUrl(item.pr.url)}
                  onOpenWindow={() => void window.hub.codeHost.openWindow(profileId, item.pr.url)}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
      <section aria-label={t('pr.detail.tabs')} className="min-h-0 overflow-y-auto">
        {selected ? (
          <PullRequestDetail key={selected.pr.url} profileId={profileId} url={selected.pr.url} seed={selected.pr} onOpenWindow={() => void window.hub.codeHost.openWindow(profileId, selected.pr.url)} />
        ) : (
          <EmptyState icon={<GitPullRequest className="size-6" aria-hidden />} title={t('pr.selectOne')} />
        )}
      </section>
    </div>
  )
}
