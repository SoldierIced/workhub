import { Check, MessageCircleQuestionMark } from 'lucide-react'
import { useState } from 'react'
import type { AgentQuestion } from '@workhub/core'
import { Button, Input } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { answersSummary, EMPTY_PICK, questionAnswers, togglePick, typeOther, type QuestionPick } from '../../lib/questions'

interface QuestionCardProps {
  questions: AgentQuestion[]
  /** Set once answered (or withdrawn: "—"). */
  answer?: string
  /** Sends the answers; `null` skips the questions. `label` is what the card shows once answered. */
  onSubmit: (answers: Record<string, string> | null, label: string) => void
}

/** A radio dot or a checkbox, drawn so it reads the same in both themes. */
function Mark({ on, multi }: { on: boolean; multi: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors',
        multi ? 'rounded-sm' : 'rounded-full',
        on ? 'border-accent bg-accent text-white' : 'border-border-strong bg-surface'
      )}
    >
      {on && (multi ? <Check className="size-3" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-white" />)}
    </span>
  )
}

/**
 * The questions an agent asks with choices (Claude Code's AskUserQuestion), answered in the chat:
 * one option each (or several on a multi-select), or the user's own words under "Other".
 */
export function QuestionCard({ questions, answer, onSubmit }: QuestionCardProps) {
  const { t } = useI18n()
  const [picks, setPicks] = useState<QuestionPick[]>(() => questions.map(() => EMPTY_PICK))
  const answers = questionAnswers(questions, picks)
  const set = (i: number, pick: QuestionPick) => setPicks((all) => all.map((p, j) => (j === i ? pick : p)))

  return (
    <div role="group" aria-label={t('chat.questionAsked')} className="ml-8 rounded-lg border border-warning/40 bg-warning-soft p-3" data-testid="chat-question">
      <div className="flex items-center gap-2 text-sm font-medium text-warning">
        <MessageCircleQuestionMark className="size-4" aria-hidden />
        {t('chat.questionAsked')}
      </div>
      {answer !== undefined ? (
        <>
          <ul className="mt-1.5 space-y-0.5 text-sm text-text">
            {questions.map((q) => (
              <li key={q.question} className="[overflow-wrap:anywhere]">
                {q.question}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-sm text-muted [overflow-wrap:anywhere]">{answer === '—' ? t('chat.permissionWithdrawn') : t('chat.answered', { answer })}</div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (answers) onSubmit(answers, answersSummary(questions, answers))
          }}
        >
          {questions.map((q, i) => {
            const pick = picks[i] ?? EMPTY_PICK
            const multi = q.multiSelect === true
            return (
              <fieldset key={q.question} className="mt-3 min-w-0 first-of-type:mt-2">
                <legend className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-medium text-text">
                  {q.header && <span className="rounded-sm bg-surface px-1.5 py-px text-2xs font-semibold tracking-wide text-muted uppercase">{q.header}</span>}
                  <span className="[overflow-wrap:anywhere]">{q.question}</span>
                </legend>
                {multi && <div className="mt-0.5 text-xs text-subtle">{t('chat.questionMulti')}</div>}
                <div className="mt-1.5 flex flex-col gap-1" role={multi ? 'group' : 'radiogroup'} aria-label={q.question}>
                  {q.options.map((o) => {
                    const on = pick.labels.includes(o.label)
                    return (
                      <button
                        key={o.label}
                        type="button"
                        role={multi ? 'checkbox' : 'radio'}
                        aria-checked={on}
                        onClick={() => set(i, togglePick(pick, o.label, multi))}
                        className={cn(
                          'flex w-full items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent',
                          on ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:border-border-strong'
                        )}
                      >
                        <Mark on={on} multi={multi} />
                        <span className="min-w-0">
                          <span className="block text-sm text-text [overflow-wrap:anywhere]">{o.label}</span>
                          {o.description && o.description !== o.label && <span className="block text-xs text-muted [overflow-wrap:anywhere]">{o.description}</span>}
                        </span>
                      </button>
                    )
                  })}
                  <Input
                    value={pick.other}
                    onChange={(e) => set(i, typeOther(pick, e.target.value, multi))}
                    placeholder={t('chat.questionOther')}
                    aria-label={t('chat.questionOtherLabel', { question: q.question })}
                    className={cn('h-8 text-sm', pick.other.trim() && 'border-accent')}
                  />
                </div>
              </fieldset>
            )
          })}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Button type="submit" size="sm" variant="primary" disabled={!answers}>
              {t('chat.questionSend')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => onSubmit(null, t('chat.questionSkipped'))}>
              {t('chat.questionSkip')}
            </Button>
            {!answers && <span className="text-xs text-subtle">{t(questions.length > 1 ? 'chat.questionPickEach' : 'chat.questionPickOne')}</span>}
          </div>
        </form>
      )}
    </div>
  )
}
