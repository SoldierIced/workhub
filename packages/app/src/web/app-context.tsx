// What every phone screen reaches for: the remote client and its status, the route, the config of
// the desktop and the profile the person is looking at.
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConfigSnapshot } from '../shared/api'
import type { RemoteDevicePlatform } from '../shared/remote-api'
import type { ClientStatus, RemoteClient } from './remote-client'
import { parseRoute, routeHash, type Route } from './routes'

export interface WebApp {
  client: RemoteClient
  platform: RemoteDevicePlatform
}

const Ctx = createContext<WebApp | null>(null)

export function WebAppProvider({ value, children }: { value: WebApp; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWebApp(): WebApp {
  const value = useContext(Ctx)
  if (!value) throw new Error('WebAppProvider is missing')
  return value
}

export function useClient(): RemoteClient {
  return useWebApp().client
}

// One snapshot per change, so useSyncExternalStore sees a stable reference between changes.
const snapshots = new WeakMap<RemoteClient, ClientStatus>()
function snapshotOf(client: RemoteClient): ClientStatus {
  let s = snapshots.get(client)
  if (!s) {
    s = client.status()
    snapshots.set(client, s)
  }
  return s
}

export function useClientStatus(): ClientStatus {
  const client = useClient()
  return useSyncExternalStore(
    (notify) =>
      client.onStatus((status) => {
        snapshots.set(client, status)
        notify()
      }),
    () => snapshotOf(client)
  )
}

// ---- Routing by hash

const routeListeners = new Set<() => void>()
let currentRoute: Route = typeof location === 'undefined' ? { screen: 'home' } : parseRoute(location.hash)
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    currentRoute = parseRoute(location.hash)
    for (const l of routeListeners) l()
  })
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      routeListeners.add(l)
      return () => void routeListeners.delete(l)
    },
    () => currentRoute
  )
}

export function navigate(route: Route, replace = false): void {
  const hash = routeHash(route)
  if (replace) history.replaceState(null, '', hash)
  else location.hash = hash
  currentRoute = parseRoute(hash)
  for (const l of routeListeners) l()
}

export function goBack(fallback: Route = { screen: 'home' }): void {
  if (history.length > 1) history.back()
  else navigate(fallback)
}

// ---- The desktop's config (profiles, agents), refreshed when the desktop says it changed

export function useConfig(): { config: ConfigSnapshot | null; error: string | null; reload: () => void } {
  const client = useClient()
  const status = useClientStatus()
  const [config, setConfig] = useState<ConfigSnapshot | null>(() => client.cached<ConfigSnapshot>('config:get'))
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    window.hub.config
      .get()
      .then((c) => {
        setConfig(c)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])
  useEffect(() => {
    if (status.state === 'online') reload()
  }, [status.state, reload])
  useEffect(() => window.hub.config.onChanged(reload), [reload])
  return { config, error, reload }
}

const PROFILE_KEY = 'workhub-remote-profile'
const profileListeners = new Set<() => void>()

/** The profile the phone looks at: the one picked here, else the desktop's active profile. */
export function useProfileId(config: ConfigSnapshot | null): [string | null, (id: string | null) => void] {
  const picked = useSyncExternalStore(
    (l) => {
      profileListeners.add(l)
      return () => void profileListeners.delete(l)
    },
    () => localStorage.getItem(PROFILE_KEY)
  )
  const profiles = config?.config.profiles ?? []
  const valid = picked && profiles.some((p) => p.id === picked) ? picked : (config?.config.activeProfileId ?? profiles[0]?.id ?? null)
  const set = useCallback((id: string | null) => {
    if (id) localStorage.setItem(PROFILE_KEY, id)
    else localStorage.removeItem(PROFILE_KEY)
    for (const l of profileListeners) l()
  }, [])
  return [valid, set]
}

/** Runs `load` when the desktop is reachable and whenever `deps` change; keeps the last answer (or the cached one) meanwhile. */
export function useRemoteData<T>(cacheChannel: string | null, cacheArgs: unknown[], load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const client = useClient()
  const status = useClientStatus()
  const [data, setData] = useState<T | null>(() => (cacheChannel ? client.cached<T>(cacheChannel, cacheArgs) : null))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    if (cacheChannel) setData(client.cached<T>(cacheChannel, cacheArgs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    if (status.state !== 'online') return
    let cancelled = false
    setLoading(true)
    load().then(
      (value) => {
        if (cancelled) return
        setData(value)
        setError(null)
        setLoading(false)
      },
      (err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state, tick, ...deps])
  return { data, error, loading, reload }
}
