import { useEffect, useSyncExternalStore } from 'react'
import type { Ticket } from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import type { TicketsStatus } from '@shared/tickets-api'
import { useConfig } from './configStore'
import { errorText } from './lib/errorText'

/** The tickets of each profile, shared by Home and the Tickets screen, refreshed every five minutes (Workhub 1's loop). */
export interface ProfileTickets {
  status?: TicketsStatus
  tickets: Ticket[]
  loading: boolean
  /** Why the last load failed, when it did. */
  error?: string
  /** Epoch milliseconds of the last successful load. */
  fetchedAt?: number
}

const REFRESH_MS = 300_000
const EMPTY: ProfileTickets = { tickets: [], loading: false }

let state: Record<string, ProfileTickets> = {}
const listeners = new Set<() => void>()
const inFlight = new Map<string, Promise<void>>()
let timer: ReturnType<typeof setInterval> | undefined
let subscribed = false

function set(profileId: string, patch: Partial<ProfileTickets>): void {
  state = { ...state, [profileId]: { ...(state[profileId] ?? EMPTY), ...patch } }
  for (const l of listeners) l()
}

/** Loads the status and, when a tracker serves the profile, its tickets. Concurrent calls share one load. */
export function loadTickets(profileId: string): Promise<void> {
  const running = inFlight.get(profileId)
  if (running) return running
  const run = (async () => {
    set(profileId, { loading: true })
    try {
      const status = await window.hub.tickets.status(profileId)
      if (status.state !== 'ready' && status.state !== 'demo') {
        set(profileId, { status, tickets: [], loading: false, error: undefined })
        return
      }
      const result = await window.hub.tickets.list(profileId)
      if (result.ok) set(profileId, { status, tickets: result.value, loading: false, error: undefined, fetchedAt: Date.now() })
      else set(profileId, { status, loading: false, error: result.error })
    } catch (error) {
      set(profileId, { loading: false, error: errorText(error) })
    }
  })().finally(() => inFlight.delete(profileId))
  inFlight.set(profileId, run)
  return run
}

function start(): void {
  if (subscribed) return
  subscribed = true
  window.hub.tickets.onChanged(() => Object.keys(state).forEach((id) => void loadTickets(id)))
  timer = setInterval(() => {
    if (!document.hidden) Object.keys(state).forEach((id) => void loadTickets(id))
  }, REFRESH_MS)
}

/** Stops the polling (tests). */
export function stopTicketsPolling(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  subscribed = false
}

/**
 * What the tickets of a profile depend on in the config: the profile and the connections (and
 * which of them have a token). Anything else (a sidebar group folded, an option) changes nothing.
 */
export function ticketsConfigKey(snap: ConfigSnapshot | null, profileId: string | undefined): string {
  if (!snap || !profileId) return ''
  const profile = snap.config.profiles.find((p) => p.id === profileId)
  return JSON.stringify([profile ?? null, snap.config.connections, snap.connectionsWithSecret])
}

/**
 * The tickets of a profile. They load when the profile first appears and again whenever its
 * tracker settings change (a tracker was saved or the profile switched its connection); not on
 * every config refresh, each of which would ask the tracker again.
 */
export function useTickets(profileId: string | undefined): ProfileTickets & { refresh: () => Promise<void> } {
  const snap = useConfig()
  const configKey = ticketsConfigKey(snap, profileId)
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => (profileId ? (state[profileId] ?? EMPTY) : EMPTY)
  )
  useEffect(() => {
    start()
    if (profileId) void loadTickets(profileId)
  }, [profileId, configKey])
  return { ...current, refresh: () => (profileId ? loadTickets(profileId) : Promise.resolve()) }
}
