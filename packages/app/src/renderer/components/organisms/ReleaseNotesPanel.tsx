import { ExternalLink, Sparkles, TrendingUp, Wrench, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReleaseNoteKind, ReleaseNotesEntry } from '@shared/release-notes'
import type { UpdateStatus } from '@shared/updates-api'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { Badge, type Tone } from '../atoms/Badge'
import { Button } from '../atoms/Button'

const KIND: Record<ReleaseNoteKind, { tone: Tone; icon: LucideIcon; label: MessageKey }> = {
  new: { tone: 'accent', icon: Sparkles, label: 'updates.notes.kind.new' },
  improved: { tone: 'info', icon: TrendingUp, label: 'updates.notes.kind.improved' },
  fixed: { tone: 'success', icon: Wrench, label: 'updates.notes.kind.fixed' }
}

/** Versions open at first for someone several behind; the rest wait behind "Show N earlier versions". */
export const OPEN_VERSIONS = 2

/** `YYYY-MM-DD` as a day of the local calendar (parsed as UTC it would show the day before, west of Greenwich). */
function dayOf(date: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** What changed, version by version: each item with its kind, its title and what it is for. */
export function ReleaseNotes({ notes }: { notes: readonly ReleaseNotesEntry[] }) {
  const { t, tn, locale, formatDate } = useI18n()
  const [all, setAll] = useState(false)
  const shown = all ? notes : notes.slice(0, OPEN_VERSIONS)
  const hidden = notes.length - shown.length
  return (
    <div className="flex flex-col" data-testid="release-notes">
      {shown.map((entry, i) => (
        <section key={entry.version} className={cn(i > 0 && 'mt-4 border-t border-border pt-4')} data-testid="release-notes-version">
          <h3 className="flex items-baseline gap-2">
            <span className="text-base font-semibold tabular-nums">{entry.version}</span>
            <time dateTime={entry.date} className="text-sm text-muted">
              {formatDate(dayOf(entry.date), { day: 'numeric', month: 'short', year: 'numeric' })}
            </time>
          </h3>
          <ul className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3">
            {entry.items.map((item, j) => {
              const kind = KIND[item.kind]
              const Icon = kind.icon
              return (
                <li key={j} className="col-span-2 grid grid-cols-subgrid items-start">
                  <Badge className="justify-self-start" tone={kind.tone} icon={<Icon className="size-3" aria-hidden />}>
                    {t(kind.label)}
                  </Badge>
                  <div className="max-w-[68ch] min-w-0">
                    <p className="text-base leading-5 font-medium text-pretty">{item.title[locale]}</p>
                    {item.body && <p className="mt-0.5 text-sm leading-[1.45] text-muted text-pretty">{item.body[locale]}</p>}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {hidden > 0 && (
        <Button variant="ghost" size="sm" className="mt-3 -ml-2.5 self-start" data-testid="release-notes-earlier" onClick={() => setAll(true)}>
          {tn('updates.notes.earlier', hidden)}
        </Button>
      )}
    </div>
  )
}

/**
 * The notes of the update found, in a region that scrolls by itself, and the way to the list of
 * releases on GitHub, where every version has its changes. Without notes only that link is left;
 * when they could not be read, it says so.
 */
export function ReleaseNotesPanel({ status, className }: { status: UpdateStatus; className?: string }) {
  const { t } = useI18n()
  const notes = status.notes ?? []
  const url = status.changesUrl
  if (!notes.length && !status.notesError && !url) return null
  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
      {notes.length > 0 && (
        // Focusable so the keyboard can scroll it.
        <div role="region" aria-label={t('updates.notes.title')} tabIndex={0} className="max-h-[min(46vh,380px)] overflow-y-auto rounded-lg border border-border bg-surface px-4 py-3.5">
          <ReleaseNotes notes={notes} />
        </div>
      )}
      {!notes.length && status.notesError && (
        <p className="text-sm text-muted" data-testid="release-notes-failed">
          {t('updates.notes.failed')}
        </p>
      )}
      {url && (
        <button type="button" className="inline-flex items-center gap-1.5 self-start text-sm text-accent hover:underline" data-testid="release-notes-link" onClick={() => window.hub.openExternal(url)}>
          {t('updates.notes.allChanges')}
          <ExternalLink className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}
