import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PullRequestItem, PullRequestStatus } from '@workhub/core'
import type { CodeHostLists } from '../../shared/codehost-api'
import { REMOTE_FEATURES, type RemotePullRequestList, type RemotePullRequestsPage } from '../../shared/remote-api'
import { cachedPullRequests, PR_LISTS, prFailed, prLoaded, prLoading, prStateFrom, prTitleParts, type PrListState, type PrPagesState } from '../pr-pages'
import { Spinner } from '../../renderer/components/atoms'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import type { MessageKey } from '../../renderer/i18n/translate'
import { safeHref } from '../../renderer/components/molecules/Markdown'
import { cn } from '../../renderer/lib/cn'
import { useClient, useClientStatus, useConfig, useProfileId, useRemoteData } from '../app-context'
import { Body, Empty, Header, Screen, SectionTitle } from '../ui'
import { ProfilePicker } from './ProfilePicker'

const STATUS_TONE: Record<PullRequestStatus, string> = {
  merged: 'bg-accent-2/15 text-accent-2',
  closed: 'bg-surface-hover text-muted',
  conflicts: 'bg-danger-soft text-danger',
  ciFailed: 'bg-danger-soft text-danger',
  changesRequested: 'bg-warning-soft text-warning',
  approved: 'bg-success-soft text-success',
  draft: 'bg-surface-hover text-muted',
  ciRunning: 'bg-info-soft text-info',
  waitingReview: 'bg-surface-hover text-muted'
}

/** The words of each state, the same ones the desktop uses. */
const STATUS_LABEL: Record<PullRequestStatus, MessageKey> = {
  merged: 'pr.status.merged',
  closed: 'pr.status.closed',
  conflicts: 'pr.status.conflicts',
  ciFailed: 'pr.status.ciFailed',
  changesRequested: 'pr.status.changesRequested',
  draft: 'pr.status.draft',
  approved: 'pr.status.approved',
  ciRunning: 'pr.status.ciRunning',
  waitingReview: 'pr.status.waitingReview'
}

const ROW = 'flex items-start gap-3 px-4 py-3 active:bg-surface-hover'

function PrRow({ item }: { item: PullRequestItem }) {
  const { t } = useI18n()
  const { pr, status } = item
  const href = safeHref(pr.url)
  const { key, title } = prTitleParts(pr.title, pr.isDraft)
  const state = pr.isDraft ? 'draft' : status
  const content = (
    <div className="min-w-0 flex-1">
      <div className="line-clamp-2 text-md font-medium break-words">{title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', STATUS_TONE[state] ?? 'bg-surface-hover text-muted')}>{t(STATUS_LABEL[state] ?? 'pr.status.waitingReview')}</span>
        <span className="font-mono">
          {pr.repo}#{pr.number}
        </span>
        {key && (
          <span className="rounded border border-border px-1.5 font-mono">{key}</span>
        )}
        <span>{pr.author}</span>
        <span className="font-mono">
          <span className="text-success">+{pr.additions}</span> <span className="text-danger">−{pr.deletions}</span>
        </span>
      </div>
    </div>
  )
  return (
    <li>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={ROW}>
          {content}
          <ExternalLink className="mt-1 size-4 shrink-0 text-subtle" aria-hidden />
        </a>
      ) : (
        <div className={ROW}>{content}</div>
      )}
    </li>
  )
}

/** Rows per page the phone asks a desktop that pages the lists for. */
export const PR_PAGE_LIMIT = 50

/** One list: its title with how many it holds, its rows, and while the desktop has more, a row that loads the next page. */
function PrSection({ list, state, count, online, onLoadMore }: { list: RemotePullRequestList; state: PrListState; count: number; online: boolean; onLoadMore: (list: RemotePullRequestList) => void }) {
  const { t } = useI18n()
  return (
    <section data-testid={`prs-${list}`}>
      <SectionTitle right={String(count)}>{t(list === 'mine' ? 'web.prs.mine' : 'web.prs.toReview')}</SectionTitle>
      {state.items.length === 0 && !state.cursor ? <div className="px-4 pb-3 text-sm text-muted">
          <p>{t('web.prs.empty')}</p>
          <p className="mt-0.5 text-xs">{t('web.prs.emptyHint')}</p>
        </div> : <ul className="divide-y divide-border">{state.items.map((i) => <PrRow key={i.pr.url} item={i} />)}</ul>}
      {state.cursor && (
        <div className="flex flex-col items-center gap-1 px-4 py-3">
          <button
            type="button"
            data-testid="load-more"
            onClick={() => onLoadMore(list)}
            disabled={state.loading || !online}
            className="flex min-h-11 items-center gap-2 rounded-full border border-border px-4 text-sm text-muted disabled:opacity-60"
          >
            {state.loading && <Spinner className="size-3.5" />}
            {state.loading ? t('web.prs.loadingMore') : t('web.prs.loadMore')}
          </button>
          <span className="text-xs text-muted">{t('web.prs.shown', { shown: String(state.items.length), total: String(count) })}</span>
        </div>
      )}
    </section>
  )
}

