// Types of the pull request events bridge (window.hub.prEvents), shared by main, preload and renderer.
import type { PrEvent } from '@workhub/core'

/** Events a sync found for one profile, already deduplicated: each one arrives once. */
export interface PrEventBatch {
  profileId: string
  events: PrEvent[]
}

/** What the renderer asks main to show: the text is localized in the renderer. */
export interface PrNotification {
  profileId: string
  url: string
  title: string
  body: string
}

export interface PrEventsApi {
  /** Tells main the renderer listens, so events found before that are delivered. */
  ready(): void
  onEvents(cb: (batch: PrEventBatch) => void): () => void
  /** Shows an OS notification; clicking it opens the pull request window. */
  notify(n: PrNotification): void
  /** Demo mode only (WORKHUB_DEMO_CODEHOST): moves the demo one step on and syncs now. Resolves to the new step, or null outside the demo. */
  demoAdvance(): Promise<number | null>
}
