import { useEffect, useSyncExternalStore } from 'react'
import type { PlanView } from '@shared/plan-api'
import { useConfig } from './configStore'
import { errorText } from './lib/errorText'

/** The agenda of each profile, shared by Home and the Plan screen. Main decides when to read the calendars again; this asks, and listens for its pushes. */
export interface ProfilePlan {
  view: PlanView | null
  loading: boolean
  error?: string
}

const EMPTY: ProfilePlan = { view: null, loading: false }
let state: Record<string, ProfilePlan> = {}
const listeners = new Set<() => void>()
const inFlight = new Map<string, Promise<void>>()
let pushes: (() => void) | null = null

function set(key: string, patch: Partial<ProfilePlan>): void {
  state = { ...state, [key]: { ...(state[key] ?? EMPTY), ...patch } }
  for (const l of listeners) l()
}

export function loadPlan(profileId: string, force = false): Promise<void> {
  const running = inFlight.get(profileId)
  if (running && !force) return running
  const run = (async () => {
    set(profileId, { loading: true })
    try {
      set(profileId, { view: await window.hub.plan.get(profileId, force), loading: false, error: undefined })
    } catch (error) {
      set(profileId, { loading: false, error: errorText(error) })
    }
  })().finally(() => inFlight.delete(profileId))
  inFlight.set(profileId, run)
  return run
}

/** A brief started or a session moved on: main says which profile changed; a shown profile reads again. */
function listen(): void {
  if (pushes) return
  pushes = window.hub.plan.onChanged((profileId) => {
    if (state[profileId]) void loadPlan(profileId)
  })
}

/** Asking is cheap: main answers from its cache until the profile's refresh interval passed. Also keeps "in 5 min" fresh. */
const POLL_MS = 60_000

/** The agenda of a profile, asked for on mount, every minute while `enabled`, after a config change and on main's pushes. */
export function usePlan(profileId: string | null | undefined, enabled: boolean): ProfilePlan & { refresh: () => Promise<void> } {
  const snap = useConfig()
  const key = profileId ?? ''
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state[key] ?? EMPTY
  )
  useEffect(() => {
    if (!enabled || !profileId) return
    listen()
    void loadPlan(profileId)
    const timer = setInterval(() => {
      if (!document.hidden) void loadPlan(profileId)
    }, POLL_MS)
    return () => clearInterval(timer)
    // A saved Settings change (calendars, rules, people) must show at once.
  }, [enabled, profileId, snap?.config])
  return { ...current, refresh: () => (profileId ? loadPlan(profileId, true) : Promise.resolve()) }
}
