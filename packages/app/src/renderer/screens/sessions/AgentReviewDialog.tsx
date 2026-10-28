import { useEffect, useState } from 'react'
import { MAX_REVIEW_ROUNDS, MIN_REVIEW_ROUNDS } from '@workhub/core'
import type { SessionView } from '@shared/api'
import type { AgentReviewBlocker, AgentReviewOptions } from '@shared/ai-review-api'
import { AgentIcon, Button, Input, Select, Spinner, Textarea } from '../../components/atoms'
import { Dialog, Field, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { errorText } from '../../lib/errorText'

/** Every reason the loop did not start, as an actionable message (`{detail}` names the agent or the usage window). */
export const AGENT_REVIEW_ERROR: Record<AgentReviewBlocker, MessageKey> = {
  unknownSession: 'agentReview.error.unknownSession',
  reviewerSession: 'agentReview.error.reviewerSession',
  notChat: 'agentReview.error.notChat',
  authorBusy: 'agentReview.error.authorBusy',
  running: 'agentReview.error.running',
  noReviewer: 'agentReview.error.noReviewer',
  reviewerMissing: 'agentReview.error.reviewerMissing',
  budget: 'agentReview.error.budget',
  badRequest: 'agentReview.error.badRequest'
}

const clampRounds = (n: number, fallback: number) => (Number.isFinite(n) ? Math.min(MAX_REVIEW_ROUNDS, Math.max(MIN_REVIEW_ROUNDS, Math.round(n))) : fallback)

/**
 * "Review with another agent": an editable brief prompt for the session's own agent, the reviewer
 * and the round limit. Main sends the prompt to this session, hands the brief to the reviewer and
 * runs the correction loop; the Review panel shows where it is. `onLoop` runs the automatic
 * review loop on the session's own branch instead.
 */
export function AgentReviewDialog({ view, open, onOpenChange, onLoop }: { view: SessionView; open: boolean; onOpenChange: (open: boolean) => void; onLoop: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [options, setOptions] = useState<AgentReviewOptions | null>(null)
  const [loading, setLoading] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [reviewerKey, setReviewerKey] = useState('')
  const [rounds, setRounds] = useState(3)
  const [error, setError] = useState<{ text: string; budget: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setLoading(true)
    let alive = true
    void window.hub.aiReview
      .loopOptions(view.id)
      .then(
        (o) => {
          if (!alive) return
          setOptions(o)
          setPrompt(o?.briefPrompt ?? '')
          setRounds(o?.maxRounds ?? 3)
          setReviewerKey((k) => (o?.reviewers.some((r) => r.key === k) ? k : (o?.defaultReviewerKey ?? '')))
        },
        (e: unknown) => alive && setError({ text: errorText(e), budget: false })
      )
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, view.id])

  const reviewer = options?.reviewers.find((r) => r.key === reviewerKey)
  const canStart = !busy && !loading && reviewer !== undefined && reviewer.installed && prompt.trim() !== ''

  const start = async (override = false) => {
    if (!canStart) return
    setError(null)
    setBusy(true)
    try {
      const r = await window.hub.aiReview.startLoop(view.id, { reviewerKey, prompt, maxRounds: rounds, ...(override ? { override } : {}) })
      if (!r.ok) {
        setError({ text: t(AGENT_REVIEW_ERROR[r.reason], { detail: r.detail ?? '' }), budget: r.reason === 'budget' })
        return
      }
      onOpenChange(false)
      toast(t('agentReview.started', { reviewer: reviewer?.label ?? '' }))
    } catch (e) {
      setError({ text: errorText(e), budget: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('agentReview.title')}
      description={t('agentReview.description')}
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            title={t('agentReview.loopHint')}
            data-testid="agent-review-loop"
            onClick={() => {
              onOpenChange(false)
              onLoop()
            }}
          >
            {t('agentReview.loop')}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canStart} data-testid="agent-review-start" icon={busy ? <Spinner className="size-3" /> : undefined} onClick={() => void start()}>
            {t('agentReview.start')}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="size-3" /> {t('agentReview.loading')}
        </p>
      ) : (
        <form
          className="flex flex-col gap-4"
          data-testid="agent-review-dialog"
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          <Field label={t('agentReview.prompt')} hint={t('agentReview.promptHint')}>
            <Textarea rows={12} value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false} data-testid="agent-review-prompt" />
          </Field>
          <div className="grid grid-cols-[1fr_8rem] gap-4">
            <Field
              label={t('agentReview.reviewer')}
              hint={
                !options?.reviewers.length ? (
                  t('agentReview.noReviewers')
                ) : reviewer && !reviewer.installed ? (
                  <span className="text-warning">{t('agentReview.error.reviewerMissing', { detail: reviewer.label })}</span>
                ) : undefined
              }
            >
              <Select
                aria-label={t('agentReview.reviewer')}
                value={reviewerKey}
                onChange={setReviewerKey}
                placeholder={t('agentReview.noReviewers')}
                options={(options?.reviewers ?? []).map((r) => ({
                  value: r.key,
                  icon: <AgentIcon agentId={r.agentId} adapter={r.adapter} />,
                  label: r.installed ? r.label : `${r.label} (${t('agentReview.notInstalled')})`
                }))}
              />
            </Field>
            <Field label={t('agentReview.rounds')} help={t('agentReview.roundsHelp')}>
              <Input type="number" min={MIN_REVIEW_ROUNDS} max={MAX_REVIEW_ROUNDS} value={rounds} onChange={(e) => setRounds(clampRounds(e.target.valueAsNumber, rounds))} data-testid="agent-review-rounds" />
            </Field>
          </div>
          {error && (
            <div role="alert" className="flex items-center gap-2 text-sm text-danger" data-testid="agent-review-error">
              <span className="min-w-0 flex-1">{error.text}</span>
              {error.budget && (
                <Button size="sm" variant="primary" onClick={() => void start(true)}>
                  {t('aiReview.runAnyway')}
                </Button>
              )}
            </div>
          )}
        </form>
      )}
    </Dialog>
  )
}
