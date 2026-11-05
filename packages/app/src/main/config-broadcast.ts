import type { ConfigStore } from '@workhub/core'

/**
 * The config store, telling every window once a write lands (`config:changed`), so a change made in
 * one window (Settings in its own window, a setup window, the main window) shows in the others.
 * Writes made together are told once.
 */
export function broadcastingConfigStore(store: ConfigStore, changed: () => void, delayMs = 0): ConfigStore {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    load: () => store.load(),
    async save(config) {
      await store.save(config)
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        changed()
      }, delayMs)
    }
  }
}
