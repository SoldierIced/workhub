import { ArrowRight, GitPullRequest } from 'lucide-react'
import { prName, type PullRequestItem } from '@workhub/core'
import type { CodeHostLists } from '@shared/codehost-api'
import { Button, Spinner } from '../../components/atoms'
import { Card, CardBody, CardHeader, ListRow, SlackBadge, StatTile } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { installUrl, loginCommand } from '../../lib/pullRequests'
import { usePullRequestSlack } from '../../lib/slackLinks'
import { StatusBadge } from './PrBadges'

/** Why the lists are not there, in a short line for a Home card or tile. */
export function useUnavailableReason(lists: CodeHostLists | null): string | null {
  const { t } = useI18n()
  if (!lists || lists.state === 'ready') return null
  const cli = lists.cli ?? 'gh'
  switch (lists.state) {
    case 'notConnected':
      return t('home.notConnected.codeHost')
    case 'missingCli':
      return `${t('pr.missingCli.title', { cli })} (${installUrl(cli)})`
    case 'signedOut':
      return t('pr.signedOut.description', { command: loginCommand(cli) })
    default:
      return lists.message ?? t('pr.error.title')
  }
}

export type PullRequestTileKind = 'mine' | 'toReview'
const TILE_LABEL: Record<PullRequestTileKind, MessageKey> = { mine: 'home.myOpenPrs', toReview: 'home.waitingReview' }

/** "My open pull requests" / "Waiting for my review" counters. */
export function PullRequestTile({ kind, lists, loading }: { kind: PullRequestTileKind; lists: CodeHostLists | null; loading: boolean }) {
  const { t } = useI18n()
  const reason = useUnavailableReason(lists)
  const count = lists && lists.state === 'ready' ? lists[kind].length : null
  return (
    <StatTile
      label={t(TILE_LABEL[kind])}
      value={count}
      loading={loading && lists === null}
      caption={count === null ? (reason ?? t('pr.home.loading')) : kind === 'mine' ? t('pr.home.countCaption') : t('pr.home.countReviewCaption')}
    />
  )
}

export interface PullRequestCardProps {
  kind: PullRequestTileKind
  /** For the Slack badge, which opens the PR's window on its Slack tab. */
  profileId: string | null
  lists: CodeHostLists | null
  onOpenPullRequest: (url: string) => void
  onOpenAll: () => void
  onOpenSettings: (tab?: string) => void
}

const LIMIT = 5

/** A Home list of pull requests: the first few, each opening in the Pull requests screen. */
export function PullRequestCard({ kind, profileId, lists, onOpenPullRequest, onOpenAll, onOpenSettings }: PullRequestCardProps) {
  const { t, tn } = useI18n()
  const reason = useUnavailableReason(lists)
  const items: PullRequestItem[] = lists && lists.state === 'ready' ? lists[kind].filter((i) => !i.stale || kind === 'toReview') : []
  return (
    <Card>
      <CardHeader
        title={t(kind === 'mine' ? 'pr.home.title' : 'pr.home.review')}
        icon={<GitPullRequest className="size-4" aria-hidden />}
        actions={
          items.length > 0 ? (
            <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={onOpenAll}>
              {t('pr.home.viewAll')}
              <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {lists === null ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-3.5" /> {t('pr.home.loading')}
          </p>
        ) : reason ? (
          <div className="flex items-center justify-between gap-3 rounded-md bg-surface-hover/60 px-3 py-2.5 text-sm">
            <span className="text-muted">{reason}</span>
            {lists.state === 'notConnected' && (
              <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={() => onOpenSettings('connections')}>
                {t('home.openSettings')}
                <ArrowRight className="size-3.5" aria-hidden />
              </Button>
            )}
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-subtle">{t(kind === 'mine' ? 'pr.home.none' : 'pr.home.noneReview')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.slice(0, LIMIT).map((item) => (
              <HomePullRequestRow key={item.pr.url} item={item} profileId={profileId} showAuthor={kind === 'toReview'} onOpen={() => onOpenPullRequest(item.pr.url)} />
            ))}
            {items.length > LIMIT && <li className="px-1.5 text-xs text-subtle">{tn('home.more', items.length - LIMIT)}</li>}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

/** A Home PR row; the Slack badge sits beside the row's button, not inside it. */
function HomePullRequestRow({ item, profileId, showAuthor, onOpen }: { item: PullRequestItem; profileId: string | null; showAuthor: boolean; onOpen: () => void }) {
  const slack = usePullRequestSlack(item.pr.url)
  return (
    <li className="flex items-center gap-1">
      <ListRow
        className="min-w-0 flex-1 px-1.5"
        title={item.pr.title}
        subtitle={`${prName(item.pr, item.pr.provider)}${showAuthor ? ` · ${item.pr.author}` : ''}`}
        trailing={<StatusBadge status={item.status} />}
        onClick={onOpen}
      />
      <SlackBadge summary={slack.summary} onOpen={() => void window.hub.codeHost.openWindow(profileId, item.pr.url, 'slack')} />
    </li>
  )
}
