import type { TicketDetail } from '@workhub/core'
import type { TicketsResult } from '@shared/tickets-api'

/** What a ticket chip's hover card shows. */
export type TicketPreview = { state: 'ready'; detail: TicketDetail } | { state: 'missing' } | { state: 'error'; message: string }

type Fetch = (profileId: string, key: string) => Promise<TicketsResult<TicketDetail | null>>

/** Previews are kept this long; hovering again later reads the ticket again. */
export const PREVIEW_TTL_MS = 120_000

/**
 * Ticket previews for the hover cards, read on demand: one read per ticket at a time, kept for
 * a couple of minutes so moving the pointer across chips does not hit the tracker each time.
 * Failures are not kept, so the next hover tries again.
 */
export function createTicketPreviews(fetch: Fetch, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; preview: TicketPreview }>()
  const inFlight = new Map<string, Promise<TicketPreview>>()
  const id = (profileId: string, key: string) => `${profileId}\n${key.toUpperCase()}`
  return {
    /** The preview already read, while it is fresh. */
    peek(profileId: string, key: string): TicketPreview | undefined {
      const hit = cache.get(id(profileId, key))
      return hit && now() - hit.at < PREVIEW_TTL_MS ? hit.preview : undefined
    },
    load(profileId: string, key: string): Promise<TicketPreview> {
      const k = id(profileId, key)
      const fresh = this.peek(profileId, key)
      if (fresh) return Promise.resolve(fresh)
      const running = inFlight.get(k)
      if (running) return running
      const run = fetch(profileId, key)
        .then((r): TicketPreview => (!r.ok ? { state: 'error', message: r.error } : r.value ? { state: 'ready', detail: r.value } : { state: 'missing' }))
        .catch((e: unknown): TicketPreview => ({ state: 'error', message: e instanceof Error ? e.message : String(e) }))
        .then((preview) => {
          if (preview.state !== 'error') cache.set(k, { at: now(), preview })
          return preview
        })
        .finally(() => inFlight.delete(k))
      inFlight.set(k, run)
      return run
    }
  }
}

let shared: ReturnType<typeof createTicketPreviews> | undefined

/** The app's previews, read through the tickets bridge. */
export function ticketPreviews(): ReturnType<typeof createTicketPreviews> {
  shared ??= createTicketPreviews((profileId, key) => window.hub.tickets.get(profileId, key))
  return shared
}
