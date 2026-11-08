import { ExternalLink } from 'lucide-react'
import type { PullRequestItem } from '@workhub/core'
import type { CodeHostLists } from '../../shared/codehost-api'
import { Spinner } from '../../renderer/components/atoms'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { useConfig, useProfileId, useRemoteData } from '../app-context'
import { Body, Empty, Header, Screen, SectionTitle } from '../ui'
import { ProfilePicker } from './ProfilePicker'

const STATUS_TONE: Record<string, string> = {
  merged: 'bg-accent-2/15 text-accent-2',
  closed: 'bg-surface-hover text-muted',
  conflicts: 'bg-danger-soft text-danger',
  ciFailed: 'bg-danger-soft text-danger',
  changesRequested: 'bg-warning-soft text-warning',
  approved: 'bg-success-soft text-success',
  draft: 'bg-surface-hover text-muted'
}

function PrRow({ item }: { item: PullRequestItem }) {
  const { t } = useI18n()
  const { pr, status } = item
  return (
    <li>
      <a href={pr.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-3 px-4 py-3 active:bg-surface-hover">
        <div className="min-w-0 flex-1">
          <div className="truncate text-md font-medium">{pr.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
            <span className="font-mono">
              {pr.repo}#{pr.number}
            </span>
            <span>{pr.author}</span>
            <span className={cn('rounded-full px-2 py-px text-2xs font-semibold', STATUS_TONE[status] ?? 'bg-surface-hover text-muted')}>{pr.isDraft ? t('web.prs.draft') : status}</span>
            <span className="font-mono text-2xs">
              <span className="text-success">+{pr.additions}</span> <span className="text-danger">−{pr.deletions}</span>
            </span>
          </div>
        </div>
        <ExternalLink className="mt-1 size-4 shrink-0 text-subtle" aria-hidden />
      </a>
    </li>
  )
}

/** The profile's pull requests as the desktop lists them: mine, and the ones waiting for my review. */
export function PullRequestsScreen() {
  const { t, formatDate } = useI18n()
  const { config } = useConfig()
  const [profileId, setProfileId] = useProfileId(config)
  const lists = useRemoteData<CodeHostLists>('codeHost:lists', [profileId], () => window.hub.codeHost.lists(profileId), [profileId])
  const data = lists.data
  return (
    <Screen>
      <Header title={t('web.prs.title')} subtitle={data?.updatedAt ? t('web.prs.updated', { when: formatDate(data.updatedAt, { hour: '2-digit', minute: '2-digit' }) }) : undefined} right={<ProfilePicker config={config} value={profileId} onChange={setProfileId} />} />
      <Body>
        {!data && lists.loading && <Spinner className="mx-auto mt-16 size-6" />}
        {lists.error && <p className="px-4 pt-4 text-sm text-danger">{t('web.prs.error', { message: lists.error })}</p>}
        {data?.state === 'notConnected' && <Empty title={t('web.prs.notConnected')} />}
        {data && data.state !== 'notConnected' && (
          <>
            {data.message && data.state === 'error' && <p className="px-4 pt-4 text-sm text-danger">{t('web.prs.error', { message: data.message })}</p>}
            <SectionTitle right={String(data.mine.length)}>{t('web.prs.mine')}</SectionTitle>
            {data.mine.length === 0 ? <p className="px-4 pb-2 text-sm text-muted">{t('web.prs.empty')}</p> : <ul className="divide-y divide-border">{data.mine.map((i) => <PrRow key={i.pr.url} item={i} />)}</ul>}
            <SectionTitle right={String(data.toReview.length)}>{t('web.prs.toReview')}</SectionTitle>
            {data.toReview.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">{t('web.prs.empty')}</p> : <ul className="divide-y divide-border">{data.toReview.map((i) => <PrRow key={i.pr.url} item={i} />)}</ul>}
          </>
        )}
      </Body>
    </Screen>
  )
}
