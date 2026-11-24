import { AppWindow, ExternalLink, GitPullRequest, GitPullRequestClosed, Link, Search } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { itemsForFilter, PULL_REQUEST_FILTERS, prName, searchPullRequests, STALE_DAYS, type PullRequest, type PullRequestFilter, type PullRequestItem, type Profile } from '@workhub/core'
import { Badge, Button, Input, Spinner } from '../components/atoms'
import { EmptyState, SlackBadge, useToast, RefreshButton } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { defaultFilter, findItem, focusFilter, initials, relativeTime } from '../lib/pullRequests'
import { mergedSeed } from '../lib/mergedStats'
import { applyNarrowing, NO_NARROWING, type PrNarrowing } from '../lib/prNarrowing'
import { usePullRequestSlack } from '../lib/slackLinks'
import { keepDetailsOf } from '../lib/prDetailCache'
import { afterPullRequestWrite } from '../lib/prWrites'
import { usePullRequestLists } from '../pullRequestsStore'
import { ClosePullRequestDialog } from './pullRequests/ClosePullRequestDialog'
import { MergedNarrowingBar } from './pullRequests/MergedFilters'
import { MergedRows } from './pullRequests/MergedRows'
import { MergedSummary } from './pullRequests/MergedSummary'
import { NarrowingBar } from './pullRequests/NarrowingBar'
import { StatusBadge } from './pullRequests/PrBadges'
import { PullRequestDetail } from './pullRequests/PullRequestDetail'
import { TicketChip } from './pullRequests/TicketChip'
import { Unavailable } from './pullRequests/Unavailable'
import { useMergedView } from './pullRequests/useMergedView'

export interface PullRequestsScreenProps {
  profile: Profile | undefined
  /** A PR to select when the screen opens (from a Home card); a new object each time it is asked for. */
  focus?: { url: string } | null
  onOpenSettings: (tab?: string) => void
  /** Whether the screen is on screen: a kept-mounted, hidden screen does not poll the code host. */
  visible?: boolean
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
          <div className={cn('relative flex gap-2.5 rounded-md px-2.5 py-2 transition-colors duration-150 hover:bg-surface-hover data-[state=open]:bg-surface-hover', selected && 'bg-accent-soft hover:bg-accent-soft')} data-testid="pr-row">
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

/** The screen's choices: core's four lists and, here only, the merged statistics. */
type Choice = PullRequestFilter | 'merged'
const CHOICES: readonly Choice[] = [...PULL_REQUEST_FILTERS, 'merged']

/** Pull requests (⌘2): mine and waiting for my review, with a detail view beside the list; Merged: what was merged and into which branch. */
export function PullRequestsScreen({ profile, focus, onOpenSettings, visible: shown = true }: PullRequestsScreenProps) {
  const { t, tn, locale } = useI18n()
  const profileId = profile?.id ?? null
  const { lists, loading, refresh } = usePullRequestLists(profileId, shown)
  const [filter, setFilter] = useState<PullRequestFilter>('toReview')
  const [chosenFilter, setChosenFilter] = useState(false)
  const [showMerged, setShowMerged] = useState(false)
  // The first visit to Merged starts its read; before that nothing is asked of the host.
  const [mergedRequested, setMergedRequested] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  const [narrowing, setNarrowing] = useState<PrNarrowing>(NO_NARROWING)
  const [closing, setClosing] = useState<PullRequest | null>(null)
  const merged = useMergedView(profileId, mergedRequested, showMerged && shown, query)

  // The detail cache holds one profile at a time.
  useEffect(() => keepDetailsOf(profileId), [profileId])

  // The first read decides the starting filter unless the user already picked one.
  useEffect(() => {
    if (lists && !chosenFilter) setFilter(defaultFilter(lists))
  }, [lists, chosenFilter])

  // A PR asked for from Home: show it under the filter that holds it, once per request; later
  // refreshes of the lists leave the user's filter, search and selection alone.
  const appliedFocus = useRef<{ url: string } | null>(null)
  useEffect(() => {
    if (!lists || !focus || appliedFocus.current === focus) return
    const target = focusFilter(lists, focus.url)
    if (!target) return
    appliedFocus.current = focus
    setFilter(target)
    setChosenFilter(true)
    setShowMerged(false)
    setQuery('')
    setSelectedUrl(focus.url)
  }, [lists, focus])

  const ready = lists !== null && (lists.state === 'ready' || lists.mine.length > 0 || lists.toReview.length > 0)
  const scoped = useMemo(() => (lists ? itemsForFilter(lists, filter) : []), [lists, filter])
  const visible = useMemo(() => applyNarrowing(searchPullRequests(scoped, query), narrowing), [scoped, query, narrowing])
  const selected = findItem(lists ?? undefined, selectedUrl ?? '') ?? null

  // Keep a PR open: the first of the list when nothing (or something filtered out) is selected. Merged opens on its summary instead.
  useEffect(() => {
    if (showMerged || visible.length === 0) return
    if (!selectedUrl || !visible.some((i) => i.pr.url === selectedUrl)) setSelectedUrl(visible[0]!.pr.url)
  }, [visible, selectedUrl, showMerged])

  // Escape takes a merged PR back to the summary (unless something on top of the screen wants the key).
  const openMerged = showMerged && shown && merged.selected !== null
  const { select: selectMerged } = merged
  useEffect(() => {
    if (!openMerged) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target instanceof HTMLElement ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return
      selectMerged(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openMerged, selectMerged])

  const countOf = (f: PullRequestFilter) => (lists ? itemsForFilter(lists, f).length : 0)
  const choose = (c: Choice) => {
    if (c === 'merged') {
      setShowMerged(true)
      setMergedRequested(true)
      return
    }
    setShowMerged(false)
    setFilter(c)
    setChosenFilter(true)
  }

  const radios = (
    <div role="radiogroup" aria-label={t('pr.filterLabel')} className="flex gap-1 rounded-md bg-surface-hover p-0.5">
      {CHOICES.map((c) => {
        const on = c === 'merged' ? showMerged : !showMerged && filter === c
        const count = c === 'merged' ? (merged.hasData ? merged.visible.length : null) : countOf(c)
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => choose(c)}
            className={cn('h-7 flex-auto whitespace-nowrap rounded-sm px-1 text-sm transition-colors duration-150', on ? 'bg-surface-raised font-semibold text-text shadow-sm' : 'text-muted hover:text-text')}
          >
            {t(`pr.filter.${c}`)}
            {count !== null && <span className="ml-1 text-xs tabular-nums text-subtle">{count}</span>}
          </button>
        )
      })}
    </div>
  )

