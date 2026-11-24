import { AppWindow, ExternalLink, GitPullRequest, Link } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useMemo, useState } from 'react'
import { prName, type MergedPullRequest } from '@workhub/core'
import { Badge, Button } from '../../components/atoms'
import { EmptyState, SlackBadge, useToast } from '../../components/molecules'
import { seriesColor } from '../../components/molecules/StackedBarChart'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { dayStart, firstRows, groupByDay, groupOf, GROUP_SLOT } from '../../lib/mergedStats'
import { usePullRequestSlack } from '../../lib/slackLinks'
import type { MergedView } from './useMergedView'

const MENU_CONTENT = 'z-50 min-w-52 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg'
const MENU_ITEM = 'flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft'

/** The target branch with its group's swatch: `→ develop`. */
export function BaseChip({ base }: { base: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-1.5 text-xs text-muted" title={base} data-testid="merged-base">
      <span className="size-2 shrink-0 rounded-sm" style={{ background: seriesColor(GROUP_SLOT[groupOf(base)]) }} aria-hidden />
      <span className="truncate font-mono">→ {base}</span>
    </span>
  )
}

function MergedRow({ pr, profileId, selected, onSelect }: { pr: MergedPullRequest; profileId: string | null; selected: boolean; onSelect: () => void }) {
  const { t, formatDate, formatNumber } = useI18n()
  const notify = useToast()
  const slack = usePullRequestSlack(pr.url)
  const name = prName(pr, pr.provider)
  const open = () => void window.hub.codeHost.openWindow(profileId, pr.url)
  const reported = pr.additions !== undefined || pr.deletions !== undefined
  return (
    <li>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className={cn('relative flex flex-col gap-0.5 rounded-md px-2.5 py-2 transition-colors duration-150 hover:bg-surface-hover data-[state=open]:bg-surface-hover', selected && 'bg-accent-soft hover:bg-accent-soft')} data-testid="merged-row">
            <button
              type="button"
              onClick={onSelect}
              onDoubleClick={open}
              aria-current={selected ? 'true' : undefined}
              aria-label={`${name} ${pr.title}`}
              className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <span className="pointer-events-none flex items-center gap-1.5">
              <span className="truncate text-base font-semibold">{name}</span>
              <span className="pointer-events-auto relative">
                <SlackBadge summary={slack.summary} onOpen={() => void window.hub.codeHost.openWindow(profileId, pr.url, 'slack')} />
              </span>
              <span className="ml-auto shrink-0 text-xs text-subtle tabular-nums">{formatDate(pr.mergedAt, { hour: 'numeric', minute: '2-digit' })}</span>
            </span>
            <span className="pointer-events-none line-clamp-2 text-sm text-muted">{pr.title}</span>
            <span className="pointer-events-none mt-1 flex flex-wrap items-center gap-1.5">
              <Badge tone="accent">{t('pr.merged.badge')}</Badge>
              <BaseChip base={pr.base} />
              {reported && (
                <span className="text-xs tabular-nums">
                  <span className="text-success">+{formatNumber(pr.additions ?? 0)}</span> <span className="text-danger">−{formatNumber(pr.deletions ?? 0)}</span>
                </span>
              )}
              <span className="ml-auto text-xs text-subtle">{pr.author}</span>
            </span>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT}>
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => void window.hub.codeHost.openExternal(profileId, pr.url)}>
              <ExternalLink className="size-4 text-muted" aria-hidden />
              {t('pr.menu.openBrowser')}
            </ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} onSelect={open}>
              <AppWindow className="size-4 text-muted" aria-hidden />
              {t('pr.menu.openWindow')}
            </ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => void navigator.clipboard.writeText(pr.url).then(() => notify(t('pr.detail.linkCopied')))}>
              <Link className="size-4 text-muted" aria-hidden />
              {t('pr.detail.copyLink')}
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </li>
  )
}

