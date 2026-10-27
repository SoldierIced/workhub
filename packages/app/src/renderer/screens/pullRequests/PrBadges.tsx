import { CircleAlert, CircleCheck, CircleDashed, CircleX, GitMerge, GitPullRequestDraft, Timer } from 'lucide-react'
import type { CiStatus, PullRequest, PullRequestStatus } from '@workhub/core'
import { Badge } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { CI_META, MERGE_META, REVIEW_META, STATUS_META } from '../../lib/pullRequests'

const CI_ICON: Record<CiStatus, typeof CircleCheck> = { success: CircleCheck, failure: CircleX, pending: Timer, none: CircleDashed }

/** The single summary badge of a PR (Workhub 1's colored status line). */
export function StatusBadge({ status }: { status: PullRequestStatus }) {
  const { t } = useI18n()
  const meta = STATUS_META[status]
  return <Badge tone={meta.tone}>{t(meta.label)}</Badge>
}

/** Review decision, CI and merge state of a PR, each as its own badge (the detail header). */
export function PrStateBadges({ pr }: { pr: Pick<PullRequest, 'reviewDecision' | 'ci' | 'mergeable' | 'isDraft' | 'state'> }) {
  const { t } = useI18n()
  const review = REVIEW_META[pr.reviewDecision]
  const ci = CI_META[pr.ci]
  const merge = MERGE_META[pr.mergeable]
  const CiIcon = CI_ICON[pr.ci]
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {pr.state === 'merged' && <Badge tone="accent" icon={<GitMerge className="size-3" aria-hidden />}>{t('pr.status.merged')}</Badge>}
      {pr.state === 'closed' && <Badge>{t('pr.status.closed')}</Badge>}
      {pr.isDraft && <Badge icon={<GitPullRequestDraft className="size-3" aria-hidden />}>{t('pr.draft')}</Badge>}
      <Badge tone={review.tone}>{t(review.label)}</Badge>
      <Badge tone={ci.tone} icon={<CiIcon className="size-3" aria-hidden />}>
        {t(ci.label)}
      </Badge>
      {pr.mergeable !== 'unknown' && (
        <Badge tone={merge.tone} icon={pr.mergeable === 'conflicting' ? <CircleAlert className="size-3" aria-hidden /> : undefined}>
          {t(merge.label)}
        </Badge>
      )}
    </div>
  )
}
