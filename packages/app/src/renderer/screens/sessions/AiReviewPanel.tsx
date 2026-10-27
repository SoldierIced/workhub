import { ChevronRight, ScanSearch } from 'lucide-react'
import { useState } from 'react'
import { REVIEW_SEVERITIES, roundLimit, aiReviewSettings, type FindingStatus, type ReviewFinding, type ReviewSeverity, type ReviewStatus } from '@workhub/core'
import type { SessionView } from '@shared/api'
import type { AiReviewStartBlocker, AiReviewView } from '@shared/ai-review-api'
import { Badge, Button, Select, Spinner, Textarea, type Tone } from '../../components/atoms'
import { useToast } from '../../components/molecules'
import { useAiReviews, holdForSession, reviewForSession } from '../../aiReviewStore'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { ESCALATION_TEXT } from '../../lib/useAiReviewNotices'

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
      toast(e instanceof Error ? e.message : String(e), 'danger')
    } finally {
      setPending(false)
    }
  }
  return { run, pending }
}

/** "Review before PR" in the session header: always offered on a live session (main says why when it cannot run). */
export function AiReviewButton({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const snap = useAiReviews()
  const review = reviewForSession(snap, view)
  const { run, pending } = useStartReview(view)
  const reviewing = review?.status === 'reviewing'
  return (
    <Button size="sm" variant="ghost" data-testid="ai-review-start" title={t('aiReview.buttonHint')} disabled={pending || reviewing} icon={reviewing || pending ? <Spinner className="size-3" /> : <ScanSearch className="size-3.5" aria-hidden />} onClick={() => void run()}>
      {t('aiReview.button')}
    </Button>
  )
}

function FindingRow({ review, f, selected, onSelect }: { review: AiReviewView; f: ReviewFinding; selected: boolean; onSelect: (on: boolean) => void }) {
  const { t } = useI18n()
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
        onChange={(v) => void window.hub.aiReview.setFindingStatus(review.id, [f.id], v as FindingStatus)}
        options={FINDING_STATES.map((s) => ({ value: s, label: t(`aiReview.findingState.${s}`) }))}
        className="h-7 text-xs"
      />
    </li>
  )
}

/** The Review panel of a dev session: rounds, findings by severity and the user's controls. */
export function AiReviewSection({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const toast = useToast()
  const snap = useAiReviews()
  const config = useConfig()
  const review = reviewForSession(snap, view)
  const hold = holdForSession(snap, view)
  const { run } = useStartReview(view)
  const [selected, setSelected] = useState<string[]>([])
  const [opinion, setOpinion] = useState('')
  if (!review && !hold) return null
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
        {hold && (
          <div role="alert" className="flex flex-col gap-1.5 rounded-md bg-warning-soft px-2 py-1.5 text-warning" data-testid="ai-review-hold">
            <span>{t('aiReview.held', { percent: Math.round(hold.budget.percent ?? 0), window: hold.budget.window ?? '', ceiling: hold.budget.ceiling ?? '' })}</span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="primary" onClick={() => void run(true)}>
                {t('aiReview.runAnyway')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void window.hub.aiReview.dismissHold(hold.devIdentity)}>
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
              {round && <div>{t('aiReview.round', { n: round.n, max: roundLimit(review, settings) })}</div>}
            </div>
            {review.status === 'paused' && review.escalation && (
              <div role="alert" className="rounded-md bg-danger-soft px-2 py-1.5 text-danger" data-testid="ai-review-escalation">
                {t(ESCALATION_TEXT[review.escalation.reason])}
                {review.escalation.detail && <p className="mt-1 text-xs break-words">{review.escalation.detail}</p>}
              </div>
            )}
            {round?.error && <p className="text-xs text-danger">{t('aiReview.error', { message: round.error })}</p>}
            {round?.uncommitted && <p className="text-xs text-warning">{t('aiReview.uncommitted')}</p>}
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
                <Button size="sm" variant="primary" title={t('aiReview.continueHint')} data-testid="ai-review-continue" onClick={() => void window.hub.aiReview.continue(review.id)}>
                  {t('aiReview.continue')}
                </Button>
              )}
              {selected.length > 0 && (
                <Button
                  size="sm"
                  onClick={() => {
                    void window.hub.aiReview.setFindingStatus(review.id, selected, 'dismissed')
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
                <Button size="sm" variant="ghost" onClick={() => void window.hub.aiReview.stop(review.id)}>
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
  if (!reviewForSession(snap, view) && !holdForSession(snap, view)) return null
  return (
    <aside aria-label={t('aiReview.panel')} className="w-72 shrink-0 overflow-y-auto border-l border-border bg-sidebar px-4 py-1">
      <AiReviewSection view={view} />
    </aside>
  )
}
