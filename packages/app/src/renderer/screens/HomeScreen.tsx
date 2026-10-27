import { Activity, ArrowRight, Ticket, Workflow } from 'lucide-react'
import type { ConnectionKind, Profile } from '@workhub/core'
import { Badge, Button, STATE_TONE, StateDot, type Tone } from '../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, ListRow, StatTile } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { ATTENTION_ORDER, folderName, formatTokens, groupByAttention, hasConnection, planUsage, tokensByFolder, type Attention } from '../lib/home'
import { moduleScreens } from '@workhub/core'
import type { SessionData } from '../store'
import { usePullRequestLists } from '../pullRequestsStore'
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
  onOpenSession: (id: string) => void
  onOpenSettings: (tab?: string) => void
  /** Opens the Pull requests screen, on one PR when a URL is given. */
  onOpenPullRequest: (url?: string) => void
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

export function HomeScreen({ profile, sessions, onOpenSession, onOpenSettings, onOpenPullRequest }: HomeScreenProps) {
  const { t, tn, formatDate } = useI18n()
  const pullRequests = usePullRequestLists(profile?.id ?? null)
  const groups = groupByAttention(sessions)
  const waiting = groups.needsReply.length
  const modules = new Set(moduleScreens(profile?.modules))
  const usage = planUsage(sessions).sort((a, b) => b.percent - a.percent)[0]
  const folders = tokensByFolder(sessions).slice(0, 8)
  const maxTokens = folders[0]?.tokens ?? 1
  const tracker = hasConnection(profile, 'tracker')

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-7">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{profile?.name ?? t('nav.home')}</h1>
        <p className="mt-0.5 text-base text-muted first-letter:uppercase">{formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </header>

      {modules.has('health') && (
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium text-muted">{t('home.environments')}</span>
          <Badge tone="neutral" icon={<Activity className="size-3" aria-hidden />}>
            {hasConnection(profile, 'health') ? t('home.arrivesIn', { phase: 'P6' }) : t('home.notConnected.health')}
          </Badge>
        </div>
      )}

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
        <StatTile label={t('home.ticketsInProgress')} value={null} caption={tracker ? t('home.arrivesIn', { phase: 'P4' }) : t('home.notConnected.tracker')} />
        <StatTile
          label={t('home.planUsage')}
          value={usage ? `${Math.round(usage.percent)}%` : null}
          caption={usage ? t('home.planUsageWindow', { window: usage.window }) : t('home.planUsageEmpty')}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <PullRequestCard kind="mine" lists={pullRequests.lists} onOpenPullRequest={onOpenPullRequest} onOpenAll={() => onOpenPullRequest()} onOpenSettings={onOpenSettings} />
          <PullRequestCard kind="toReview" lists={pullRequests.lists} onOpenPullRequest={onOpenPullRequest} onOpenAll={() => onOpenPullRequest()} onOpenSettings={onOpenSettings} />
        </div>
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title={t('home.tickets')} icon={<Ticket className="size-4" aria-hidden />} />
            <CardBody>
              <ConnectionNote profile={profile} kind="tracker" phase="P4" onOpenSettings={onOpenSettings} />
            </CardBody>
          </Card>
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
