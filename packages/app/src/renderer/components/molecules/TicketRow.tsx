import { ExternalLink, GitPullRequest, SquareTerminal } from 'lucide-react'
import type { Ticket } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { CATEGORY_TONE } from '../../lib/tickets'
import { Badge } from '../atoms/Badge'
import { IconButton } from '../atoms/IconButton'
import { cn } from '../../lib/cn'

export interface TicketRowProps {
  ticket: Ticket
  /** Open sessions that mention the ticket. */
  sessionCount?: number
  onOpen: () => void
  onOpenExternal?: () => void
  className?: string
}

/** One ticket in a list: key, title, links to PRs and sessions, status. Clicking opens the ticket window. */
export function TicketRow({ ticket, sessionCount = 0, onOpen, onOpenExternal, className }: TicketRowProps) {
  const { t, tn } = useI18n()
  const prs = ticket.pullRequestUrls?.length ?? 0
  return (
    <div className={cn('flex items-center gap-2 rounded-md px-1 transition-colors duration-150 hover:bg-surface-hover', className)}>
      <button type="button" onClick={onOpen} aria-label={t('tickets.openTicket', { key: ticket.key })} className="flex min-w-0 flex-1 items-center gap-3 py-1.5 pl-1.5 text-left text-base">
        <span className="w-24 shrink-0 truncate font-mono text-sm font-medium text-accent">{ticket.key}</span>
        <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
      </button>
      {prs > 0 && (
        <Badge tone="accent" icon={<GitPullRequest className="size-3" aria-hidden />} title={tn('tickets.pullRequests', prs)}>
          {prs}
        </Badge>
      )}
      {sessionCount > 0 && (
        <Badge tone="neutral" icon={<SquareTerminal className="size-3" aria-hidden />} title={tn('tickets.sessions', sessionCount)}>
          {sessionCount}
        </Badge>
      )}
      <Badge tone={CATEGORY_TONE[ticket.category]} className="max-w-36 truncate">
        {ticket.status}
      </Badge>
      {onOpenExternal && ticket.url ? (
        <IconButton size="sm" label={t('tickets.openInBrowser')} icon={<ExternalLink className="size-3.5" />} onClick={onOpenExternal} />
      ) : (
        <span className="size-7 shrink-0" aria-hidden />
      )}
    </div>
  )
}