/** Rows drawn at first, and added per "Show more": thousands of rows (each with its menu and Slack badge) make the list slow. */
export const MERGED_ROWS_PAGE = 200

/** The merged list: sticky day headers ("Today", "Yesterday", "Thu, Nov 12" and how many merged), or plain rows in repository order. */
export function MergedRows({ view, profileId, query, onClearSearch }: { view: MergedView; profileId: string | null; query: string; onClearSearch: () => void }) {
  const { t, tn, formatDate, formatNumber } = useI18n()
  const byRepo = view.ui.narrowing.order === 'repo'
  // A new search, filter, order, period or Who starts again at the first page; a background refresh keeps what was opened.
  const listKey = `${query}|${JSON.stringify(view.ui.narrowing)}|${view.ui.period}|${view.ui.from}|${view.ui.to}|${view.ui.who}|${view.ui.profiles}`
  const [page, setPage] = useState({ key: listKey, limit: MERGED_ROWS_PAGE })
  const limit = page.key === listKey ? page.limit : MERGED_ROWS_PAGE
  const groups = useMemo(() => (byRepo ? [] : firstRows(groupByDay(view.visible), limit)), [byRepo, view.visible, limit])
  const left = view.visible.length - limit
  const more =
    left > 0 ? (
      <div className="flex justify-center py-3">
        <Button size="sm" onClick={() => setPage({ key: listKey, limit: limit + MERGED_ROWS_PAGE })}>
          {t('pr.merged.showMore', { count: formatNumber(Math.min(left, MERGED_ROWS_PAGE)), total: formatNumber(left) })}
        </Button>
      </div>
    ) : null
  const today = dayStart(Date.now())
  const dayLabel = (start: number) => (start === today ? t('pr.merged.today') : start === dayStart(today - 1) ? t('pr.merged.yesterday') : formatDate(start, { weekday: 'short', month: 'short', day: 'numeric' }))
  const row = (pr: MergedPullRequest) => <MergedRow key={pr.url} pr={pr} profileId={profileId} selected={pr.url === view.selected?.url} onSelect={() => view.select(pr.url)} />

  if (view.ui.period === 'custom' && !view.period) return null
  if (!view.hasData && view.failure === null) {
    return <div className="px-3 py-6 text-center text-sm text-muted" role="status">{t('pr.merged.loading.first')}</div>
  }
  if (view.visible.length === 0) {
    const narrowed = query.trim() !== '' || view.current.length > 0
    return view.failure && !view.hasData ? null : (
      <EmptyState
        compact
        icon={<GitPullRequest className="size-4" aria-hidden />}
        title={narrowed ? t('pr.empty.filtered.title') : t('pr.merged.empty.title')}
        description={narrowed ? t('pr.merged.empty.filtered.description') : t('pr.merged.empty.description')}
        action={
          narrowed ? (
            <Button size="sm" onClick={() => (query ? onClearSearch() : view.clearFilters())}>
              {query ? t('pr.clearSearch') : t('pr.merged.clearFilters')}
            </Button>
          ) : undefined
        }
      />
    )
  }
  return byRepo ? (
    <>
      <ul aria-label={t('pr.merged.list')} className="flex flex-col gap-0.5">
        {view.visible.slice(0, limit).map(row)}
      </ul>
      {more}
    </>
  ) : (
    <div aria-label={t('pr.merged.list')} role="group">
      {groups.map((g) => (
        <section key={g.start} aria-label={dayLabel(g.start)}>
          <h3 className="sticky top-0 z-10 flex items-baseline justify-between bg-bg px-1.5 pt-3 pb-1.5 text-xs font-semibold text-subtle">
            <span>{dayLabel(g.start)}</span>
            <span className="font-normal tabular-nums">{tn('pr.merged.dayCount', g.total)}</span>
          </h3>
          <ul className="flex flex-col gap-0.5">{g.items.map(row)}</ul>
        </section>
      ))}
      {more}
    </div>
  )
}
