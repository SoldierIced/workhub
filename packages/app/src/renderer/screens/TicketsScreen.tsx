import { Search, Ticket as TicketIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { filterTickets, groupBySprint, sessionsForTicket, ticketFacets, type Profile, type TicketFilter } from '@workhub/core'
import { Badge, Button, Spinner } from '../components/atoms'
import { Card, CardHeader, EmptyState, RefreshButton } from '../components/molecules'
import { TicketRow } from '../components/molecules/TicketRow'
import { useI18n } from '../i18n/I18nProvider'
import { keyColumnChars, keyProviders, sessionRefs } from '../lib/tickets'
import { DEFAULT_TICKETS_VIEW, loadTicketsView, saveTicketsView, type TicketScope, type TicketsView } from '../lib/ticketsView'
import type { SessionData } from '../store'
import { useBacklog, useTickets } from '../ticketsStore'
import { TicketFilterBar } from './tickets/TicketFilterBar'

export interface TicketsScreenProps {
  profile: Profile | undefined
  sessions: SessionData[]
  onOpenSettings: (tab?: string) => void
}

/**
 * Tickets of the active profile, grouped by sprint: the active one first, then the next ones, then
 * the backlog. "Assigned to me" or, when the tracker has one, the team's backlog, each with its own
 * filters (text, project, assignee, status). The scope and the filters are kept per profile.
 */
export function TicketsScreen({ profile, sessions, onOpenSettings }: TicketsScreenProps) {
  const { t, tn, formatDate } = useI18n()
  const profileId = profile?.id
  const mine = useTickets(profileId)
  const { status } = mine
  const [view, setView] = useState<TicketsView>(() => (profileId ? loadTicketsView(profileId) : DEFAULT_TICKETS_VIEW))
  useEffect(() => setView(profileId ? loadTicketsView(profileId) : DEFAULT_TICKETS_VIEW), [profileId])
  const update = (next: TicketsView) => {
    setView(next)
    if (profileId) saveTicketsView(profileId, next)
  }
  // A tracker without a backlog view shows my tickets; the saved scope stays for when it has one again.
  const ready = status?.state === 'ready' || status?.state === 'demo'
  const scope: TicketScope = view.scope === 'backlog' && status?.backlog ? 'backlog' : 'mine'
  const inBacklog = scope === 'backlog'
  const filter = view.filters[scope]
  const setFilter = (f: TicketFilter) => update({ ...view, filters: { ...view.filters, [scope]: f } })
  const team = useBacklog(profileId, inBacklog && status?.backlog === 'ready')
  const { loading, error, fetchedAt, refresh } = inBacklog ? team : mine
  const all = inBacklog ? team.tickets : mine.tickets
  const facets = useMemo(() => ticketFacets(all), [all])
  const tickets = useMemo(() => filterTickets(all, filter), [all, filter])
  const groups = useMemo(() => groupBySprint(tickets, t('tickets.backlog')), [tickets, t])
  const keyChars = useMemo(() => keyColumnChars(tickets), [tickets])
  const providers = useMemo(() => keyProviders(status), [status])
  const refs = useMemo(() => sessionRefs(sessions), [sessions])

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
  } else if (inBacklog && status.backlog === 'unconfigured') {
    body = (
      <EmptyState
        icon={<TicketIcon className="size-6" aria-hidden />}
        title={t('tickets.backlogUnconfigured')}
        description={t('tickets.backlogUnconfiguredHint')}
        action={<Button variant="primary" onClick={() => onOpenSettings('trackers')}>{t('tickets.openSettings')}</Button>}
      />
    )
  } else if (error && all.length === 0) {
    body = (
      <EmptyState
        icon={<TicketIcon className="size-6" aria-hidden />}
        title={t('tickets.loadError')}
        description={error}
        action={<Button onClick={() => void refresh()}>{t('tickets.refresh')}</Button>}
      />
    )
  } else if (loading && all.length === 0) {
    body = <Loading />
  } else if (all.length === 0) {
    body = inBacklog ? (
      <EmptyState icon={<TicketIcon className="size-6" aria-hidden />} title={t('tickets.backlogEmpty')} description={t('tickets.backlogEmptyHint')} />
    ) : (
      <EmptyState icon={<TicketIcon className="size-6" aria-hidden />} title={t('tickets.empty')} description={t('tickets.emptyHint')} />
    )
  } else if (tickets.length === 0) {
    body = (
      <EmptyState
        icon={<Search className="size-6" aria-hidden />}
        title={t('tickets.filter.none')}
        description={t('tickets.filter.noneHint')}
        action={<Button onClick={() => setFilter({})}>{t('tickets.filter.clear')}</Button>}
      />
    )
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
                    showAssignee={inBacklog}
                    keyChars={keyChars}
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
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-8 py-7">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('nav.tickets')}</h1>
          <p className="mt-0.5 text-base text-muted">{t(inBacklog ? 'tickets.subtitleBacklog' : 'tickets.subtitle')}</p>
        </div>
        {status?.state === 'demo' && <Badge tone="warning">{t('tickets.demo')}</Badge>}
        {fetchedAt && <span className="pt-1.5 text-sm text-muted">{t('tickets.updated', { time: formatDate(fetchedAt, { hour: '2-digit', minute: '2-digit' }) })}</span>}
        {ready && (
          <RefreshButton variant="button" label={t('tickets.refresh')} loading={loading} onRefresh={refresh} />
        )}
      </header>
      {ready && (status.backlog || all.length > 0) && (
        <TicketFilterBar
          scope={status.backlog ? { value: scope, onChange: (s) => update({ ...view, scope: s }), counts: { mine: mine.fetchedAt ? mine.tickets.length : undefined, backlog: team.fetchedAt ? team.tickets.length : undefined } } : undefined}
          filter={filter}
          onChange={setFilter}
          facets={facets}
          showAssignee={inBacklog}
          shown={tickets.length}
          total={all.length}
        />
      )}
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
