import { useSyncExternalStore } from 'react'
import type { ConfigSnapshot } from '@shared/api'

/** The config snapshot every screen reads; Settings and the profile switcher refresh it after a change. */
let snapshot: ConfigSnapshot | null = null
const listeners = new Set<() => void>()

export async function refreshConfig(): Promise<ConfigSnapshot> {
  snapshot = await window.hub.config.get()
  for (const l of listeners) l()
  return snapshot
}

export function useConfig(): ConfigSnapshot | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => snapshot
  )
}
