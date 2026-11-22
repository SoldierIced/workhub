import { Check, Circle, CircleDot } from 'lucide-react'
import type { BoardListBlock, BoardStepsBlock, BoardTableBlock, BoardTextBlock, BoardTone } from '@workhub/core'
import { StateDot } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { columnPercents, boardTimeOptions, given, itemKey, TONE_DOT, TONE_ROW, TONE_TEXT } from '../../lib/boards'
import { cn } from '../../lib/cn'
import { relativeTime } from '../../lib/tickets'

const tone = (t: BoardTone | undefined): BoardTone => t ?? 'neutral'

const STEP_LABEL = {
  done: 'boards.steps.done',
  current: 'boards.steps.current',
  skipped: 'boards.steps.skipped',
  upcoming: 'boards.steps.upcoming'
} as const satisfies Record<string, MessageKey>

/** The mark of a stage: done, current, skipped and upcoming differ by shape and weight, not only by colour. */
function StepMark({ state }: { state: BoardStepsBlock['steps'][number]['state'] }) {
  if (state === 'done') return <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-surface"><Check className="size-2.5" strokeWidth={3} aria-hidden /></span>
  if (state === 'current') return <CircleDot className="size-4 shrink-0 text-accent" aria-hidden />
  if (state === 'skipped') return <span className="size-3 shrink-0 rounded-full border border-dashed border-border-strong" aria-hidden />
  return <Circle className="size-3 shrink-0 text-subtle" aria-hidden />
}

/**
 * The stages as one slim line: a mark per stage joined by a thin line, the current one in bold, and
 * how far the job is at the right. It scrolls sideways instead of growing when it does not fit.
 */
export function StepsBlock({ block, now }: { block: BoardStepsBlock; now: number }) {
  const { t, formatDate } = useI18n()
  const done = block.steps.filter((s) => s.state === 'done' || s.state === 'skipped').length
  const current = block.steps.findIndex((s) => s.state === 'current')
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <ol className="flex min-w-0 flex-1 items-center overflow-x-auto py-0.5">
          {block.steps.map((step, i) => (
            <li
              key={i}
              aria-current={step.state === 'current' ? 'step' : undefined}
              title={step.at !== undefined ? formatDate(step.at, boardTimeOptions(step.at, now)) : undefined}
              className="flex shrink-0 items-center"
            >
              {i > 0 && <span className={cn('mx-1.5 h-px w-5', block.steps[i - 1]!.state === 'done' ? 'bg-success' : 'bg-border-strong')} aria-hidden />}
              <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-sm', step.state === 'current' ? 'font-semibold text-text' : step.state === 'done' ? 'text-text' : 'text-muted', step.state === 'skipped' && 'line-through')}>
                <StepMark state={step.state} />
                {step.label}
                <span className="sr-only">({t(STEP_LABEL[step.state])})</span>
              </span>
            </li>
          ))}
        </ol>
        <span className="shrink-0 text-xs tabular-nums text-subtle">
          {current >= 0 ? t('boards.steps.progress', { n: current + 1, total: block.steps.length }) : t('boards.steps.doneOf', { n: done, total: block.steps.length })}
        </span>
      </div>
      {block.note && <p className="break-words text-xs text-muted">{block.note}</p>}
    </div>
  )
}

/** One row per item: who on the left, its state and what it does in the middle, how long ago on the right. */
export function ListBlock({ block, now }: { block: BoardListBlock; now: number }) {
  const { t, locale } = useI18n()
  if (block.items.length === 0) return <p className="py-2 text-sm text-muted">{given(block.empty) ?? t('boards.nothingYet')}</p>
  return (
    <ul className="flex flex-col divide-y divide-border">
      {block.items.map((item, i) => (
        <li key={itemKey(item, i)} className="grid grid-cols-1 gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <p className="break-words text-base font-medium [overflow-wrap:anywhere]">{item.label}</p>
            {item.detail && <p className="break-words text-sm text-muted [overflow-wrap:anywhere]">{item.detail}</p>}
          </div>
          <div className="min-w-0">
            {item.state && (
              <p className={cn('flex items-center gap-2 text-base', TONE_TEXT[tone(item.state.tone)])}>
                <StateDot tone={TONE_DOT[tone(item.state.tone)]} pulse={item.state.busy === true} />
                <span className="break-words [overflow-wrap:anywhere]">{item.state.label}</span>
              </p>
            )}
            {item.text && <p className="whitespace-pre-wrap break-words text-base text-text [overflow-wrap:anywhere]">{item.text}</p>}
          </div>
          {item.at !== undefined && <p className="whitespace-nowrap text-sm text-muted sm:text-right">{relativeTime(item.at, now, locale)}</p>}
        </li>
      ))}
    </ul>
  )
}

/** A header and rows; widths are proportions, a struck row is struck through and muted, a row's tone tints it. */
export function TableBlock({ block }: { block: BoardTableBlock }) {
  const { t } = useI18n()
  const widths = columnPercents(block.columns)
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full table-fixed border-collapse text-base">
        <colgroup>
          {widths.map((w, i) => (
            <col key={i} style={{ width: `${w}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-border-strong text-left text-sm text-muted">
            {block.columns.map((c, i) => (
              <th key={i} scope="col" className="break-words px-2 py-1.5 font-medium [overflow-wrap:anywhere]">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.length === 0 && (
            <tr>
              <td colSpan={block.columns.length} className="px-2 py-3 text-sm text-muted">
                {t('boards.table.empty')}
              </td>
            </tr>
          )}
          {block.rows.map((row, r) => (
            <tr key={r} className={cn('border-b border-border last:border-b-0', TONE_ROW[tone(row.tone)], row.struck || row.tone === 'muted' ? 'text-muted' : 'text-text')}>
              {row.cells.map((cell, c) => (
                <td key={c} className="whitespace-pre-wrap break-words px-2 py-1.5 align-top [overflow-wrap:anywhere]">
                  {row.struck ? <del>{cell}</del> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {block.note && <p className="whitespace-pre-wrap break-words text-sm text-muted">{block.note}</p>}
    </div>
  )
}

export function TextBlock({ block }: { block: BoardTextBlock }) {
  return <p className={cn('whitespace-pre-wrap break-words text-base [overflow-wrap:anywhere]', TONE_TEXT[tone(block.tone)])}>{block.text}</p>
}
