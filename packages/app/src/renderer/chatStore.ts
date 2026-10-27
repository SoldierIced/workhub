import { useEffect, useSyncExternalStore } from 'react'
import type { AutomationsSnapshot, SlackSnapshot } from '@shared/chat-api'

/** The Slack watcher's and the automations' snapshots, pushed by the main process. */
function liveSnapshot<T>(load: () => Promise<T>, subscribe: (cb: (s: T) => void) => () => void) {
  let value: T | null = null
  let started = false
  const listeners = new Set<() => void>()
  const set = (next: T) => {
    value = next
    for (const l of listeners) l()
  }
  const start = () => {
    if (started) return
    started = true
    subscribe(set)
    void load().then(set, () => undefined)
  }
  return {
    reload: () => load().then(set, () => undefined),
    use(): T | null {
      useEffect(start, [])
      return useSyncExternalStore(
        (l) => {
          listeners.add(l)
          return () => listeners.delete(l)
        },
        () => value
      )
    }
  }
}

const slack = liveSnapshot<SlackSnapshot>(
  () => window.hub.slack.get(),
  (cb) => window.hub.slack.onChanged(cb)
)
const automations = liveSnapshot<AutomationsSnapshot>(
  () => window.hub.automations.get(),
  (cb) => window.hub.automations.onChanged(cb)
)

export const useSlack = () => slack.use()
export const reloadSlack = () => slack.reload()
export const useAutomations = () => automations.use()
export const reloadAutomations = () => automations.reload()
