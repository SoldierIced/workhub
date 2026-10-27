import { ArrowRight, Workflow } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ConnectionKind, CreditSpend, Profile } from '@workhub/core'
import { Button, STATE_TONE, StateDot, type Tone } from '../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, ListRow, StatTile } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { ATTENTION_ORDER, folderName, formatTokens, groupByAttention, hasConnection, planUsage, tokensByFolder, type Attention } from '../lib/home'
import { moduleScreens, ticketsInProgress } from '@workhub/core'
import { HomeTicketsCard } from '../components/organisms/HomeTickets'
import { AgentUsageCard } from '../components/organisms/AgentUsageCard'
import { agentUsageSections, kiroUsageNote } from '../lib/agent-usage'
import { useNow, useUsageSettings } from '../lib/usage'
import type { AccountUsage } from '@shared/api'
import type { Route } from '../lib/nav'
import { useTickets } from '../ticketsStore'
import type { SessionData } from '../store'
import { usePullRequestLists } from '../pullRequestsStore'
import { HealthPills } from './health/HealthPills'
import { PullRequestCard, PullRequestTile } from './pullRequests/HomeCards'

const ATTENTION: Record<Attention, { title: MessageKey; empty: MessageKey; tone: Tone }> = {
  needsReply: { title: 'home.needsReply', empty: 'home.needsReplyEmpty', tone: 'warning' },
  ready: { title: 'home.ready', empty: 'home.readyEmpty', tone: 'success' },
  working: { title: 'home.working', empty: 'home.workingEmpty', tone: 'info' },
  error: { title: 'home.error', empty: 'home.errorEmpty', tone: 'danger' }
}

export interface HomeScreenProps {
  profile: Profile | undefined
  sessions: SessionData[]
  /** Plan usage read per agent account (Settings → Usage). */
  usage?: AccountUsage[]
  onOpenSession: (id: string) => void
  onOpenSettings: (tab?: string) => void
  /** Opens the Pull requests screen, on one PR when a URL is given. */
  onOpenPullRequest: (url?: string) => void
  onNavigate?: (route: Route) => void
}

