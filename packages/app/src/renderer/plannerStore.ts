import { useEffect, useSyncExternalStore } from 'react'
import type { PlannerView } from '@shared/planner-api'
import { useConfig } from './configStore'
import { errorText } from './lib/errorText'

/** Each profile's milestones and inbox, shared by Home, the top bar and the Plan screen. Main keeps them; this asks and listens. */
export interface ProfilePlanner {
  view: PlannerView | null
  loading: boolean
  error?: string
}

const EMPTY: ProfilePlanner = { view: null, loading: false }
let state: Record<string, ProfilePlanner> = {}
const listeners = new Set<() => void>()
let subscribed = false

function set(profileId: string, patch: Partial<ProfilePlanner>): void {
  state = { ...state, [profileId]: { ...(state[profileId] ?? EMPTY), ...patch } }
  for (const l of listeners) l()
}

/** The newest request per profile: an older reply that arrives late is dropped, and `loading` stays on until the newest settles. */
const newest = new Map<string, number>()
let requests = 0

async function track(profileId: string, op: () => Promise<PlannerView>): Promise<void> {
  const request = ++requests
  newest.set(profileId, request)
  set(profileId, { loading: true })
  try {
    const view = await op()
    if (newest.get(profileId) === request) set(profileId, { view, loading: false, error: undefined })
  } catch (error) {
    if (newest.get(profileId) === request) set(profileId, { loading: false, error: errorText(error) })
  }
}

export const loadPlanner = (profileId: string) => track(profileId, () => window.hub.planner.get(profileId))

/** A profile's planner as stored now, outside React (tests). */
export const plannerOf = (profileId: string): ProfilePlanner => state[profileId] ?? EMPTY

function listen(): void {
  if (subscribed) return
  subscribed = true
  window.hub.planner.onChanged((profileId) => {
    if (state[profileId]) void loadPlanner(profileId)
  })
}

/** Statuses depend on the day: read again now and then while shown. */
const POLL_MS = 10 * 60_000

/** A profile's milestones and inbox while `enabled`, read again after a config change (settings) and on main's pushes. */
export function usePlanner(profileId: string | null | undefined, enabled: boolean): ProfilePlanner & { refresh: () => Promise<void>; reload: () => Promise<void> } {
  const snap = useConfig()
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => (profileId ? (state[profileId] ?? EMPTY) : EMPTY)
  )
  useEffect(() => {
    if (!enabled || !profileId) return
    listen()
    void loadPlanner(profileId)
    const timer = setInterval(() => {
      if (!document.hidden) void loadPlanner(profileId)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, profileId, snap?.config])
  return {
    ...current,
    refresh: () => (profileId ? track(profileId, () => window.hub.planner.refreshMilestones(profileId)) : Promise.resolve()),
    reload: () => (profileId ? loadPlanner(profileId) : Promise.resolve())
  }
}

/** A Plan tab another screen asked for (Home's cards), taken by the Plan screen when it shows. */
let pendingTab: string | null = null
const tabListeners = new Set<(tab: string) => void>()

export function requestPlanTab(tab: string): void {
  pendingTab = tab
  for (const l of tabListeners) l(tab)
}

/** Calls `onTab` with a requested tab now (if one is waiting) and on later requests. */
export function usePlanTabRequests(onTab: (tab: string) => void): void {
  useEffect(() => {
    const take = (tab: string) => {
      pendingTab = null
      onTab(tab)
    }
    if (pendingTab) take(pendingTab)
    tabListeners.add(take)
    return () => void tabListeners.delete(take)
  }, [onTab])
}
