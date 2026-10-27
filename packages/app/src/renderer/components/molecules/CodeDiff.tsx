import { useState } from 'react'
import type { DiffHunk, DiffLine } from '@workhub/core'
import { Button } from '../atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

const ROW: Record<DiffLine['kind'], string> = { added: 'bg-success-soft', removed: 'bg-danger-soft', context: '' }
const SIGN: Record<DiffLine['kind'], string> = { added: '+', removed: '−', context: ' ' }
const SIGN_COLOR: Record<DiffLine['kind'], string> = { added: 'text-success', removed: 'text-danger', context: 'text-subtle' }

/** Lines shown before "Show all": a long edit stays cheap to render. */
export const DIFF_PREVIEW_LINES = 300

/**
 * A unified diff (old → new) as plain text rows, no syntax highlighting. `numbered` shows line
 * numbers when they are the file's own (a reported patch), not the edited snippet's.
 */
export function CodeDiff({ hunks, numbered, label }: { hunks: DiffHunk[]; numbered: boolean; label: string }) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const total = hunks.reduce((n, h) => n + h.lines.length, 0)
  let budget = all ? Infinity : DIFF_PREVIEW_LINES
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface">
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full border-collapse font-mono text-chat-xs leading-[1.55]" aria-label={label}>
          <tbody>
            {hunks.map((hunk, hi) => {
              if (budget <= 0) return null
              const rows = []
              if (numbered || hunks.length > 1) {
                rows.push(
                  <tr key={`h${hi}`} className="bg-info-soft text-info">
                    <td colSpan={numbered ? 4 : 2} className="px-3 py-0.5 whitespace-pre">
                      {hunk.header}
                    </td>
                  </tr>
                )
              }
              for (const [li, line] of hunk.lines.entries()) {
                if (budget-- <= 0) break
                rows.push(
                  <tr key={`${hi}:${li}`} className={ROW[line.kind]}>
                    {numbered && <td className="w-10 pr-2 text-right align-top text-subtle tabular-nums select-none">{line.oldNumber ?? ''}</td>}
                    {numbered && <td className="w-10 pr-2 text-right align-top text-subtle tabular-nums select-none">{line.newNumber ?? ''}</td>}
                    <td className={cn('w-5 text-center align-top select-none', SIGN_COLOR[line.kind])}>{SIGN[line.kind]}</td>
                    <td className="pr-4 whitespace-pre-wrap break-all">{line.text === '' ? ' ' : line.text}</td>
                  </tr>
                )
              }
              return rows
            })}
          </tbody>
        </table>
      </div>
      {!all && total > DIFF_PREVIEW_LINES && (
        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-chat-xs text-muted">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {t('tool.showAll', { total })}
          </Button>
        </div>
      )}
    </div>
  )
}
