import { useEffect, useMemo } from 'react'
import { inboxSettings, plannerSettings, type CriticalityLevel, type Profile } from '@workhub/core'
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
