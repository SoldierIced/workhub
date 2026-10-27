import { useEffect, useSyncExternalStore } from 'react'
import type { HealthView } from '@shared/health-api'
import { useConfig } from './configStore'

/** The Health read of each profile, shared by Home and the Health screen. The main process decides when to read the cluster again; this only asks. */
export interface ProfileHealth {
  view: HealthView | null
  loading: boolean
  error?: string
}

const EMPTY: ProfileHealth = { view: null, loading: false }
let state: Record<string, ProfileHealth> = {}
const listeners = new Set<() => void>()
const inFlight = new Map<string, Promise<void>>()
const keyOf = (profileId: string | null | undefined) => profileId ?? ''

function set(key: string, patch: Partial<ProfileHealth>): void {
  state = { ...state, [key]: { ...(state[key] ?? EMPTY), ...patch } }
  for (const l of listeners) l()
}

export function loadHealth(profileId: string | null, force = false): Promise<void> {
  const key = keyOf(profileId)
  const running = inFlight.get(key)
  if (running) return running
  const run = (async () => {
    set(key, { loading: true })
    try {
      set(key, { view: await window.hub.health.get(profileId, force), loading: false, error: undefined })
    } catch (error) {
      set(key, { loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

/** Asking is cheap: the main process answers from its cache until the profile's interval has passed. */
const POLL_MS = 60_000

/**
 * The Health read of a profile. It is asked for on mount and every minute while `enabled`; the
 * main process only reads the cluster again once the profile's refresh interval has passed.
 */
export function useHealth(profileId: string | null | undefined, enabled: boolean): ProfileHealth & { refresh: () => Promise<void> } {
  const snap = useConfig()
  const key = keyOf(profileId)
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state[key] ?? EMPTY
  )
  useEffect(() => {
    if (!enabled || !profileId) return
    void loadHealth(profileId)
    const timer = setInterval(() => {
      if (!document.hidden) void loadHealth(profileId)
    }, POLL_MS)
    return () => clearInterval(timer)
    // A saved Settings change (connection, environments) must show at once.
  }, [enabled, profileId, snap?.config])
  return { ...current, refresh: () => loadHealth(profileId ?? null, true) }
}
