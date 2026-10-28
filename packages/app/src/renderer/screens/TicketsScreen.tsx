import { Ticket as TicketIcon } from 'lucide-react'
import { useMemo } from 'react'
import { groupBySprint, sessionsForTicket, type Profile } from '@workhub/core'
import { Badge, Button, Spinner } from '../components/atoms'
import { Card, CardHeader, EmptyState, RefreshButton } from '../components/molecules'
import { TicketRow } from '../components/molecules/TicketRow'
import { useI18n } from '../i18n/I18nProvider'
import { keyProviders, sessionRefs } from '../lib/tickets'
import type { SessionData } from '../store'
import { useTickets } from '../ticketsStore'

export interface TicketsScreenProps {
  profile: Profile | undefined
  sessions: SessionData[]
  onOpenSettings: (tab?: string) => void
}

/** Tickets assigned to me in the active profile, grouped by sprint: the active one first, then the next ones, then the backlog. */
export function TicketsScreen({ profile, sessions, onOpenSettings }: TicketsScreenProps) {
  const { t, tn, formatDate } = useI18n()
  const { status, tickets, loading, error, fetchedAt, refresh } = useTickets(profile?.id)
  const groups = useMemo(() => groupBySprint(tickets, t('tickets.backlog')), [tickets, t])
  const providers = useMemo(() => keyProviders(status), [status])
  const refs = useMemo(() => sessionRefs(sessions), [sessions])
  const profileId = profile?.id

  const open = (key: string) => profileId && void window.hub.tickets.openWindow(profileId, key)

  let body
  if (!profileId || !status) {
    body = loading ? <Loading /> : <EmptyState icon={<TicketIcon className="size-6" aria-hidden />} title={t('tickets.noConnection')} description={t('tickets.noConnectionHint')} />
  } else if (status.state === 'noConnection' || status.state === 'incomplete' || status.state === 'unsupported') {
    body = (
      <EmptyState
        icon={<TicketIcon className="size-6" aria-hidden />}
        title={t(`tickets.${status.state}`)}
        description={t(`tickets.${status.state}Hint`)}
        action={<Button variant="primary" onClick={() => onOpenSettings('trackers')}>{t('tickets.openSettings')}</Button>}
      />
    )
  } else if (error && tickets.length === 0) {
    body = (
      <EmptyState
        icon={<TicketIcon className="size-6" aria-hidden />}
        title={t('tickets.loadError')}
        description={error}
        action={<Button onClick={() => void refresh()}>{t('tickets.refresh')}</Button>}
      />
    )
  } else if (loading && tickets.length === 0) {
    body = <Loading />
  } else if (tickets.length === 0) {
    body = <EmptyState icon={<TicketIcon className="size-6" aria-hidden />} title={t('tickets.empty')} description={t('tickets.emptyHint')} />
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {t('tickets.loadError')}: {error}
          </p>
        )}
        {groups.map((g) => (
          <Card key={g.id} aria-label={g.title}>
            <CardHeader
              title={g.title}
              as="h3"
              meta={tn('tickets.count', g.tickets.length)}
              actions={g.isActive ? <Badge tone="success">{t('tickets.activeSprint')}</Badge> : undefined}
            />
            <ul className="flex flex-col px-2 pb-2">
              {g.tickets.map((ticket) => (
                <li key={ticket.key}>
                  <TicketRow
                    ticket={ticket}
                    sessionCount={sessionsForTicket(ticket.key, refs, providers).length}
                    onOpen={() => open(ticket.key)}
                    onStartSession={() => window.hub.links.request({ kind: 'ticketSession', profileId, ticket: { key: ticket.key, title: ticket.title, url: ticket.url } })}
                    onOpenExternal={ticket.url ? () => void window.hub.tickets.openExternal(ticket.url!) : undefined}
                  />
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-8 py-7">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('nav.tickets')}</h1>
          <p className="mt-0.5 text-base text-muted">{t('tickets.subtitle')}</p>
        </div>
        {status?.state === 'demo' && <Badge tone="warning">{t('tickets.demo')}</Badge>}
        {fetchedAt && <span className="pt-1.5 text-sm text-muted">{t('tickets.updated', { time: formatDate(fetchedAt, { hour: '2-digit', minute: '2-digit' }) })}</span>}
        {status && (status.state === 'ready' || status.state === 'demo') && (
          <RefreshButton variant="button" label={t('tickets.refresh')} loading={loading} onRefresh={refresh} />
        )}
      </header>
      {body}
    </div>
  )
}

function Loading() {
  return (
    <div className="flex justify-center py-16" role="status">
      <Spinner className="size-5" />
    </div>
  )
}
