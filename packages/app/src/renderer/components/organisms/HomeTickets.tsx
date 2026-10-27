import { ArrowRight, Ticket as TicketIcon } from 'lucide-react'
import { sessionsForTicket, ticketsInProgress, type Ticket } from '@workhub/core'
import type { TicketsStatus } from '@shared/tickets-api'
import { useI18n } from '../../i18n/I18nProvider'
import { keyProviders, sessionRefs } from '../../lib/tickets'
import type { SessionData } from '../../store'
import { Button } from '../atoms/Button'
import { Spinner } from '../atoms/Spinner'
import { Card, CardBody, CardHeader } from '../molecules/Card'
import { EmptyState } from '../molecules/EmptyState'
import { TicketRow } from '../molecules/TicketRow'

const SHOWN = 6

/** Home's "Tickets" card: my tickets, those in progress first, from the profile's tracker. */
export function HomeTicketsCard(props: {
  profileId: string | undefined
  status: TicketsStatus | undefined
  tickets: Ticket[]
  loading: boolean
  error?: string
  sessions: SessionData[]
  onViewAll: () => void
  onOpenSettings: () => void
}) {
  const { t, tn } = useI18n()
  const { profileId, status, tickets, loading, error, sessions } = props
  const live = status?.state === 'ready' || status?.state === 'demo'
  const refs = sessionRefs(sessions)
  const providers = keyProviders(status)
  const ordered = [...ticketsInProgress(tickets), ...tickets.filter((x) => x.category !== 'inProgress')]

  return (
    <Card>
      <CardHeader
        title={t('home.tickets')}
        icon={<TicketIcon className="size-4" aria-hidden />}
        meta={live && tickets.length > 0 ? tn('home.ticketsAssigned', tickets.length) : undefined}
        actions={loading ? <Spinner className="size-3.5" /> : undefined}
      />
      <CardBody className="px-2">
        {!live ? (
          <div className="mx-2 flex items-center justify-between gap-3 rounded-md bg-surface-hover/60 px-3 py-2.5 text-sm">
            <span className="text-muted">{status?.state === 'incomplete' ? t('tickets.incomplete') : t('home.notConnected.tracker')}</span>
            <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={props.onOpenSettings}>
              {t('home.openSettings')}
              <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          </div>
        ) : error && tickets.length === 0 ? (
          <p role="alert" className="px-3 text-sm text-danger">
            {t('home.ticketsError')}: {error}
          </p>
        ) : tickets.length === 0 ? (
          <EmptyState compact title={t('home.ticketsEmpty')} />
        ) : (
          <>
            <ul className="flex flex-col">
              {ordered.slice(0, SHOWN).map((ticket) => (
                <li key={ticket.key}>
                  <TicketRow
                    ticket={ticket}
                    sessionCount={sessionsForTicket(ticket.key, refs, providers).length}
                    onOpen={() => profileId && void window.hub.tickets.openWindow(profileId, ticket.key)}
                  />
                </li>
              ))}
            </ul>
            {tickets.length > SHOWN && (
              <div className="px-2 pt-1">
                <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={props.onViewAll}>
                  {t('home.ticketsViewAll')}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Button>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
