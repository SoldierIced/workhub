import { ScanSearch } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Spinner } from '../../renderer/components/atoms'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import type { MessageKey } from '../../renderer/i18n/translate'
import { cn } from '../../renderer/lib/cn'
import { REMOTE_FEATURES } from '../../shared/remote-api'
import type { RemoteReviewDecision, RemoteReviewDecisionRequest, RemoteReviewLoop, RemoteReviewState, RemoteBranchReview } from '../../shared/remote-changes-api'
import { useClient, useClientStatus } from '../app-context'

/**
 * The session's review and loop as the desktop last saw them, read again whenever `refresh`
 * changes (the session's state: a loop moves on when a turn ends) and after a decision. Null
 * while unknown, or on a desktop too old to say.
 */
export function useRemoteReview(sessionId: string, refresh: unknown): { state: RemoteReviewState | null; reload: () => void } {
  const client = useClient()
  const online = useClientStatus().state === 'online'
  const supported = client.supports(REMOTE_FEATURES.changes)
  const [state, setState] = useState<RemoteReviewState | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!supported || !online) return
    let alive = true
    ;(client.transport.invoke('remote:review', sessionId) as Promise<RemoteReviewState>).then(
      (next) => alive && setState(next),
      () => {}
    )
    return () => {
      alive = false
    }
  }, [client, sessionId, supported, online, refresh, tick])
  return { state, reload: useCallback(() => setTick((n) => n + 1), []) }
}

/** Whether the review or the loop waits for the person: what the chat shows a card for. */
export function reviewWaits(state: RemoteReviewState | null): boolean {
  return Boolean(state?.review?.decisions.length || state?.loop?.decisions.length)
}

function useDecide(sessionId: string, onDone: () => void) {
  const { t } = useI18n()
  const client = useClient()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const decide = async (request: RemoteReviewDecisionRequest) => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const done = (await client.transport.invoke('remote:reviewDecide', sessionId, request)) as boolean
      if (!done) setError(t('agentReview.pick.notWaiting'))
    } catch (err) {
      setError(t('web.review.failed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setPending(false)
      onDone()
    }
  }
  return { decide, pending, error }
}

const button = 'min-h-11 rounded-xl px-3 py-1 text-sm font-medium disabled:opacity-50'

