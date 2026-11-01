import { useEffect, useSyncExternalStore } from 'react'
import type { MetricAlertAction } from '@workhub/core'
import type { MetricAlertsView } from '@shared/metric-alerts-api'
import { errorText } from './lib/errorText'

/** The metric alerts of each profile, shared by Home and the Health screen. The main process evaluates; this only asks and listens. */
export interface ProfileMetricAlerts {
  view: MetricAlertsView | null
  loading: boolean
  error?: string
}

const EMPTY: ProfileMetricAlerts = { view: null, loading: false }
let state: Record<string, ProfileMetricAlerts> = {}
const listeners = new Set<() => void>()
let subscribed = false
/** A clicked notification's profile, until the Health screen takes it (it may mount after the click arrives). */
let pendingOpen: string | null = null
const openListeners = new Set<(profileId: string) => void>()

function set(profileId: string, patch: Partial<ProfileMetricAlerts>): void {
  state = { ...state, [profileId]: { ...(state[profileId] ?? EMPTY), ...patch } }
  for (const l of listeners) l()
}

async function track(profileId: string, op: () => Promise<MetricAlertsView>): Promise<void> {
  set(profileId, { loading: true })
  try {
    set(profileId, { view: await op(), loading: false, error: undefined })
  } catch (error) {
    set(profileId, { loading: false, error: errorText(error) })
  }
}

export const loadMetricAlerts = (profileId: string) => track(profileId, () => window.hub.metricAlerts.list(profileId))

/** Main says a profile's alerts changed: read them again if anything shows them. */
function listen(): void {
  if (subscribed) return
  subscribed = true
  window.hub.metricAlerts.onChanged((profileId) => {
    if (state[profileId]) void loadMetricAlerts(profileId)
  })
  window.hub.metricAlerts.onOpen((profileId) => {
    pendingOpen = profileId
    for (const l of openListeners) l(profileId)
  })
}

/** Asks the Health screen to show its Alerts tab for a profile (Home's alerts card), now or when it mounts. */
export function requestAlertsTab(profileId: string): void {
  pendingOpen = profileId
  for (const l of openListeners) l(profileId)
}

// Listen from the start: a notification can be clicked before any screen asked for alerts.
if (typeof window !== 'undefined' && window.hub?.metricAlerts) listen()

/** The alerts of a profile, with Refresh (evaluate now) and the per-alert actions. */
export function useMetricAlerts(profileId: string | null | undefined): ProfileMetricAlerts & { refresh: () => Promise<void>; act: (key: string, action: MetricAlertAction) => Promise<void> } {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => (profileId ? (state[profileId] ?? EMPTY) : EMPTY)
  )
  useEffect(() => {
    if (!profileId) return
    listen()
    void loadMetricAlerts(profileId)
  }, [profileId])
  return {
    ...current,
    refresh: () => (profileId ? track(profileId, () => window.hub.metricAlerts.refresh(profileId)) : Promise.resolve()),
    act: (key, action) => (profileId ? track(profileId, () => window.hub.metricAlerts.setStatus(profileId, key, action)) : Promise.resolve())
  }
}

/** Calls `onOpen` when a metric alert notification for this profile is clicked. */
export function useMetricAlertsOpen(profileId: string | null | undefined, onOpen: () => void): void {
  useEffect(() => {
    if (!profileId) return
    const take = (id: string) => {
      if (id !== profileId) return
      pendingOpen = null
      onOpen()
    }
    if (pendingOpen) take(pendingOpen)
    openListeners.add(take)
    return () => void openListeners.delete(take)
  }, [profileId, onOpen])
}