/** "Connect X in Settings" or "arrives in phase N", depending on whether the profile has the connection. */
function ConnectionNote({ profile, kind, phase, onOpenSettings }: { profile: Profile | undefined; kind: ConnectionKind; phase: string; onOpenSettings: HomeScreenProps['onOpenSettings'] }) {
  const { t } = useI18n()
  const connected = hasConnection(profile, kind)
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-surface-hover/60 px-3 py-2.5 text-sm">
      <span className="text-muted">{connected ? t('home.arrivesIn', { phase }) : t(`home.notConnected.${kind}`)}</span>
      {!connected && (
        <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={() => onOpenSettings('connections')}>
          {t('home.openSettings')}
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  )
}

/** Kiro credits spent today and this week, read from its session files when Home shows and every minute after. */
function useKiroSpend(): CreditSpend | null {
  const [spend, setSpend] = useState<CreditSpend | null>(null)
  useEffect(() => {
    let live = true
    const read = () =>
      void window.hub.usage.kiroSpend().then(
        (s) => live && setSpend(s),
        () => {}
      )
    read()
    const timer = setInterval(read, 60_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return spend
}

export function HomeScreen({ profile, sessions, usage: reads = [], onOpenSession, onOpenSettings, onOpenPullRequest, onNavigate }: HomeScreenProps) {
  const { t, tn, formatDate } = useI18n()
  const pullRequests = usePullRequestLists(profile?.id ?? null)
  const groups = groupByAttention(sessions)
  const waiting = groups.needsReply.length
  const modules = new Set(moduleScreens(profile?.modules))
  const now = useNow()
  const { budget, accountsOf } = useUsageSettings()
  const usageSections = agentUsageSections(sessions, reads, budget, accountsOf, now)
  const kiro = kiroUsageNote(sessions, accountsOf)
  const kiroSpend = useKiroSpend()
  // The tile shows the highest window of any account (Usage by agent below lists them all).
  const usage = [...planUsage(sessions), ...usageSections.flatMap((s) => s.accounts.flatMap((a) => a.windows))].sort((a, b) => b.percent - a.percent)[0]
  const folders = tokensByFolder(sessions).slice(0, 8)
  const maxTokens = folders[0]?.tokens ?? 1
  const tix = useTickets(profile?.id)
  const trackerLive = tix.status?.state === 'ready' || tix.status?.state === 'demo'
  const inProgress = ticketsInProgress(tix.tickets).length

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-7">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{profile?.name ?? t('nav.home')}</h1>
        <p className="mt-0.5 text-base text-muted first-letter:uppercase">{formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </header>

      {modules.has('health') && <HealthPills profile={profile} onOpenHealth={() => onNavigate?.('health')} onOpenSettings={onOpenSettings} />}

      <section aria-labelledby="needs-you">
        <div className="mb-2.5 flex items-baseline gap-2">
          <h2 id="needs-you" className="text-md font-semibold">
            {t('home.needsYou')}
          </h2>
          <span className="text-sm text-muted">{tn('home.sessionsWaiting', waiting)}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {ATTENTION_ORDER.map((a) => {
            const list = groups[a]
            const meta = ATTENTION[a]
            return (
              <Card key={a} aria-label={t(meta.title)} className="flex min-h-28 flex-col p-3">
                <div className="flex items-center gap-2 px-1">
                  <StateDot tone={meta.tone} />
                  <h3 className="flex-1 font-semibold">{t(meta.title)}</h3>
                  <span className="text-sm tabular-nums text-muted">{list.length}</span>
                </div>
                {list.length === 0 ? (
                  <p className="mt-2 px-1 text-sm text-subtle">{t(meta.empty)}</p>
                ) : (
                  <ul className="mt-1.5 flex flex-col gap-0.5">
                    {list.slice(0, 3).map((s) => (
                      <li key={s.view.id}>
                        <ListRow
                          className="px-1.5"
                          leading={<StateDot tone={STATE_TONE[s.view.state]} />}
                          title={s.view.label}
                          subtitle={`${folderName(s.view.cwd)} · ${t(`state.${s.view.state}`)}`}
                          onClick={() => onOpenSession(s.view.id)}
                        />
                      </li>
                    ))}
                    {list.length > 3 && <li className="px-1.5 text-xs text-subtle">{tn('home.more', list.length - 3)}</li>}
                  </ul>
                )}
              </Card>
            )
          })}
        </div>
      </section>

      {modules.has('flows') && (
        <Card>
          <CardHeader title={t('home.flowsInProgress')} icon={<Workflow className="size-4" aria-hidden />} />
          <CardBody>
            <EmptyState compact title={t('home.noFlows')} description={t('home.arrivesIn', { phase: 'P7' })} />
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <PullRequestTile kind="mine" lists={pullRequests.lists} loading={pullRequests.loading} />
        <PullRequestTile kind="toReview" lists={pullRequests.lists} loading={pullRequests.loading} />
        <StatTile
          label={t('home.ticketsInProgress')}
          value={trackerLive && !tix.error ? inProgress : null}
          loading={tix.loading}
          caption={trackerLive ? (tix.error ? t('home.ticketsError') : tn('home.ticketsAssigned', tix.tickets.length)) : t('home.notConnected.tracker')}
        />
        <StatTile
          label={t('home.planUsage')}
          value={usage ? `${Math.round(usage.percent)}%` : null}
          caption={usage ? t('home.planUsageWindow', { window: usage.window }) : t('home.planUsageEmpty')}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <PullRequestCard kind="mine" profileId={profile?.id ?? null} lists={pullRequests.lists} onOpenPullRequest={onOpenPullRequest} onOpenAll={() => onOpenPullRequest()} onOpenSettings={onOpenSettings} />
          <PullRequestCard kind="toReview" profileId={profile?.id ?? null} lists={pullRequests.lists} onOpenPullRequest={onOpenPullRequest} onOpenAll={() => onOpenPullRequest()} onOpenSettings={onOpenSettings} />
        </div>
        <div className="flex flex-col gap-3">
          <AgentUsageCard sections={usageSections} kiro={kiro} kiroSpend={kiroSpend} ceilings={budget.ceilings} now={now} onOpenSettings={() => onOpenSettings('usage')} />
          <HomeTicketsCard
            profileId={profile?.id}
            status={tix.status}
            tickets={tix.tickets}
            loading={tix.loading}
            error={tix.error}
            sessions={sessions}
            onViewAll={() => onNavigate?.('tickets')}
            onOpenSettings={() => onOpenSettings('trackers')}
          />
          <Card>
            <CardHeader title={t('home.tokensByFolder')} meta={t('home.tokensByFolderMeta')} />
            <CardBody>
              {folders.length === 0 ? (
                <p className="text-sm text-subtle">{t('home.tokensByFolderEmpty')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {folders.map((f) => (
                    <li key={f.path} className="grid grid-cols-[minmax(0,10rem)_1fr_3.5rem] items-center gap-3 text-sm" title={f.path}>
                      <span className="truncate">{f.folder}</span>
                      <span className="h-1.5 overflow-hidden rounded-full bg-surface-hover" aria-hidden>
                        <span className="brand-gradient block h-full rounded-full" style={{ width: `${Math.max(3, (f.tokens / maxTokens) * 100)}%` }} />
                      </span>
                      <span className="text-right tabular-nums text-muted">{formatTokens(f.tokens)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  )
}