  if (!showMerged && !lists) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border p-3">{radios}</div>
        <div className="flex flex-1 items-center justify-center gap-2 text-muted">
          <Spinner /> {t('pr.loading')}
        </div>
      </div>
    )
  }
  if (!showMerged && !ready && lists) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border p-3">{radios}</div>
        <div className="min-h-0 flex-1 overflow-y-auto"><Unavailable state={lists.state} message={lists.message} provider={lists.provider} cli={lists.cli} onOpenSettings={onOpenSettings} onRetry={refresh} /></div>
      </div>
    )
  }

  return (
    <div className="grid h-full grid-cols-[clamp(20rem,40%,26rem)_minmax(0,1fr)]">
      <section aria-label={t('nav.pullRequests')} className="flex min-h-0 flex-col border-r border-border">
        <div className="flex flex-col gap-2.5 border-b border-border p-3">
          {radios}
          <div className="relative">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-subtle" aria-hidden />
            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={showMerged ? t('pr.merged.search') : t('pr.search')} aria-label={showMerged ? t('pr.merged.search') : t('pr.search')} className="pl-8" />
          </div>
          {showMerged ? (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                <span className="whitespace-nowrap">{merged.hasData ? tn('pr.merged.count', merged.visible.length) : ''}</span>
                {merged.demo && <Badge tone="warning">{t('pr.demo')}</Badge>}
              </div>
              <MergedNarrowingBar items={merged.searched} shown={merged.visible.length} value={merged.ui.narrowing} onChange={merged.setNarrowing} />
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                <span className="whitespace-nowrap">{tn('pr.count', visible.length)}</span>
                {lists?.demo && <Badge tone="warning">{t('pr.demo')}</Badge>}
                <span className="ml-auto flex items-center gap-2">
                  <span className="whitespace-nowrap">{lists?.updatedAt ? t('pr.updated', { time: relativeTime(lists.updatedAt, Date.now(), locale) }) : ''}</span>
                  <RefreshButton label={t('pr.refresh')} loading={loading} onRefresh={refresh} />
                </span>
              </div>
              <NarrowingBar items={scoped} shown={visible.length} value={narrowing} onChange={setNarrowing} />
              {lists?.message && <p className="text-xs text-warning">{t('pr.partialError', { message: lists.message })}</p>}
            </>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {showMerged ? (
            <MergedRows view={merged} profileId={profileId} query={query} onClearSearch={() => setQuery('')} />
          ) : visible.length === 0 ? (
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
                  mine={lists!.mine.some((m) => m.pr.url === item.pr.url)}
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
        {showMerged ? (
          merged.selected ? (
            <PullRequestDetail profileId={profileId} url={merged.selected.url} seed={mergedSeed(merged.selected)} onOpenWindow={() => void window.hub.codeHost.openWindow(profileId, merged.selected!.url)} onBack={() => merged.select(null)} />
          ) : (
            <MergedSummary view={merged} host={{ provider: lists?.provider, cli: lists?.cli }} onOpenSettings={onOpenSettings} />
          )
        ) : selected ? (
          <PullRequestDetail profileId={profileId} url={selected.pr.url} seed={selected.pr} onOpenWindow={() => void window.hub.codeHost.openWindow(profileId, selected.pr.url)} />
        ) : (
          <EmptyState icon={<GitPullRequest className="size-6" aria-hidden />} title={t('pr.selectOne')} />
        )}
      </section>
      <ClosePullRequestDialog profileId={profileId} pr={closing} onClose={() => setClosing(null)} onClosed={() => closing && afterPullRequestWrite(profileId, closing.url, { state: 'closed' })} />
    </div>
  )
}
