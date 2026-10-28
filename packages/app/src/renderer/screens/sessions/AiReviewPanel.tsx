import { ChevronRight, ScanSearch } from 'lucide-react'
import { useState } from 'react'
import { REVIEW_SEVERITIES, cycleRound, roundLimit, aiReviewSettings, type FindingStatus, type ReviewFinding, type ReviewSeverity, type ReviewStatus } from '@workhub/core'
import type { SessionView } from '@shared/api'
import type { AiReviewStartBlocker, AiReviewView, ReviewLoopPhase, ReviewLoopView } from '@shared/ai-review-api'
import { Badge, Button, Select, Spinner, Textarea, type Tone } from '../../components/atoms'
import { useToast } from '../../components/molecules'
import { useAiReviews, holdForSession, loopForSession, reviewForSession, useReviewLoops } from '../../aiReviewStore'
import { AgentReviewDialog } from './AgentReviewDialog'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { ESCALATION_TEXT } from '../../lib/useAiReviewNotices'
import { errorText } from '../../lib/errorText'
import { requestOpen } from '../../lib/continuity'
import { usageWindowName } from '../../lib/usage-window'
import { useAsyncAction } from '../../lib/useAsyncAction'

export const REVIEW_STATUS_TONE: Record<ReviewStatus, Tone> = {
  reviewing: 'info',
  awaitingFixes: 'warning',
  paused: 'danger',
  ready: 'success',
  failed: 'danger',
  stopped: 'neutral'
}

const BLOCKER_TEXT: Record<AiReviewStartBlocker, MessageKey> = {
  disabled: 'aiReview.blocked.disabled',
  notRepo: 'aiReview.blocked.notRepo',
  detached: 'aiReview.blocked.detached',
  noBase: 'aiReview.blocked.noBase',
  noCommits: 'aiReview.blocked.noCommits',
  running: 'aiReview.blocked.running',
  noReviewer: 'aiReview.blocked.noReviewer',
  budget: 'aiReview.blocked.budget',
  unknownSession: 'aiReview.blocked.unknownSession',
  reviewerSession: 'aiReview.blocked.reviewerSession'
}

const SEVERITY_TONE: Record<ReviewSeverity, Tone> = { blocker: 'danger', major: 'warning', minor: 'info', nit: 'neutral' }
const FINDING_STATES: FindingStatus[] = ['open', 'fixed', 'disputed', 'dismissed']

function useStartReview(view: SessionView) {
  const { t } = useI18n()
  const toast = useToast()
  const [pending, setPending] = useState(false)
  const run = async (override = false) => {
    if (pending) return
    setPending(true)
    try {
      const r = await window.hub.aiReview.start(view.id, override)
      if (!r.ok) toast(t(BLOCKER_TEXT[r.reason], { window: r.detail ?? '' }), r.reason === 'budget' ? undefined : 'danger')
    } catch (e) {
      toast(errorText(e), 'danger')
    } finally {
      setPending(false)
    }
  }
  return { run, pending }
}

/**
 * "Review before PR" in the session header: always offered on a live session. It opens the
 * "Review with another agent" dialog (the session's agent briefs a reviewer and the two loop over
 * the findings); the dialog can still start the automatic review loop on the session's own branch.
 */
export function AiReviewButton({ view, compact }: { view: SessionView; compact?: boolean }) {
  const { t } = useI18n()
  const snap = useAiReviews()
  const review = reviewForSession(snap, view)
  const { run, pending } = useStartReview(view)
  const [picking, setPicking] = useState(false)
  const loop = loopForSession(useReviewLoops(), view.id)
  const reviewing = review?.status === 'reviewing' || (loop !== undefined && !LOOP_ENDED.includes(loop.phase))
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        data-testid="ai-review-start"
        title={compact ? `${t('aiReview.button')}\n${t('aiReview.buttonHint')}` : t('aiReview.buttonHint')}
        aria-label={compact ? t('aiReview.button') : undefined}
        className={compact ? 'px-1.5' : undefined}
        disabled={pending}
        icon={reviewing || pending ? <Spinner className="size-3" /> : <ScanSearch className="size-3.5" aria-hidden />}
        onClick={() => setPicking(true)}
      >
        {!compact && t('aiReview.button')}
      </Button>
      <AgentReviewDialog view={view} open={picking} onOpenChange={setPicking} onLoop={() => void run()} />
    </>
  )
}

