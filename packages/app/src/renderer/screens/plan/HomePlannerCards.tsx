import { ArrowRight } from 'lucide-react'
import { Button } from '../../components/atoms'
import { HOME_INSET_ROW, HomeCard, HomeNote } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { milestonesAtRisk, MILESTONE_STATUS_LABEL } from '../../lib/planner'
import { requestPlanTab, usePlanner } from '../../plannerStore'
import { MilestoneBar } from './MilestonesTab'

const TOP = 3

function OpenButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={onOpen}>
      {label}
      <ArrowRight className="size-3.5" aria-hidden />
    </Button>
  )
}

/** Home's "Milestones at risk": late and at-risk milestones, worst first. Shown while Plan is on. */
export function HomeMilestonesCard({ profileId, onOpenPlan }: { profileId: string; onOpenPlan: () => void }) {
  const { t, tn } = useI18n()
  const { view } = usePlanner(profileId, true)
  const risky = milestonesAtRisk(view?.milestones ?? [])
  const open = () => {
    requestPlanTab('milestones')
    onOpenPlan()
  }
  return (
    <HomeCard title={t('planner.home.milestones')} detail={view && risky.length ? tn('planner.home.milestonesCount', risky.length) : undefined} trailing={<OpenButton label={t('planner.home.open')} onOpen={open} />} data-testid="home-milestones">
      {!view ? (
        <HomeNote text={t('plan.loading')} />
      ) : risky.length === 0 ? (
        <HomeNote text={view.milestones.length ? t('planner.home.milestonesNone') : t('planner.home.milestonesEmpty')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {risky.slice(0, TOP).map((r) => (
            <li key={r.milestone.id}>
              <button type="button" onClick={open} className={`${HOME_INSET_ROW} flex w-full flex-col gap-1.5 text-left transition-colors hover:bg-surface-hover`}>
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{r.milestone.name}</span>
                  <span className={r.status === 'late' ? 'text-sm text-danger' : 'text-sm text-warning'}>{t(MILESTONE_STATUS_LABEL[r.status])}</span>
                </span>
                <MilestoneBar row={r} label={t('planner.milestone.barLabel', { name: r.milestone.name, progress: r.progress, elapsed: r.elapsed })} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  )
}

/** Home's "Inbox": how many items wait for approval, and the newest ones. */
export function HomeInboxCard({ profileId, onOpenPlan }: { profileId: string; onOpenPlan: () => void }) {
  const { t, tn } = useI18n()
  const { view } = usePlanner(profileId, true)
  const pending = (view?.inbox ?? []).filter((i) => i.status === 'pending').sort((a, b) => b.createdAt - a.createdAt)
  const open = () => {
    requestPlanTab('inbox')
    onOpenPlan()
  }
  return (
    <HomeCard title={t('planner.home.inbox')} detail={view ? tn('planner.home.pending', pending.length) : undefined} trailing={<OpenButton label={t('planner.home.open')} onOpen={open} />} data-testid="home-inbox">
      {!view ? (
        <HomeNote text={t('plan.loading')} />
      ) : pending.length === 0 ? (
        <HomeNote text={t('planner.home.inboxNone')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {pending.slice(0, TOP).map((i) => (
            <li key={i.id}>
              <button type="button" onClick={open} className={`${HOME_INSET_ROW} flex w-full items-center gap-2 text-left transition-colors hover:bg-surface-hover`}>
                <span className="min-w-0 flex-1 truncate font-semibold">{i.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  )
}
