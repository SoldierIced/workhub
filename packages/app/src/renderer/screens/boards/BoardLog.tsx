import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BoardLogBlock } from '@workhub/core'
import { Input } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { boardTimeOptions, given, hasDetailEntries, logRows, TONE_TEXT } from '../../lib/boards'
import { cn } from '../../lib/cn'

/**
 * A searchable log, newest first, in a box of bounded height. When entries arrive while the person
 * has scrolled down, the first row they can see stays where it was.
 */
export function BoardLog({ block, now, number }: { block: BoardLogBlock; now: number; number?: number }) {
  const { t, formatDate } = useI18n()
  const [query, setQuery] = useState('')
  const [details, setDetails] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ key: string; offset: number } | null>(null)
  const rows = useMemo(() => logRows(block.entries, query, details), [block.entries, query, details])
  const canFilterDetails = hasDetailEntries(block.entries)

  const capture = () => {
    const el = box.current
    if (!el || el.scrollTop <= 0) {
      anchor.current = null
      return
    }
    for (const row of el.querySelectorAll<HTMLElement>('[data-row]')) {
      if (row.offsetTop + row.offsetHeight > el.scrollTop) {
        anchor.current = { key: row.dataset.row ?? '', offset: row.offsetTop - el.scrollTop }
        return
      }
    }
    anchor.current = null
  }

  useLayoutEffect(() => {
    const el = box.current
    const held = anchor.current
    if (el && held && el.scrollTop > 0) {
      const row = [...el.querySelectorAll<HTMLElement>('[data-row]')].find((r) => r.dataset.row === held.key)
      if (row) el.scrollTop = row.offsetTop - held.offset
    }
    capture()
  }, [rows])

  const restart = () => {
    anchor.current = null
    if (box.current) box.current.scrollTop = 0
  }
  const title = given(block.title)
  const name = title ? t('boards.log.searchAria', { title }) : number ? t('boards.log.searchAriaNumbered', { n: number }) : t('boards.log.searchAriaUntitled')
  const blockName = title ?? (number ? t('boards.log.untitledNumbered', { n: number }) : t('boards.log.untitled'))
  const detailLabel = given(block.detailLabel) ?? t('boards.log.showDetails')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Input
          type="search"
          value={query}
          onChange={(e) => {
            restart()
            setQuery(e.target.value)
          }}
          placeholder={t('boards.log.search')}
          aria-label={name}
          className="w-64 max-w-full"
        />
        {canFilterDetails && (
          <label className="inline-flex items-center gap-2 text-base text-muted">
            <input
              type="checkbox"
              checked={details}
              aria-label={t('boards.log.detailAria', { label: detailLabel, title: blockName })}
              onChange={(e) => {
                restart()
                setDetails(e.target.checked)
              }}
              className="size-4 accent-[var(--color-accent)]"
            />
            {detailLabel}
          </label>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="py-2 text-sm text-muted">{query.trim() ? t('boards.log.noMatch') : t('boards.nothingYet')}</p>
      ) : (
        <div ref={box} onScroll={capture} style={{ overflowAnchor: 'none' }} className="relative max-h-72 overflow-y-auto rounded-md border border-border bg-bg/40">
          <ul>
            {rows.map(({ key, entry }) => (
              <li key={key} data-row={key} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-b border-border px-3 py-1.5 text-base last:border-b-0">
                <time dateTime={new Date(entry.at).toISOString()} className="whitespace-nowrap tabular-nums text-muted">
                  {formatDate(entry.at, boardTimeOptions(entry.at, now))}
                </time>
                <span className={cn('break-words [overflow-wrap:anywhere]', TONE_TEXT[entry.tone ?? 'neutral'])}>{entry.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