const LOOP_ENDED: ReviewLoopPhase[] = ['approved', 'maxRounds', 'stopped', 'failed']
const LOOP_TONE: Record<ReviewLoopPhase, Tone> = { briefing: 'info', starting: 'info', reviewing: 'info', fixing: 'warning', approved: 'success', maxRounds: 'danger', stopped: 'neutral', failed: 'danger' }

/** Where a "Review with another agent" loop is, in both of its chats: round, who it waits on, Stop. */
export function ReviewLoopCard({ loop, sessionId }: { loop: ReviewLoopView; sessionId: string }) {
  const { t } = useI18n()
  const dismiss = useAsyncAction(() => window.hub.aiReview.dismissLoop(loop.id))
  const stopLoop = useAsyncAction(() => window.hub.aiReview.stopLoop(loop.id))
  const ended = LOOP_ENDED.includes(loop.phase)
  const other = sessionId === loop.authorSessionId ? loop.reviewerSessionId : loop.authorSessionId
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" data-testid="review-loop">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{t('agentReview.loop.title', { reviewer: loop.reviewerLabel })}</span>
        <Badge tone={LOOP_TONE[loop.phase]} data-testid="review-loop-phase">
          {!ended && <Spinner className="mr-1 size-2.5" />}
          {t(`agentReview.phase.${loop.phase}`)}
        </Badge>
      </div>
      {loop.round > 0 && <div className="text-xs text-subtle">{t('aiReview.round', { n: loop.round, max: loop.maxRounds })}</div>}
      {loop.phase === 'stopped' && loop.stoppedBy === 'cancelled' && <p className="text-xs text-subtle">{t('agentReview.stoppedByCancel')}</p>}
      {loop.phase === 'maxRounds' && <p className="text-xs text-subtle">{t('agentReview.maxRoundsHint')}</p>}
      {loop.failure && (
        <p className="text-xs break-words text-danger" data-testid="review-loop-failure">
          {t(`agentReview.failure.${loop.failure}`, { detail: loop.detail ?? '' })}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {other && (
          <Button size="sm" variant="ghost" onClick={() => requestOpen(other)}>
            {t(other === loop.reviewerSessionId ? 'agentReview.openReviewer' : 'agentReview.openAuthor')}
          </Button>
        )}
        {ended ? (
          <Button size="sm" variant="ghost" disabled={dismiss.pending} onClick={() => dismiss.run()}>
            {t('agentReview.dismiss')}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" data-testid="review-loop-stop" disabled={stopLoop.pending} onClick={() => stopLoop.run()}>
            {t('agentReview.stop')}
          </Button>
        )}
      </div>
    </div>
  )
}

function FindingRow({ review, f, selected, onSelect }: { review: AiReviewView; f: ReviewFinding; selected: boolean; onSelect: (on: boolean) => void }) {
  const { t } = useI18n()
  const setStatus = useAsyncAction((status: FindingStatus) => window.hub.aiReview.setFindingStatus(review.id, [f.id], status))
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" data-testid={`ai-finding-${f.id}`}>
      <div className="flex items-start gap-1.5">
        <input type="checkbox" className="mt-1" aria-label={t('aiReview.select', { id: f.id })} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        <span className="min-w-0 flex-1 break-words">
          <span className="font-mono text-xs text-subtle">{f.id}</span> {f.title}
        </span>
      </div>
      {f.file && (
        <div className="truncate font-mono text-xs text-subtle" title={f.file}>
          {f.file}
          {f.line ? `:${f.line}` : ''}
        </div>
      )}
      {f.why && <p className="text-xs text-muted">{f.why}</p>}
      {f.fix && <p className="text-xs">{f.fix}</p>}
      {f.disputeReason && <p className="text-xs text-warning">{t('aiReview.disputeReason', { reason: f.disputeReason })}</p>}
      <Select
        aria-label={t('aiReview.findingStatus', { id: f.id })}
        value={f.status}
        onChange={(v) => setStatus.run(v as FindingStatus)}
        disabled={setStatus.pending}
        options={FINDING_STATES.map((s) => ({ value: s, label: t(`aiReview.findingState.${s}`) }))}
        className="h-7 text-xs"
      />
    </li>
  )
}

