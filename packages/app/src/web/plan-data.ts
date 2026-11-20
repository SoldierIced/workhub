import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { inboxSettings, plannerSettings, type CriticalityLevel, type MilestoneOpenTickets, type Profile } from '@workhub/core'
import type { ConfigSnapshot } from '../shared/api'
import type { PlanView } from '../shared/plan-api'
import type { PlannerView } from '../shared/planner-api'
import { safeHref } from '../renderer/components/molecules/Markdown'
import { useClient, useRemoteData } from './app-context'

/** The profile's inbox and milestones (`planner:get`), cached offline and reloaded when the desktop says they changed. */
export function usePlanner(profileId: string | null) {
  const client = useClient()
  const data = useRemoteData<PlannerView | null>('planner:get', [profileId], () => (profileId ? window.hub.planner.get(profileId) : Promise.resolve(null)), [profileId])
  useEffect(() => client.transport.subscribe<[string]>('planner:changed', (id) => id === profileId && data.reload()), [client, profileId, data.reload])
  return data
}

/**
 * The open tickets of one milestone (`planner:openTickets`), asked from the computer when the list is opened and never kept: the planner view leaves them out. `state` is `loading` until the computer answered, `failed` when it could not. `view` is the planner view the milestone belongs to: when it changes (the computer counted again) the list is asked again, and the one shown stays until the answer comes.
 */
export type OpenTicketsAsk = { state: 'loading' } | { state: 'failed' } | { state: 'done'; open: MilestoneOpenTickets | null }
export function useMilestoneOpenTickets(profileId: string | null, milestoneId: string, view: unknown): { ask: OpenTicketsAsk; reload: () => void } {
  const [ask, setAsk] = useState<OpenTicketsAsk>({ state: 'loading' })
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  const shownFor = useRef('')
  useEffect(() => {
    if (!profileId) return
    let cancelled = false
    const of = `${profileId}\0${milestoneId}`
    // Another milestone, or a retry after a failure, starts from "loading"; a new view of the same one keeps the list on screen.
    setAsk((prev) => (prev.state === 'done' && shownFor.current === of ? prev : { state: 'loading' }))
    window.hub.planner.openTickets(profileId, milestoneId).then(
      (open) => {
        if (cancelled) return
        shownFor.current = of
        setAsk({ state: 'done', open })
      },
      () => !cancelled && setAsk({ state: 'failed' })
    )
    return () => {
      cancelled = true
    }
  }, [profileId, milestoneId, view, tick])
  return { ask, reload }
}

/** The profile's agenda (`plan:get`), cached offline and reloaded when the calendars were read again. */
export function usePlan(profileId: string | null) {
  const client = useClient()
  const data = useRemoteData<PlanView | null>('plan:get', [profileId], () => (profileId ? window.hub.plan.get(profileId) : Promise.resolve(null)), [profileId])
  useEffect(() => client.transport.subscribe<[string]>('plan:changed', (id) => id === profileId && data.reload()), [client, profileId, data.reload])
  return data
}

export function profileOf(config: ConfigSnapshot | null, profileId: string | null): Profile | undefined {
  return config?.config.profiles.find((p) => p.id === profileId)
}

/** The profile's criticality levels (Settings → Plan → Inbox): what "urgent" means in the task lists. */
export function useCriticalities(profile: Profile | undefined): CriticalityLevel[] {
  return useMemo(() => inboxSettings(plannerSettings(profile)).criticalities, [profile])
}

/** Opens a link in the phone's browser (never through the desktop). */
export function openLink(url: string): void {
  const href = safeHref(url)
  if (href) window.open(href, '_blank', 'noopener')
}

/** "Aug 26 – Nov 15" for two `YYYY-MM-DD` days: the year only when a day is not in the current year. The caller keeps it on one line. */
export function shortDateRange(start: string, end: string, formatDate: (date: Date, options?: Intl.DateTimeFormatOptions) => string, template: string, now: Date = new Date()): string {
  const day = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return y && m && d ? new Date(y, m - 1, d) : null
  }
  const a = day(start)
  const b = day(end)
  if (!a || !b) return template.replace('{start}', start).replace('{end}', end)
  const withYear = a.getFullYear() !== now.getFullYear() || b.getFullYear() !== now.getFullYear()
  const options: Intl.DateTimeFormatOptions = withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }
  return template.replace('{start}', formatDate(a, options)).replace('{end}', formatDate(b, options))
}
