import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { openTicketsAt, type MilestoneOpenTickets, type MilestoneStatusKind } from '@workhub/core'
import { Badge, Button } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { explainsBehind, openTicketsHidden, openTicketsSummary, OPEN_FLAG_LABEL, OPEN_FLAG_TONE } from '../../lib/planner'
import { relativeTime } from '../../lib/pullRequests'

/** The list of open tickets: key and title (opens the ticket), status, owner, last update, and a badge per flag. */
export function OpenTicketsList({ open: counted, profileId, name, now = Date.now() }: { open: MilestoneOpenTickets; profileId: string; name: string; now?: number }) {
  const { t, tn, locale } = useI18n()
  // "No movement" is worked out now, from the same clock as "updated ... ago", not as of the count.
  const open = openTicketsAt(counted, now)
  const hidden = openTicketsHidden(open)
  return (
    <div className="flex flex-col gap-1" data-testid="milestone-open-tickets">
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {open.tickets.map((k) => {
          const label = k.title && k.title !== k.key ? `${k.key} · ${k.title}` : k.key
          return (
            <li key={k.key} className="flex flex-col gap-0.5 px-2.5 py-1.5" data-testid="milestone-open-ticket">
              <div className="flex items-center gap-2">
                {k.url ? (
                  <button type="button" className="min-w-0 flex-1 truncate rounded-sm text-left font-mono text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" title={label} onClick={() => window.hub.openExternal(k.url!, profileId)}>
                    {label}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-sm" title={label}>
                    {label}
                  </span>
                )}
                {k.flags.map((f) => (
                  <Badge key={f} tone={OPEN_FLAG_TONE[f]} className="shrink-0">
                    {t(OPEN_FLAG_LABEL[f])}
                  </Badge>
                ))}
                <Badge tone="neutral" className="max-w-[10rem] shrink-0 truncate">
                  {k.status}
                </Badge>
              </div>
              {(typeof k.assignee === 'string' || k.updatedAt !== undefined) && (
                <p className="flex flex-wrap gap-x-2 text-xs text-subtle">
                  {typeof k.assignee === 'string' && <span className="max-w-[16rem] truncate">{k.assignee}</span>}
                  {k.updatedAt !== undefined && <span>{t('planner.open.updated', { time: relativeTime(k.updatedAt, now, locale) })}</span>}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      {hidden > 0 && (
        <p className="flex flex-wrap gap-x-2 text-xs text-subtle">
          <span>{tn('planner.open.more', hidden)}</span>
          {open.url && (
            <button type="button" aria-label={t('planner.open.seeAllFor', { name })} className="rounded-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" onClick={() => window.hub.openExternal(open.url!, profileId)}>
              {t('planner.open.seeAll')}
            </button>
          )}
        </p>
      )}
    </div>
  )
}

/** The Milestones tab's row: a control that shows and hides the list (hidden at first), and, when the milestone is Late or At risk, the "why is it behind" line before it. */
export function OpenTicketsBlock({ open: counted, profileId, listId, name, status }: { open: MilestoneOpenTickets | undefined; profileId: string; listId: string; name: string; status: MilestoneStatusKind }) {
  const { t, tn } = useI18n()
  const [shown, setShown] = useState(false)
  if (!counted || counted.total <= 0) return null
  const now = Date.now()
  const open = openTicketsAt(counted, now)
  const behind = explainsBehind(status)
  return (
    <div className="flex flex-col gap-1.5" data-testid="milestone-open">
      <div className="flex flex-wrap items-center gap-x-2">
        {behind && <p className="text-xs text-muted">{openTicketsSummary(open, tn)}</p>}
        <Button size="sm" variant="ghost" icon={shown ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />} aria-label={behind ? t(shown ? 'planner.open.hideFor' : 'planner.open.showFor', { name }) : tn(shown ? 'planner.open.hideCountFor' : 'planner.open.showCountFor', open.total, { name })} aria-expanded={shown} aria-controls={listId} onClick={() => setShown((s) => !s)}>
          {behind ? (shown ? t('planner.open.hide') : t('planner.open.show')) : tn('planner.open.control', open.total)}
        </Button>
      </div>
      <div id={listId} hidden={!shown}>
        {shown && <OpenTicketsList open={open} profileId={profileId} name={name} now={now} />}
      </div>
    </div>
  )
}
