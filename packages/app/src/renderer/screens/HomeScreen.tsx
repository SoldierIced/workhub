import { ArrowRight, FolderPlus, Workflow } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ConnectionKind, CreditSpend, Profile } from '@workhub/core'
import { Button, STATE_TONE, StateDot, type Tone } from '../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, HOME_INSET_ROW, StatTile } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { ATTENTION_ORDER, folderName, groupByAttention, hasConnection, planUsage, type Attention } from '../lib/home'
import { moduleScreens, ticketsInProgress } from '@workhub/core'
import { HomeTicketsCard } from '../components/organisms/HomeTickets'
import { AgentUsageCard } from '../components/organisms/AgentUsageCard'
import { TokenSpendCard } from '../components/organisms/TokenSpendCard'
import { useFolderSpend } from '../lib/folder-spend'
import { agentUsageSections, kiroUsageNote } from '../lib/agent-usage'
import { useApiSpend, useNow, useUsageSettings } from '../lib/usage'
import type { AccountUsage } from '@shared/api'
import type { Route } from '../lib/nav'
import { useTickets } from '../ticketsStore'
import type { SessionData } from '../store'
import { usePullRequestLists } from '../pullRequestsStore'
import { HealthPills } from './health/HealthPills'
import { PullRequestCard, PullRequestTile } from './pullRequests/HomeCards'
import { usageWindowName } from '../lib/usage-window'

const ATTENTION: Record<Attention, { title: MessageKey; empty: MessageKey; tone: Tone; action: MessageKey }> = {
  needsReply: { title: 'home.needsReply', empty: 'home.needsReplyEmpty', tone: 'warning', action: 'home.action.answer' },
  ready: { title: 'home.ready', empty: 'home.readyEmpty', tone: 'success', action: 'home.action.review' },
  working: { title: 'home.working', empty: 'home.workingEmpty', tone: 'info', action: 'home.action.open' },
  error: { title: 'home.error', empty: 'home.errorEmpty', tone: 'danger', action: 'home.action.open' }
}