function BranchReviewCard({ sessionId, review, onDone }: { sessionId: string; review: RemoteBranchReview; onDone: () => void }) {
  const { t, tn } = useI18n()
  const { decide, pending, error } = useDecide(sessionId, onDone)
  const can = (d: RemoteReviewDecision) => review.decisions.includes(d)
  const open = review.findings.filter((f) => f.status === 'open')
  return (
    <div className="flex flex-col gap-2" data-testid="remote-branch-review">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ScanSearch className="size-4 text-info" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('aiReview.panel')}</span>
        <span className={cn('text-xs', review.status === 'paused' ? 'text-danger' : 'text-muted')}>{t(`aiReview.status.${review.status}`)}</span>
      </div>
      <div className="truncate font-mono text-xs text-subtle">{t('aiReview.branch', { branch: review.branch, base: review.baseRef })}</div>
      {review.round > 0 && <div className="text-xs text-subtle">{t('web.review.round', { n: review.round })}</div>}
      {review.escalation && (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          {t(`aiReview.reason.${review.escalation.reason}` as MessageKey)}
          {review.escalation.detail && <p className="mt-1 [overflow-wrap:anywhere]">{review.escalation.detail}</p>}
        </div>
      )}
      {open.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {open.map((f) => (
            <li key={f.id} className="[overflow-wrap:anywhere]">
              <span className="font-mono text-subtle">{f.id}</span> <span className="text-muted">{t(`aiReview.severity.${f.severity}`)}</span> · {f.title}
            </li>
          ))}
        </ul>
      )}
      {review.omittedFindings ? <p className="text-xs text-subtle">{tn('web.review.omitted', review.omittedFindings)}</p> : null}
      {review.decisions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {can('continue') && (
            <button type="button" disabled={pending} title={t('aiReview.continueHint')} onClick={() => void decide({ target: 'review', decision: 'continue' })} className={cn(button, 'bg-accent text-accent-fg')}>
              {t('aiReview.continue')}
            </button>
          )}
          {can('stop') && (
            <button type="button" disabled={pending} onClick={() => void decide({ target: 'review', decision: 'stop' })} className={cn(button, 'border border-border-strong')}>
              {t('aiReview.stop')}
            </button>
          )}
          {pending && <Spinner className="size-4 self-center" />}
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

function LoopCard({ sessionId, loop, onDone }: { sessionId: string; loop: RemoteReviewLoop; onDone: () => void }) {
  const { t, tn } = useI18n()
  const { decide, pending, error } = useDecide(sessionId, onDone)
  const findings = loop.findings ?? []
  const ids = findings.length ? findings.map((f) => f.id) : ['all']
  const [keep, setKeep] = useState<Set<string>>(() => new Set(ids))
  const [note, setNote] = useState('')
  const toggle = (id: string, on: boolean) =>
    setKeep((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const can = (d: RemoteReviewDecision) => loop.decisions.includes(d)
  const count = keep.size
  return (
    <div className="flex flex-col gap-2" data-testid="remote-review-loop">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ScanSearch className="size-4 text-info" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('agentReview.loop.title', { reviewer: loop.reviewerLabel })}</span>
        <span className={cn('text-xs', loop.phase === 'awaitingApproval' ? 'text-warning' : 'text-muted')}>{t(`agentReview.phase.${loop.phase}`)}</span>
      </div>
      {loop.round > 0 && <div className="text-xs text-subtle">{t('aiReview.round', { n: loop.round, max: loop.maxRounds })}</div>}
      {can('approve') && (
        <>
          <div className="text-xs font-medium">{t('agentReview.pick.title')}</div>
          <p className="text-xs text-subtle">{t('agentReview.pick.hint')}</p>
          <ul className="flex flex-col gap-1.5">
            {findings.length === 0 ? (
              <li className="flex items-center gap-2 text-xs">
                <label className="flex min-h-11 flex-1 items-center gap-3 text-sm">
                  <input type="checkbox" className="size-5 shrink-0" checked={keep.has('all')} onChange={(e) => toggle('all', e.target.checked)} />
                  <span>{t('agentReview.pick.whole')}</span>
                </label>
              </li>
            ) : (
              findings.map((f) => (
                <li key={f.id} className="flex items-start gap-1 rounded-lg border border-border pr-2 text-xs">
                  <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                    <input type="checkbox" className="size-5" checked={keep.has(f.id)} onChange={(e) => toggle(f.id, e.target.checked)} aria-label={t('aiReview.select', { id: f.id })} />
                  </label>
                  <details className="min-w-0 flex-1">
                    <summary className="min-h-11 py-3 [overflow-wrap:anywhere]">
                      <span className="font-mono text-subtle">{f.id}</span> {f.title}
                    </summary>
                    <pre className="mt-1 font-sans whitespace-pre-wrap [overflow-wrap:anywhere] text-muted">{f.text}</pre>
                  </details>
                </li>
              ))
            )}
          </ul>
          {loop.omittedFindings ? <p className="text-xs text-subtle">{tn('web.review.omitted', loop.omittedFindings)}</p> : null}
          {loop.review && (
            <details className="text-xs">
              <summary className="min-h-11 py-3 text-muted">{t('agentReview.pick.showReview')}</summary>
              <pre className="mt-1 max-h-64 overflow-y-auto font-sans whitespace-pre-wrap [overflow-wrap:anywhere] text-muted">{loop.review}</pre>
            </details>
          )}
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('agentReview.pick.note')}
            aria-label={t('agentReview.pick.note')}
            className="rounded-xl border border-border-strong bg-bg px-3 py-2 text-md text-text"
          />
        </>
      )}
      {loop.decisions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {can('approve') && (
            <button
              type="button"
              disabled={pending || (count === 0 && !note.trim())}
              onClick={() => void decide({ target: 'loop', decision: 'approve', keep: ids.filter((id) => keep.has(id)), ...(note.trim() ? { note: note.trim() } : {}) })}
              className={cn(button, 'bg-accent text-accent-fg')}
            >
              {count === 0 ? t('agentReview.pick.sendNoteOnly') : tn('agentReview.pick.send', count)}
            </button>
          )}
          {can('stop') && (
            <button type="button" disabled={pending} onClick={() => void decide({ target: 'loop', decision: 'stop' })} className={cn(button, 'border border-border-strong')}>
              {t('agentReview.stop')}
            </button>
          )}
          {pending && <Spinner className="size-4 self-center" />}
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

/** The session's review and loop with the decisions the desktop offers while they wait for the person. */
export function ReviewCard({ sessionId, state, onDone, className }: { sessionId: string; state: RemoteReviewState; onDone: () => void; className?: string }) {
  if (!state.review && !state.loop) return null
  return (
    <section className={cn('flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3.5', className)} data-testid="remote-review">
      {state.loop && <LoopCard key={`${state.loop.phase}-${state.loop.round}`} sessionId={sessionId} loop={state.loop} onDone={onDone} />}
      {state.review && <BranchReviewCard sessionId={sessionId} review={state.review} onDone={onDone} />}
    </section>
  )
}