/** Both lists, each with its own title and "Load more". */
export function PullRequestLists({ state, online, onLoadMore }: { state: PrPagesState; online: boolean; onLoadMore: (list: RemotePullRequestList) => void }) {
  return (
    <>
      {PR_LISTS.map((list) => (
        <PrSection key={list} list={list} state={state[list]} count={state.counts[list]} online={online} onLoadMore={onLoadMore} />
      ))}
    </>
  )
}

/** The profile's pull requests as the desktop lists them: mine, and the ones waiting for my review. */
export function PullRequestsScreen() {
  const { t, formatDate } = useI18n()
  const client = useClient()
  const online = useClientStatus().state === 'online'
  const { config } = useConfig()
  const [profileId, setProfileId] = useProfileId(config)
  // A desktop that pages sends each list a page at a time (thousands of pull requests do not fit one relay frame).
  const paging = client.supports(REMOTE_FEATURES.paging)
  const firstArgs = paging ? [profileId, { limit: PR_PAGE_LIMIT }] : [profileId]
  const lists = useRemoteData<RemotePullRequestsPage | CodeHostLists>(
    paging ? 'remote:pullRequests' : 'codeHost:lists',
    firstArgs,
    () => (paging ? (client.transport.invoke('remote:pullRequests', ...firstArgs) as Promise<RemotePullRequestsPage>) : window.hub.codeHost.lists(profileId)),
    [profileId, paging],
    () => cachedPullRequests((channel, args) => client.cached(channel, args), profileId, firstArgs)
  )
  const generation = useRef(0)
  const [state, setState] = useState<PrPagesState | null>(null)
  // A fresh first page (a refresh, a reconnect, another profile) starts the lists over; a "Load more" still out belongs to the old one.
  useEffect(() => {
    generation.current++
    setState(lists.data ? prStateFrom(lists.data, generation.current) : null)
  }, [lists.data, profileId])
  const loadMore = async (list: RemotePullRequestList) => {
    const current = state
    const cursor = current?.[list].cursor
    if (!current || !cursor || current[list].loading || !online) return
    const gen = current.generation
    setState((s) => s && prLoading(s, list, gen))
    try {
      const answer = (await client.transport.invoke('remote:pullRequests', profileId, { list, limit: PR_PAGE_LIMIT, cursor })) as RemotePullRequestsPage
      setState((s) => s && prLoaded(s, list, gen, answer))
    } catch {
      setState((s) => s && prFailed(s, list, gen))
    }
  }
  const data = state?.lists
  return (
    <Screen>
      <Header title={t('web.prs.title')} subtitle={data?.updatedAt ? t('web.prs.updated', { when: formatDate(data.updatedAt, { hour: '2-digit', minute: '2-digit' }) }) : undefined} right={<ProfilePicker config={config} value={profileId} onChange={setProfileId} />} />
      <Body>
        {!state && lists.loading && <Spinner className="mx-auto mt-16 size-6" />}
        {lists.error && <p className="px-4 pt-4 text-sm text-danger">{t('web.prs.error', { message: lists.error })}</p>}
        {data?.state === 'notConnected' && <Empty title={t('web.prs.notConnected')} hint={t('web.prs.notConnectedHint')} />}
        {state && data && data.state !== 'notConnected' && (
          <>
            {data.message && data.state === 'error' && <p className="px-4 pt-4 text-sm text-danger">{t('web.prs.error', { message: data.message })}</p>}
            <PullRequestLists state={state} online={online} onLoadMore={(list) => void loadMore(list)} />
          </>
        )}
      </Body>
    </Screen>
  )
}
