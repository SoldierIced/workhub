import { useEffect, useState } from 'react'
import type { Profile } from '@workhub/core'
import { isNewMilestone, type PlanItemRef, type PlanItemTarget } from '@shared/plan-item-window'
import { Spinner, TooltipProvider } from '../../components/atoms'
import { EmptyState, ToastProvider, useToast } from '../../components/molecules'
import { refreshConfig, useConfig } from '../../configStore'
import { I18nProvider, useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { formToMilestone, milestoneToForm, type MilestoneForm } from '../../lib/planner'
import { usePlatform } from '../../lib/platform'
import { usePlanner } from '../../plannerStore'
import { MilestoneEditor } from './MilestonesTab'
import { PlanItemDetail } from './PlanItemDetail'

/**
 * An inbox item or a milestone in a window of its own (`#plan-item?…`), kept live by the planner
 * store and the config's changes; opened in its edit form with `edit=1`. `new=1` is the form of a
 * new milestone, and the window closes once it is saved.
 */
export function PlanItemWindow(target: PlanItemTarget) {
  const platform = usePlatform()
  return (
    <I18nProvider>
      <TooltipProvider>
        <Frame platform={platform} target={target} />
      </TooltipProvider>
    </I18nProvider>
  )
}

function Frame({ platform, target }: { platform: string; target: PlanItemTarget }) {
  const { t } = useI18n()
  return (
    <ToastProvider label={t('common.notifications')}>
      <div className="flex h-full flex-col bg-bg">
        <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
        <main className="min-h-0 w-full flex-1 overflow-y-auto pb-6">
          <Body target={target} />
        </main>
      </div>
    </ToastProvider>
  )
}

function Body({ target }: { target: PlanItemTarget }) {
  const { t } = useI18n()
  const snap = useConfig()
  useEffect(() => {
    void refreshConfig()
    return window.hub.config.onChanged(() => void refreshConfig())
  }, [])
  const profile = snap?.config.profiles.find((p) => p.id === target.profileId)
  const { view } = usePlanner(profile?.id, Boolean(profile))
  const fresh = isNewMilestone(target)
  const title = fresh ? t('planner.milestone.newTitle') : view && (target.kind === 'inbox' ? view.inbox.find((i) => i.id === target.id)?.title : view.milestones.find((r) => r.milestone.id === target.id)?.milestone.name)
  useEffect(() => {
    document.title = title || t('nav.plan')
  }, [title, t])
  if (!snap)
    return (
      <p className="flex items-center gap-2 px-4 py-10 text-sm text-muted" role="status">
        <Spinner /> {t('plan.loading')}
      </p>
    )
  if (!profile) return <EmptyState compact title={t('planner.detail.missing')} description={t('planner.detail.noProfile')} />
  return fresh ? <NewMilestone profile={profile} /> : <Item profile={profile} target={target} />
}

/** An existing item; the pencil on the Milestones tab, while this window is open, opens its form here. */
function Item({ profile, target }: { profile: Profile; target: PlanItemRef }) {
  const [editRequest, setEditRequest] = useState(target.edit ? 1 : 0)
  useEffect(() => window.hub.planner.onEditRequest(() => setEditRequest((n) => n + 1)), [])
  return <PlanItemDetail profile={profile} kind={target.kind} id={target.id} editRequest={editRequest} />
}

/** "Add milestone": the milestone form; saving creates it and closes the window, Cancel (or Esc) closes it. */
function NewMilestone({ profile }: { profile: Profile }) {
  const { t } = useI18n()
  const toast = useToast()
  const snap = useConfig()
  const { view } = usePlanner(profile.id, true)
  const [initial, setInitial] = useState<MilestoneForm | null>(null)
  // The form starts once today's date is known (the milestone runs from today by default).
  useEffect(() => {
    if (view && !initial) setInitial(milestoneToForm(undefined, view.today))
  }, [view, initial])
  if (!view || !initial)
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted" role="status">
        <Spinner /> {t('plan.loading')}
      </p>
    )
  const trackers = (snap?.config.connections ?? []).filter((c) => c.kind === 'tracker')
  const save = async (form: MilestoneForm, id: string) => {
    try {
      const r = await window.hub.planner.saveMilestone(profile.id, formToMilestone(form, id))
      if (!r.ok) {
        toast(r.error, 'danger')
        return false
      }
      window.close()
      return true
    } catch (e) {
      toast(errorText(e), 'danger')
      return false
    }
  }
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="milestone-new">
      <h1 className="text-lg font-semibold">{t('planner.milestone.newTitle')}</h1>
      <MilestoneEditor profileId={profile.id} inbox={view.inbox} initial={initial} takenIds={view.milestones.map((r) => r.milestone.id)} trackers={trackers} canSearch={view.tracker.search} onSave={save} onCancel={() => window.close()} />
    </div>
  )
}
