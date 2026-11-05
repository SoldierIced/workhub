import { Badge, TooltipProvider } from '../../components/atoms'
import { EmptyState, ToastProvider } from '../../components/molecules'
import { useReviewLoops } from '../../aiReviewStore'
import { I18nProvider, useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { usePlatform } from '../../lib/platform'
import { FindingPicker, LOOP_TONE } from './AiReviewPanel'

/** A "Review with another agent" loop in a window of its own: the findings to pick, at full size. */
export function ReviewLoopWindow({ loopId }: { loopId: string }) {
  const platform = usePlatform()
  return (
    <I18nProvider>
      <TooltipProvider>
        <Frame platform={platform} loopId={loopId} />
      </TooltipProvider>
    </I18nProvider>
  )
}

function Frame({ platform, loopId }: { platform: string; loopId: string }) {
  const { t } = useI18n()
  const loop = useReviewLoops().find((l) => l.id === loopId)
  return (
    <ToastProvider label={t('common.notifications')}>
      <div className="flex h-full flex-col bg-bg">
        <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
        <main className="mx-auto min-h-0 w-full max-w-4xl flex-1 overflow-y-auto px-6 pb-6" data-testid="review-loop-window">
          {!loop ? (
            <EmptyState title={t('agentReview.window.gone')} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{t('agentReview.loop.title', { reviewer: [loop.reviewerLabel, loop.reviewerModel].filter(Boolean).join(' · ') })}</h1>
                <Badge tone={LOOP_TONE[loop.phase]}>{t(`agentReview.phase.${loop.phase}`)}</Badge>
              </div>
              {loop.round > 0 && <div className="text-sm text-subtle">{t('aiReview.round', { n: loop.round, max: loop.maxRounds })}</div>}
              {loop.phase === 'awaitingApproval' ? (
                <FindingPicker key={`${loop.id}-${loop.round}`} loopId={loop.id} findings={loop.findings ?? []} review={loop.review ?? ''} roomy />
              ) : (
                <p className="text-sm text-muted">{t('agentReview.window.notWaiting')}</p>
              )}
            </div>
          )}
        </main>
      </div>
    </ToastProvider>
  )
}