/** The Review panel of a dev session: rounds, findings by severity and the user's controls. */
export function AiReviewSection({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const dismissHold = useAsyncAction((identity: string) => window.hub.aiReview.dismissHold(identity))
  const resume = useAsyncAction((reviewId: string) => window.hub.aiReview.continue(reviewId))
  const dismissFindings = useAsyncAction((reviewId: string, ids: string[]) => window.hub.aiReview.setFindingStatus(reviewId, ids, 'dismissed'))
  const stopReview = useAsyncAction((reviewId: string) => window.hub.aiReview.stop(reviewId))
  const toast = useToast()
  const snap = useAiReviews()
  const config = useConfig()
  const review = reviewForSession(snap, view)
  const hold = holdForSession(snap, view)
  const loop = loopForSession(useReviewLoops(), view.id)
  const { run } = useStartReview(view)
  const [selected, setSelected] = useState<string[]>([])
  const [opinion, setOpinion] = useState('')
  if (!review && !hold && !loop) return null
  const profile = config?.config.profiles.find((p) => p.id === (review?.profileId ?? view.profileId ?? config.config.activeProfileId))
  const settings = aiReviewSettings(profile)
  const round = review?.rounds.at(-1)
  const sendOpinion = async () => {
    if (!review || !opinion.trim()) return
    await window.hub.aiReview.opinion(review.id, opinion)
    setOpinion('')
    toast(t('aiReview.opinionSent'))
  }
  return (
    <details open className="group mt-4 border-t border-border pt-3" data-testid="ai-review-panel">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted select-none hover:text-text">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        {t('aiReview.panel')}
        {review && (
          <Badge tone={REVIEW_STATUS_TONE[review.status]} className="ml-auto" data-testid="ai-review-status">
            {t(`aiReview.status.${review.status}`)}
          </Badge>
        )}
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-sm">
        {loop && <ReviewLoopCard loop={loop} sessionId={view.id} />}
        {hold && (
          <div role="alert" className="flex flex-col gap-1.5 rounded-md bg-warning-soft px-2 py-1.5 text-warning" data-testid="ai-review-hold">
            <span>{t('aiReview.held', { percent: Math.round(hold.budget.percent ?? 0), window: hold.budget.window ? usageWindowName(hold.budget.window, t) : '', ceiling: hold.budget.ceiling ?? '' })}</span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="primary" onClick={() => void run(true)}>
                {t('aiReview.runAnyway')}
              </Button>
              <Button size="sm" variant="ghost" disabled={dismissHold.pending} onClick={() => dismissHold.run(hold.devIdentity)}>
                {t('aiReview.dismissHold')}
              </Button>
            </div>
          </div>
        )}
        {review && (
          <>
            <div className="text-xs text-subtle">
              <div className="truncate font-mono" title={review.branch}>
                {t('aiReview.branch', { branch: review.branch, base: review.baseRef })}
              </div>
              {round && <div>{t('aiReview.round', { n: cycleRound(review, round.n), max: roundLimit(review, settings) })}</div>}
            </div>
            {review.status === 'paused' && review.escalation && (
              <div role="alert" className="rounded-md bg-danger-soft px-2 py-1.5 text-danger" data-testid="ai-review-escalation">
                {t(ESCALATION_TEXT[review.escalation.reason])}
                {review.escalation.detail && <p className="mt-1 text-xs break-words">{review.escalation.detail}</p>}
              </div>
            )}
            {round?.error && <p className="text-xs text-danger">{t('aiReview.error', { message: round.error })}</p>}
            {round?.uncommitted && <p className="text-xs text-warning">{t('aiReview.uncommitted')}</p>}
            {round?.baseNote && <p className="text-xs text-warning" data-testid="ai-review-base-note">{round.baseNote}</p>}
            {round?.modelNote && <p className="text-xs text-warning" data-testid="ai-review-model-note">{round.modelNote}</p>}
            {round?.summary && (
              <div>
                <div className="text-xs text-muted">{t('aiReview.summary')}</div>
                <p className="text-xs break-words">{round.summary}</p>
                {round.scope && <p className="mt-0.5 text-xs text-subtle">{t(`aiReview.scope.${round.scope.assessment}`)}</p>}
              </div>
            )}
            {round && !round.parsed && round.raw && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted">{t('aiReview.raw')}</summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words">{round.raw}</pre>
              </details>
            )}
            {review.findings.length === 0 && round?.parsed && <p className="text-xs text-subtle">{t('aiReview.noFindings')}</p>}
            {REVIEW_SEVERITIES.map((sev) => {
              const list = review.findings.filter((f) => f.severity === sev)
              if (!list.length) return null
              const open = list.filter((f) => f.status === 'open').length
              return (
                <section key={sev} aria-label={t(`aiReview.severity.${sev}`)}>
                  <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
                    <Badge tone={SEVERITY_TONE[sev]}>{t(`aiReview.severity.${sev}`)}</Badge>
                    <span className="ml-auto text-subtle tabular-nums">
                      {open}/{list.length}
                    </span>
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {list.map((f) => (
                      <FindingRow key={f.id} review={review} f={f} selected={selected.includes(f.id)} onSelect={(on) => setSelected(on ? [...selected, f.id] : selected.filter((x) => x !== f.id))} />
                    ))}
                  </ul>
                </section>
              )
            })}
            <div className="flex flex-wrap gap-1.5">
              {review.status === 'paused' && (
                <Button size="sm" variant="primary" title={t('aiReview.continueHint')} data-testid="ai-review-continue" disabled={resume.pending} onClick={() => resume.run(review.id)}>
                  {t('aiReview.continue')}
                </Button>
              )}
              {selected.length > 0 && (
                <Button
                  size="sm"
                  disabled={dismissFindings.pending}
                  onClick={() => {
                    dismissFindings.run(review.id, selected)
                    setSelected([])
                  }}
                >
                  {t('aiReview.dismissSelected')}
                </Button>
              )}
              {review.status !== 'reviewing' && (
                <Button size="sm" variant="ghost" onClick={() => void run()}>
                  {t('aiReview.runAgain')}
                </Button>
              )}
              {review.status !== 'stopped' && (
                <Button size="sm" variant="ghost" disabled={stopReview.pending} onClick={() => stopReview.run(review.id)}>
                  {t('aiReview.stop')}
                </Button>
              )}
            </div>
            {review.status !== 'stopped' && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted" htmlFor={`ai-opinion-${view.id}`}>
                  {t('aiReview.opinion')}
                </label>
                <Textarea id={`ai-opinion-${view.id}`} rows={2} value={opinion} onChange={(e) => setOpinion(e.target.value)} data-testid="ai-review-opinion" />
                <p className="text-xs text-subtle">{t('aiReview.opinionHint')}</p>
                <Button size="sm" disabled={!opinion.trim()} onClick={() => void sendOpinion()}>
                  {t('aiReview.opinionSend')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  )
}

/** The Review panel on its own, for sessions without a monitor (terminal agents). */
export function AiReviewAside({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const snap = useAiReviews()
  const loop = loopForSession(useReviewLoops(), view.id)
  if (!reviewForSession(snap, view) && !holdForSession(snap, view) && !loop) return null
  return (
    <aside aria-label={t('aiReview.panel')} className="w-72 shrink-0 overflow-y-auto border-l border-border bg-sidebar px-4 py-1">
      <AiReviewSection view={view} />
    </aside>
  )
}