/** Rows a "Needs you" group shows before "N more". */
const GROUP_ROWS = 4

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
  const active = ATTENTION_ORDER.reduce((n, a) => n + groups[a].length, 0)
  const modules = new Set(moduleScreens(profile?.modules))
  const now = useNow()
  const { budget, accountsOf } = useUsageSettings()
  const usageSections = agentUsageSections(sessions, reads, budget, accountsOf, now)
  const kiro = kiroUsageNote(sessions, accountsOf)
  const kiroSpend = useKiroSpend()
  const apiSpend = useApiSpend()
  // The tile shows the highest window of any account (Usage by agent below lists them all).
  const usage = [...planUsage(sessions), ...usageSections.flatMap((s) => s.accounts.flatMap((a) => a.windows))].sort((a, b) => b.percent - a.percent)[0]
  const spend = useFolderSpend(profile?.id)
  const tix = useTickets(profile?.id)
  const trackerLive = tix.status?.state === 'ready' || tix.status?.state === 'demo'
  const inProgress = ticketsInProgress(tix.tickets).length
  const hasFolders = (profile?.folders ?? []).length > 0

  // Workhub 1's Home: left-aligned up to 1240px, 16px between sections and 12px between cards.
  // Widths are the page's own (container queries), not the window's, since the sidebar takes part.
  return (
    <div className="@container">
      <div className="flex max-w-[1240px] flex-col gap-4 px-6 pt-5 pb-6">
        <header>
          <h1 className="truncate text-2xl font-semibold tracking-tight">{profile?.name ?? t('nav.home')}</h1>
          <p className="mt-0.5 text-base text-muted first-letter:uppercase">{formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </header>

        {modules.has('health') && <HealthPills profile={profile} onOpenHealth={() => onNavigate?.('health')} onOpenSettings={onOpenSettings} />}

        {profile && !hasFolders && (
          <section className="flex items-center gap-3 rounded-[10px] border border-border bg-surface p-3 shadow-sm">
            <FolderPlus className="size-6 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">{t('home.addFolders.title')}</h2>
              <p className="text-sm text-muted">{t('home.addFolders.body')}</p>
            </div>
            <Button size="sm" variant="ghost" className="shrink-0 text-accent hover:text-accent" onClick={() => onOpenSettings('profiles')}>
              {t('home.openSettings')}
              <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          </section>
        )}

        <section aria-labelledby="needs-you" className="flex flex-col gap-2.5">
          <div className="flex items-baseline gap-2">
            <h2 id="needs-you" className="text-md font-semibold">
              {t('home.needsYou')}
            </h2>
            <span className="text-sm text-muted">{active ? t('home.needsYouCount', { count: active }) : t('home.needsYouQuiet')}</span>
          </div>
          <div className="grid grid-cols-1 gap-2.5 @min-[480px]:grid-cols-2 @min-[960px]:grid-cols-4">
            {ATTENTION_ORDER.map((a) => {
              const list = groups[a]
              const meta = ATTENTION[a]
              return (
                <section key={a} aria-label={t(meta.title)} className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface p-3 shadow-sm">
                  <div className="flex items-center gap-1.5">
                    <StateDot tone={meta.tone} />
                    <h3 className="flex-1 text-sm font-semibold">{t(meta.title)}</h3>
                    <span className="text-sm tabular-nums text-muted">{list.length}</span>
                  </div>
                  {list.length === 0 ? (
                    <p className="text-sm text-muted">{t(meta.empty)}</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {list.slice(0, GROUP_ROWS).map((s) => (
                        <li key={s.view.id}>
                          <button
                            type="button"
                            className={`${HOME_INSET_ROW} flex w-full items-start gap-2 text-left transition-colors hover:bg-surface-hover`}
                            title={s.view.cwd}
                            onClick={() => onOpenSession(s.view.id)}
                          >
                            <StateDot tone={STATE_TONE[s.view.state]} className="mt-1.5" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-semibold">{s.view.label}</span>
                              <span className="flex items-baseline gap-1 text-xs text-muted">
                                <span className="min-w-0 flex-1 truncate">
                                  {folderName(s.view.cwd)} · {t(`state.${s.view.state}`)}
                                </span>
                                <span className="shrink-0 font-medium text-accent">{t(meta.action)}</span>
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                      {list.length > GROUP_ROWS && <li className="px-2 text-xs text-subtle">{tn('home.more', list.length - GROUP_ROWS)}</li>}
                    </ul>
                  )}
                </section>
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

        <div className="grid grid-cols-2 gap-3 @min-[760px]:grid-cols-4">
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
            caption={usage ? t('home.planUsageWindow', { window: usageWindowName(usage.window, t) }) : t('home.planUsageEmpty')}
          />
        </div>

        <div className="grid grid-cols-1 items-start gap-3 @min-[900px]:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <PullRequestCard kind="mine" profileId={profile?.id ?? null} lists={pullRequests.lists} onOpenPullRequest={onOpenPullRequest} onOpenAll={() => onOpenPullRequest()} onOpenSettings={onOpenSettings} />
            <PullRequestCard kind="toReview" profileId={profile?.id ?? null} lists={pullRequests.lists} onOpenPullRequest={onOpenPullRequest} onOpenAll={() => onOpenPullRequest()} onOpenSettings={onOpenSettings} />
            <AgentUsageCard sections={usageSections} kiro={kiro} kiroSpend={kiroSpend} apiSpend={apiSpend} ceilings={budget.ceilings} now={now} onOpenSettings={() => onOpenSettings('usage')} />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
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
            <TokenSpendCard spend={spend} apiSpend={apiSpend} onOpenSettings={() => onOpenSettings('profiles')} />
          </div>
        </div>
      </div>
    </div>
  )
}
